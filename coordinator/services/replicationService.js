/**
 * Handles file replication, fault-tolerant retrieval, distributed deletion,
 * and Smart Storage backup vault operations.
 *
 * Replication: Copies file to replica nodes up to desiredReplicas count.
 * Retrieval:   Picks least-loaded healthy replica first; transparent failover.
 * Deletion:    Best-effort removal from all nodes holding the file.
 * Backup:      Isolated offline storage in backup vault.
 */

const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { selectNode } = require('./loadBalancer');
const { getNodeHealth } = require('./healthCheck');

const headers = { 'x-internal-secret': config.internalSecret };

/**
 * Replicate file to storage nodes.
 * @param {Buffer} fileBuffer
 * @param {string} fileId
 * @param {string} primaryNodeId
 * @param {number} [desiredReplicas] - Total replicas desired (including primary)
 * @param {Array<string>} [excludeNodes] - Additional node IDs to avoid
 */
async function replicateFile(fileBuffer, fileId, primaryNodeId, desiredReplicas = config.replicationFactor || 3, excludeNodes = []) {
  const targetCount = Math.max(0, desiredReplicas - 1);
  const replicaIds = [];
  const excluded = [primaryNodeId, ...excludeNodes];

  for (let i = 0; i < targetCount; i++) {
    const replicaNode = selectNode(excluded);
    if (!replicaNode) break;
    excluded.push(replicaNode.id);

    try {
      const res = await fetch(`${replicaNode.url}/store`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/octet-stream', 'x-file-id': fileId },
        body: fileBuffer,
      });
      if (res.ok) {
        replicaIds.push(replicaNode.id);
      }
    } catch (err) {
      console.error(`[Replication] Failed → ${replicaNode.id}: ${err.message}`);
    }
  }

  return replicaIds;
}

/**
 * Retrieve file stream picking least-loaded healthy replica first, with automatic failover.
 */
async function retrieveFile(fileId, distribution) {
  // Only retrieve from actual storage nodes (not backup-vault)
  const candidates = (distribution || []).filter(d => d.role !== 'backup');

  // Sort candidates by least-loaded disk usage, with primary as tie-breaker
  const ordered = [...candidates].sort((a, b) => {
    const ha = getNodeHealth(a.nodeId);
    const hb = getNodeHealth(b.nodeId);
    const da = ha?.diskUsage?.usedPercent ?? (a.role === 'primary' ? 0 : 50);
    const db = hb?.diskUsage?.usedPercent ?? (b.role === 'primary' ? 0 : 50);
    if (da !== db) return da - db;
    if (a.role === 'primary') return -1;
    if (b.role === 'primary') return 1;
    return 0;
  });

  for (const dist of ordered) {
    const health = getNodeHealth(dist.nodeId);
    if (health?.status !== 'online') continue;

    try {
      const res = await fetch(`${health.url}/retrieve/${fileId}`, { headers });
      if (!res.ok) continue;

      return {
        stream: Readable.fromWeb(res.body),
        servedFrom: dist.nodeId,
        failover: dist.role !== 'primary',
      };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Remove physical block from all holding nodes (excluding backup-vault).
 */
async function deleteFromNodes(fileId, distribution) {
  await Promise.allSettled(
    (distribution || []).map(async (dist) => {
      if (dist.role === 'backup') return;
      const health = getNodeHealth(dist.nodeId);
      if (health?.status !== 'online') return;
      try {
        await fetch(`${health.url}/remove/${fileId}`, { method: 'DELETE', headers });
      } catch (err) {
        console.warn(`[DeleteFromNodes] Failed to delete ${fileId} on ${dist.nodeId}: ${err.message}`);
      }
    })
  );
}

/**
 * Copy file buffer or stream to a specific target node.
 */
async function copyToNode(nodeId, fileId, bufferOrStream) {
  const health = getNodeHealth(nodeId);
  if (!health || health.status !== 'online') return false;

  try {
    const res = await fetch(`${health.url}/store`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/octet-stream', 'x-file-id': fileId },
      body: bufferOrStream,
      duplex: 'half',
    });
    return res.ok;
  } catch (err) {
    console.warn(`[Replication] Failed copyToNode ${nodeId} for ${fileId}: ${err.message}`);
    return false;
  }
}

/**
 * Remove file from a single specific node.
 */
async function removeFromNode(nodeId, fileId) {
  const health = getNodeHealth(nodeId);
  if (!health || health.status !== 'online') return false;
  try {
    const res = await fetch(`${health.url}/remove/${fileId}`, { method: 'DELETE', headers });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Write a designated backup copy to the isolated offline backup vault.
 */
async function saveBackupCopy(fileBuffer, fileId) {
  try {
    fs.mkdirSync(config.backupDir, { recursive: true });
    const backupPath = path.join(config.backupDir, fileId);
    fs.writeFileSync(backupPath, fileBuffer);
    return true;
  } catch (err) {
    console.error(`[Backup] Failed to save backup copy for ${fileId}: ${err.message}`);
    return false;
  }
}

/**
 * Check if a backup copy exists in the isolated offline backup vault.
 */
function hasBackupCopy(fileId) {
  try {
    const backupPath = path.join(config.backupDir, fileId);
    return fs.existsSync(backupPath);
  } catch {
    return false;
  }
}

/**
 * Remove backup copy from the isolated offline backup vault.
 */
async function removeBackupCopy(fileId) {
  try {
    const backupPath = path.join(config.backupDir, fileId);
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
    return true;
  } catch (err) {
    console.error(`[Backup] Failed to remove backup copy for ${fileId}: ${err.message}`);
    return false;
  }
}

/**
 * Get readable stream of a backup copy.
 */
function getBackupStream(fileId) {
  try {
    const backupPath = path.join(config.backupDir, fileId);
    if (fs.existsSync(backupPath)) {
      return fs.createReadStream(backupPath);
    }
  } catch {}
  return null;
}

module.exports = {
  replicateFile,
  retrieveFile,
  deleteFromNodes,
  copyToNode,
  removeFromNode,
  saveBackupCopy,
  hasBackupCopy,
  removeBackupCopy,
  getBackupStream,
};
