/**
 * Self-Healing Replication Service
 *
 * When a storage node comes back online after a failure, files that
 * should have been replicated to it (but weren't, due to the outage)
 * are automatically re-replicated from a healthy peer.
 *
 * This implements the "self-healing cluster" concept used by HDFS, Ceph, etc.
 *
 * Triggered from: healthCheck.js whenever a node transitions offline → online.
 */

const { FileMetadata } = require('../models');
const { getNodeHealth } = require('./healthCheck');
const config = require('../config');

const headers = { 'x-internal-secret': config.internalSecret };

/**
 * Re-replicate all files that should be on `revivedNodeId` but aren't.
 * We check the distribution map — if a file lists revivedNodeId as replica
 * but we detect the node was offline when upload happened, the file won't
 * be there. We verify by HEAD-checking the node.
 *
 * Strategy:
 *  1. Scan ALL files in DB
 *  2. For each file NOT listed in any distribution (underpopulated), 
 *     copy it from a healthy node to the revived node and update DB.
 *  3. For each file listed on revivedNodeId, verify it actually exists there.
 *     If not, fetch from another node and push a copy.
 */
async function selfHeal(revivedNodeId) {
  console.log(`[SelfHeal] Starting self-healing and block-report reconciliation for ${revivedNodeId}...`);

  const revivedHealth = getNodeHealth(revivedNodeId);
  if (!revivedHealth || revivedHealth.status !== 'online') {
    console.warn(`[SelfHeal] ${revivedNodeId} not online yet, aborting.`);
    return;
  }

  let healed = 0;
  let checked = 0;
  let presentBlockIds = new Set();

  try {
    // 1. Fetch block report from the revived node
    try {
      const brRes = await fetch(`${revivedHealth.url}/blockreport`, { headers });
      if (brRes.ok) {
        const brData = await brRes.json();
        if (Array.isArray(brData.blocks)) {
          presentBlockIds = new Set(brData.blocks.map(b => b.fileId));
        }
      }
    } catch (brErr) {
      console.warn(`[SelfHeal] Could not fetch blockreport from ${revivedNodeId}: ${brErr.message}`);
    }

    // 2. Scan all files in DB
    const allFiles = await FileMetadata.find({});
    checked = allFiles.length;
    const targetReplicas = config.replicationFactor || 3;

    for (const file of allFiles) {
      // Deduplicate existing distribution by nodeId to guard against duplicates
      const seenNodes = new Set();
      const dist = (file.distribution || []).filter(d => {
        if (!d || !d.nodeId || seenNodes.has(d.nodeId)) return false;
        seenNodes.add(d.nodeId);
        return true;
      });
      const holdsFile = seenNodes.has(revivedNodeId);
      const isUnderReplicated = dist.length < targetReplicas;

      // Case A: File is supposed to be on revivedNodeId, but is missing on disk
      if (holdsFile) {
        let isMissing = !presentBlockIds.has(file.fileId);
        if (!isMissing && presentBlockIds.size === 0) {
          // Fallback if blockreport was unavailable: HEAD check
          try {
            const checkRes = await fetch(`${revivedHealth.url}/retrieve/${file.fileId}`, {
              method: 'HEAD',
              headers,
            });
            isMissing = !checkRes.ok;
          } catch {
            isMissing = true;
          }
        }

        if (isMissing) {
          const source = dist.find(d => d.nodeId !== revivedNodeId);
          if (!source) continue;
          const sourceHealth = getNodeHealth(source.nodeId);
          if (!sourceHealth || sourceHealth.status !== 'online') continue;

          try {
            const fetchRes = await fetch(`${sourceHealth.url}/retrieve/${file.fileId}`, { headers });
            if (!fetchRes.ok) continue;
            const buffer = Buffer.from(await fetchRes.arrayBuffer());

            const pushRes = await fetch(`${revivedHealth.url}/store`, {
              method: 'POST',
              headers: {
                ...headers,
                'Content-Type': 'application/octet-stream',
                'x-file-id': file.fileId,
              },
              body: buffer,
            });

            if (pushRes.ok) {
              healed++;
              presentBlockIds.add(file.fileId);
              console.log(`[SelfHeal] Restored missing file ${file.fileId} on ${revivedNodeId}`);
            }
          } catch (err) {
            console.error(`[SelfHeal] Failed to restore ${file.fileId}: ${err.message}`);
          }
        }
      }

      // Case B: File is under-replicated (< targetReplicas) and not currently assigned to revivedNodeId
      // (e.g. uploaded while revivedNodeId was down during chaos tests)
      else if (isUnderReplicated) {
        // Find a healthy online source node
        const source = dist.find(d => {
          const h = getNodeHealth(d.nodeId);
          return h && h.status === 'online';
        });

        if (source) {
          const sourceHealth = getNodeHealth(source.nodeId);
          try {
            // Check if revived node already has bytes or needs copy
            let copyNeeded = !presentBlockIds.has(file.fileId);

            if (copyNeeded) {
              const fetchRes = await fetch(`${sourceHealth.url}/retrieve/${file.fileId}`, { headers });
              if (fetchRes.ok) {
                const buffer = Buffer.from(await fetchRes.arrayBuffer());
                const pushRes = await fetch(`${revivedHealth.url}/store`, {
                  method: 'POST',
                  headers: {
                    ...headers,
                    'Content-Type': 'application/octet-stream',
                    'x-file-id': file.fileId,
                  },
                  body: buffer,
                });
                if (pushRes.ok) {
                  copyNeeded = false;
                  presentBlockIds.add(file.fileId);
                }
              }
            }

            if (!copyNeeded) {
              // Add revivedNodeId to distribution and save in DB
              const updatedDist = [...dist, { nodeId: revivedNodeId, role: 'replica' }];
              await FileMetadata.updateOne({ _id: file._id }, { $set: { distribution: updatedDist } });
              healed++;
              console.log(`[SelfHeal] Repaired under-replicated file ${file.fileId} (${dist.length} -> ${updatedDist.length} replicas) via ${revivedNodeId}`);
            }
          } catch (err) {
            console.error(`[SelfHeal] Failed to re-replicate under-replicated ${file.fileId}: ${err.message}`);
          }
        }
      }
    }

    console.log(`[SelfHeal] Completed. Checked ${checked} files, reconciled/healed ${healed} replicas on ${revivedNodeId}.`);

    // 3. Trigger priority repair scheduler for any remaining degraded files
    try {
      const { scheduleRebalance } = require('./repairScheduler');
      await scheduleRebalance();
    } catch (_) {}

  } catch (err) {
    console.error(`[SelfHeal] Error during self-healing: ${err.message}`);
  }

  return { checked, healed };
}

