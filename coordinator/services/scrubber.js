/**
 * Background Data Scrubber & Silent Bit-Rot Repair Engine
 *
 * Scans disk replicas across all nodes, compares their computed SHA-256
 * against the cryptographic checksum in FileMetadata, and automatically
 * restores corrupted blocks from healthy peer replicas.
 */

const config = require('../config');
const { FileMetadata } = require('../models');
const { logEvent } = require('./auditService');

/**
 * Run a full scrubbing cycle across all files, or target a specific file if fileId is provided.
 */
async function runScrub(fileId = null) {
  let files;
  if (fileId) {
    files = await FileMetadata.find({ fileId });
    if (!files || files.length === 0) {
      files = await FileMetadata.find({ _id: fileId });
    }
  } else {
    files = await FileMetadata.find({});
  }
  files = files || [];
  let totalChecked = 0;
  let corruptionsDetected = 0;
  let repairsSucceeded = 0;
  const anomalies = [];

  for (const file of files) {
    const distribution = file.distribution || [];
    let healthyNodeId = null;
    let healthyBuffer = null;

    // Phase 1: Verify all replicas
    const replicaChecks = [];
    for (const dist of distribution) {
      const node = config.nodes.find(n => n.id === dist.nodeId);
      if (!node) continue;
      totalChecked++;

      try {
        const res = await fetch(`${node.url}/checksum/${file.fileId}`, {
          headers: { 'x-internal-secret': config.internalSecret },
        });
        if (!res.ok) continue;
        const data = await res.json();

        if (data.checksum === file.checksum) {
          healthyNodeId = node.id;
          replicaChecks.push({ nodeId: node.id, status: 'healthy' });
        } else {
          corruptionsDetected++;
          anomalies.push({
            fileId: file.fileId,
            fileName: file.originalName,
            nodeId: node.id,
            expectedHash: file.checksum,
            actualHash: data.checksum,
          });
          replicaChecks.push({ nodeId: node.id, status: 'corrupted' });
        }
      } catch (_) {
        // Node might be offline; handled by repair scheduler
      }
    }

    // Phase 2: Self-repair any corrupted replica using peer data
    const corruptedReplicas = replicaChecks.filter(r => r.status === 'corrupted');
    if (corruptedReplicas.length > 0 && healthyNodeId) {
      try {
        const healthyNode = config.nodes.find(n => n.id === healthyNodeId);
        const fetchRes = await fetch(`${healthyNode.url}/retrieve/${file.fileId}`, {
          headers: { 'x-internal-secret': config.internalSecret },
        });
        if (!fetchRes.ok) continue;
        healthyBuffer = Buffer.from(await fetchRes.arrayBuffer());

        for (const bad of corruptedReplicas) {
          const badNode = config.nodes.find(n => n.id === bad.nodeId);
          const repairRes = await fetch(`${badNode.url}/store`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'x-file-id': file.fileId,
              'x-internal-secret': config.internalSecret,
            },
            body: healthyBuffer,
          });

          if (repairRes.ok) {
            repairsSucceeded++;
            await logEvent({
              userId: 'system',
              action: 'scrubber_repair',
              resource: file.originalName,
              status: 'success',
              meta: {
                fileId: file.fileId,
                corruptedNode: bad.nodeId,
                donorNode: healthyNodeId,
                verifiedHash: file.checksum,
              },
            });
          }
        }
      } catch (err) {
        console.error('[Scrubber] Repair error:', err.message);
      }
    }
  }

  return {
    timestamp: new Date().toISOString(),
    totalChecked,
    corruptionsDetected,
    repairsSucceeded,
    anomalies,
  };
}

module.exports = { runScrub };
