/**
 * Smart Storage Tiering, In-Memory LRU Cache, and Automated Purge Service
 *
 * Capabilities:
 * 1. In-Memory LRU Cache: Caches small files/thumbnails (< 1MB) for ultra-fast retrieval.
 * 2. Access Tracking: Increments access_count and updates last_access timestamps on read.
 * 3. Hot/Cold Tiering:
 *    - Hot Node: Files with 10+ reads in the last 7 days get placed onto the designated hot node.
 *    - Cold Node: Files unaccessed for 30+ days have replicas consolidated to the cold node.
 * 4. Background Purge:
 *    - Removes storage node replicas once purge_at is passed.
 *    - Retains offline backup vault copies for an additional 90 days.
 *    - Provides admin restoration from the offline backup vault.
 */

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { FileMetadata } = require('../models');
const { getNodeHealth } = require('./healthCheck');
const {
  retrieveFile,
  deleteFromNodes,
  copyToNode,
  removeFromNode,
  hasBackupCopy,
  removeBackupCopy,
  getBackupStream,
} = require('./replicationService');

/* ─── 1. In-Memory LRU Cache (< 1MB) ───────────────────── */

const MAX_CACHE_ENTRIES = 50;
const MAX_CACHE_FILE_SIZE = 1024 * 1024; // 1 MB

class MemoryLruCache {
  constructor(maxEntries = MAX_CACHE_ENTRIES) {
    this.maxEntries = maxEntries;
    this.cache = new Map(); // key: fileId, value: { buffer, mimeType, size }
  }

  get(fileId) {
    if (!this.cache.has(fileId)) return null;
    const entry = this.cache.get(fileId);
    // Refresh LRU order: delete and re-insert
    this.cache.delete(fileId);
    this.cache.set(fileId, entry);
    return entry;
  }