/**
 * Proactive Re-replication for Under-replicated Files.
 *
 * Triggered when a node goes offline:
 * If a file lost one of its replicas, we proactively copy it from
 * a surviving replica to any available healthy node that doesn't have it yet!
 * This guarantees files never remain at RF=1 even if nodes die one after another.
 */
async function healUnderReplicated() {
  const { getOnlineNodes } = require('./healthCheck');
  const onlineNodes = getOnlineNodes().filter(n => n.role !== 'backup' && n.id !== 'node-backup');
  if (onlineNodes.length < 2) return; // need at least 1 source and 1 destination

  try {
    const allFiles = await FileMetadata.find({});
    for (const file of allFiles) {
      const activeReplicas = file.distribution.filter(d =>
        onlineNodes.some(n => n.id === d.nodeId)
      );

      // If active replicas is below target replicationFactor, push to an available node
      if (activeReplicas.length > 0 && activeReplicas.length < (config.replicationFactor || 3)) {
        const sourceNode = onlineNodes.find(n => n.id === activeReplicas[0].nodeId);
        const targetNode = onlineNodes.find(n => !file.distribution.some(d => d.nodeId === n.id));

        if (sourceNode && targetNode) {
          try {
            const fetchRes = await fetch(`${sourceNode.url}/retrieve/${file.fileId}`, { headers });
            if (!fetchRes.ok) continue;
            const buffer = Buffer.from(await fetchRes.arrayBuffer());

            const pushRes = await fetch(`${targetNode.url}/store`, {
              method: 'POST',
              headers: {
                ...headers,
                'Content-Type': 'application/octet-stream',
                'x-file-id': file.fileId,
              },
              body: buffer,
            });

            if (pushRes.ok) {
              const updatedDist = [...file.distribution, { nodeId: targetNode.id, role: 'replica' }];
              await FileMetadata.updateOne({ _id: file._id }, { $set: { distribution: updatedDist } });
              console.log(`[SelfHeal] 🛡️ Proactively re-replicated ${file.fileId} from ${sourceNode.id} → ${targetNode.id}`);
            }
          } catch (err) {
            console.error(`[SelfHeal] Proactive re-replication error: ${err.message}`);
          }
        }
      }
    }
  } catch (err) {
    console.error(`[SelfHeal] healUnderReplicated failed: ${err.message}`);
  }
}

module.exports = { selfHeal, healUnderReplicated };
