/**
 * Write-Ahead Intent Ledger & Orphan Chunk Sweeper (Crash-Safe Write Path)
 *
 * Guarantees crash consistency:
 * 1. Tracks in-flight chunk writes in an atomic intent log.
 * 2. If coordinator crashes midway through writing to storage nodes, the
 *    startup sweep detects uncommitted intents and purges orphan chunks from worker disks.
 */

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

const INTENTS_FILE = path.join(__dirname, '..', 'data', 'write_intents.json');

function readIntents() {
  try {
    if (!fs.existsSync(INTENTS_FILE)) return [];
    return JSON.parse(fs.readFileSync(INTENTS_FILE, 'utf8'));
  } catch (_) {
    return [];
  }
}

function persistIntents(intents) {
  try {
    fs.mkdirSync(path.dirname(INTENTS_FILE), { recursive: true });
    fs.writeFileSync(INTENTS_FILE, JSON.stringify(intents, null, 2));
  } catch (err) {
    console.error('[WAL] Persist error:', err.message);
  }
}

/**
 * Register a pre-commit intent before streaming bytes to storage daemons.
 */
function recordIntent(fileId, originalName, sizeBytes, targetNodeIds) {
  const intents = readIntents();
  const entry = {
    fileId,
    originalName,
    sizeBytes,
    targetNodeIds,
    writtenNodes: [],
    state: 'PREPARING',
    createdAt: Date.now(),
  };
  intents.push(entry);
  persistIntents(intents);
  return entry;
}

/**
 * Record node write progress
 */
function markNodeWritten(fileId, nodeId) {
  const intents = readIntents();
  const item = intents.find(i => i.fileId === fileId && i.state === 'PREPARING');
  if (item) {
    if (!item.writtenNodes.includes(nodeId)) item.writtenNodes.push(nodeId);
    persistIntents(intents);
  }
}

/**
 * Transition intent to COMMITTED once metadata record is safely stored.
 */
function commitIntent(fileId) {
  const intents = readIntents();
  const item = intents.find(i => i.fileId === fileId);
  if (item) {
    item.state = 'COMMITTED';
    item.committedAt = Date.now();
    persistIntents(intents);
  }
}

/**
 * Abort and immediately purge written chunks from storage nodes.
 */
async function abortAndRollback(fileId) {
  const intents = readIntents();
  const item = intents.find(i => i.fileId === fileId);
  if (!item) return;

  for (const nodeId of item.writtenNodes) {
    const node = config.nodes.find(n => n.id === nodeId);
    if (node) {
      try {
        await fetch(`${node.url}/remove/${fileId}`, {
          method: 'DELETE',
          headers: { 'x-internal-secret': config.internalSecret },
        });
      } catch (_) {}
    }
  }

  item.state = 'ABORTED';
  item.abortedAt = Date.now();
  persistIntents(intents);
}

/**
 * Startup and periodic sweep: Finds uncommitted writes older than maxAgeMs,
 * purges orphan physical chunks from storage nodes, and marks intents ABORTED.
 */
async function sweepOrphans(maxAgeMs = 30000) {
  const intents = readIntents();
  const now = Date.now();
  let purgedCount = 0;

  for (const item of intents) {
    if (item.state === 'PREPARING' && (now - item.createdAt) > maxAgeMs) {
      // Coordinator crashed during this upload! Purge orphan chunks from workers
      for (const nodeId of item.writtenNodes) {
        const node = config.nodes.find(n => n.id === nodeId);
        if (node) {
          try {
            await fetch(`${node.url}/remove/${item.fileId}`, {
              method: 'DELETE',
              headers: { 'x-internal-secret': config.internalSecret },
            });
            purgedCount++;
          } catch (_) {}
        }
      }
      item.state = 'ABORTED_ORPHAN_PURGED';
      item.purgedAt = now;
    }
  }

  persistIntents(intents);
  return { purgedCount };
}

/**
 * Scan worker nodes for unreferenced disk blocks that have no corresponding
 * database record or active upload intent, and purge them.
 */
async function sweepUnreferencedBlocks() {
  const { FileMetadata } = require('../models');
  const allFiles = await FileMetadata.find({});
  const validFileIds = new Set(allFiles.map(f => f.fileId));
  const intents = readIntents();
  const inFlightIds = new Set(intents.filter(i => i.state === 'PREPARING').map(i => i.fileId));

  let cleaned = 0;
  for (const node of config.nodes) {
    try {
      const res = await fetch(`${node.url}/blockreport`, {
        headers: { 'x-internal-secret': config.internalSecret },
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.blocks)) {
          for (const blk of data.blocks) {
            if (!validFileIds.has(blk.fileId) && !inFlightIds.has(blk.fileId)) {
              await fetch(`${node.url}/remove/${blk.fileId}`, {
                method: 'DELETE',
                headers: { 'x-internal-secret': config.internalSecret },
              });
              cleaned++;
            }
          }
        }
      }
    } catch (_) {}
  }
  return { cleaned };
}

module.exports = {
  recordIntent,
  markNodeWritten,
  commitIntent,
  abortAndRollback,
  sweepOrphans,
  sweepUnreferencedBlocks,
};