  set(fileId, buffer, mimeType) {
    if (!buffer || buffer.length > MAX_CACHE_FILE_SIZE) return;
    if (this.cache.has(fileId)) {
      this.cache.delete(fileId);
    } else if (this.cache.size >= this.maxEntries) {
      // Evict oldest (first key in insertion order)
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(fileId, {
      buffer,
      mimeType,
      size: buffer.length,
      cachedAt: Date.now(),
    });
  }

  delete(fileId) {
    this.cache.delete(fileId);
  }

  clear() {
    this.cache.clear();
  }
}

const fileCache = new MemoryLruCache();

/* ─── 2. Access Tracking ──────────────────────────────── */

async function recordAccess(fileId) {
  try {
    const now = new Date();
    await FileMetadata.updateOne(
      { fileId },
      {
        $inc: { access_count: 1 },
        $set: { last_access: now },
      }
    );
  } catch (err) {
    console.warn(`[Tiering] Failed to record access for ${fileId}: ${err.message}`);
  }
}

/* ─── 3. Hot / Cold Tiering Sweep ─────────────────────── */

async function runTieringSweep() {
  try {
    const now = Date.now();
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

    const files = await FileMetadata.find({ deleted_at: null });

    for (const file of files) {
      const lastAccessDate = file.last_access ? new Date(file.last_access) : new Date(file.createdAt);
      const dist = file.distribution || [];
      const nodeIds = dist.map(d => d.nodeId);

      // HOT TIERING: 10+ reads in 7 days -> copy to hot node if not present
      if ((file.access_count || 0) >= 10 && lastAccessDate >= sevenDaysAgo) {
        const hotNode = config.hotNodeId;
        const hotHealth = getNodeHealth(hotNode);

        if (hotHealth?.status === 'online' && !nodeIds.includes(hotNode)) {
          console.log(`[Tiering:HOT] Promoting ${file.originalName} (${file.fileId}) to hot node ${hotNode}`);
          const streamResult = await retrieveFile(file.fileId, dist);
          if (streamResult?.stream) {
            const chunks = [];
            for await (const chunk of streamResult.stream) {
              chunks.push(chunk);
            }
            const buf = Buffer.concat(chunks);
            const copied = await copyToNode(hotNode, file.fileId, buf);
            if (copied) {
              dist.push({ nodeId: hotNode, role: 'hot' });
              await FileMetadata.updateOne({ _id: file._id }, { $set: { distribution: dist } });
            }
          }
        }
      }

      // COLD TIERING: Unaccessed for 30+ days -> move extra replicas to cold node
      if (lastAccessDate < thirtyDaysAgo && dist.length > 1) {
        const coldNode = config.coldNodeId;
        const coldHealth = getNodeHealth(coldNode);

        if (coldHealth?.status === 'online' && !nodeIds.includes(coldNode)) {
          console.log(`[Tiering:COLD] Moving cold file ${file.originalName} (${file.fileId}) to cold node ${coldNode}`);
          const streamResult = await retrieveFile(file.fileId, dist);
          if (streamResult?.stream) {
            const chunks = [];
            for await (const chunk of streamResult.stream) {
              chunks.push(chunk);
            }
            const buf = Buffer.concat(chunks);
            const copied = await copyToNode(coldNode, file.fileId, buf);
            if (copied) {
              // Remove one non-primary replica from normal nodes
              const replicaIndex = dist.findIndex(d => d.role === 'replica' && d.nodeId !== coldNode);
              if (replicaIndex !== -1) {
                const removedDist = dist.splice(replicaIndex, 1)[0];
                await removeFromNode(removedDist.nodeId, file.fileId);
              }
              dist.push({ nodeId: coldNode, role: 'cold' });
              await FileMetadata.updateOne({ _id: file._id }, { $set: { distribution: dist } });
            }
          }
        }
      }
    }
  } catch (err) {
    console.error(`[Tiering] Error running tiering sweep: ${err.message}`);
  }
}

/* ─── 4. Soft Delete & Hourly Purge Job ────────────────── */

async function runPurgeJob() {
  try {
    const now = new Date();
    // Query files that are soft-deleted and past their purge_at timestamp
    const allFiles = await FileMetadata.find({});
    const expiredTrash = allFiles.filter(f => f.deleted_at && f.purge_at && new Date(f.purge_at) <= now);

    for (const file of expiredTrash) {
      console.log(`[Purge] Purging expired trash file ${file.originalName} (${file.fileId})`);

      // 1. Purge physical chunks from normal storage nodes
      const activeDistribution = (file.distribution || []).filter(d => d.role !== 'backup');
      if (activeDistribution.length > 0) {
        await deleteFromNodes(file.fileId, activeDistribution);
      }

      fileCache.delete(file.fileId);

      // 2. Check if backup copy exists
      const backupExists = hasBackupCopy(file.fileId);
      if (backupExists) {
        // Retain backup copy for 90 more days if not already scheduled
        if (!file.backup_purge_at) {
          const ninetyDaysLater = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
          await FileMetadata.updateOne(
            { _id: file._id },
            {
              $set: {
                distribution: [{ nodeId: 'backup-vault', role: 'backup' }],
                backup_purge_at: ninetyDaysLater,
              },
            }
          );
          console.log(`[Purge] Retaining backup vault copy for ${file.originalName} until ${ninetyDaysLater.toISOString()}`);
          continue;
        } else if (new Date(file.backup_purge_at) <= now) {
          // Backup copy expired after 90 days; remove permanently
          await removeBackupCopy(file.fileId);
          await FileMetadata.deleteOne({ _id: file._id });
          console.log(`[Purge] Removed expired 90-day backup for ${file.originalName}`);
          continue;
        }
      } else {
        // No backup copy; purge document permanently
        await FileMetadata.deleteOne({ _id: file._id });
      }
    }
  } catch (err) {
    console.error(`[Purge] Error during purge job: ${err.message}`);
  }
}

/* ─── 5. Admin Restore from Backup Vault ──────────────── */

async function restoreFromBackupVault(fileId) {
  const file = await FileMetadata.findOne({ fileId });
  if (!file) throw new Error('File metadata not found');

  const backupExists = hasBackupCopy(fileId);
  if (!backupExists) throw new Error('No backup copy found in vault');

  const stream = getBackupStream(fileId);
  if (!stream) throw new Error('Unable to read backup file stream');

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const fileBuffer = Buffer.concat(chunks);

  // Restore to primary node
  const { selectNode } = require('./loadBalancer');
  const primaryNode = selectNode([]);
  if (!primaryNode) throw new Error('No online storage node to receive restored file');

  const copied = await copyToNode(primaryNode.id, fileId, fileBuffer);
  if (!copied) throw new Error(`Failed to write restored file to ${primaryNode.id}`);

  const newDist = [
    { nodeId: primaryNode.id, role: 'primary' },
    { nodeId: 'backup-vault', role: 'backup' },
  ];

  await FileMetadata.updateOne(
    { _id: file._id },
    {
      $set: {
        deleted_at: null,
        purge_at: null,
        backup_purge_at: null,
        distribution: newDist,
      },
    }
  );

  return { success: true, message: `Restored ${file.originalName} to ${primaryNode.id}` };
}

/* ─── 6. Service Lifecycle / Job Timers ───────────────── */

let tieringTimer = null;
let purgeTimer = null;

function startTieringServices() {
  if (!tieringTimer && config.tieringIntervalMs > 0) {
    tieringTimer = setInterval(runTieringSweep, config.tieringIntervalMs);
  }
  if (!purgeTimer && config.purgeIntervalMs > 0) {
    purgeTimer = setInterval(runPurgeJob, config.purgeIntervalMs);
  }
}

function stopTieringServices() {
  if (tieringTimer) {
    clearInterval(tieringTimer);
    tieringTimer = null;
  }
  if (purgeTimer) {
    clearInterval(purgeTimer);
    purgeTimer = null;
  }
}

module.exports = {
  fileCache,
  recordAccess,
  runTieringSweep,
  runPurgeJob,
  restoreFromBackupVault,
  startTieringServices,
  stopTieringServices,
};

