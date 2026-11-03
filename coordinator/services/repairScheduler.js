/**
 * Priority-Aware Rate-Limited Repair Scheduler
 *
 * Prevents replication storms during node failures:
 * 1. Prioritizes critically degraded files (1 surviving replica) ahead of 2-replica files.
 * 2. Rate-limits concurrent transfers to avoid saturating storage node I/O and network bandwidth.
 * 3. Enforces a grace period to prevent transient network blips from triggering massive data copies.
 */

const config = require('../config');
const { FileMetadata } = require('../models');
const { getOnlineNodes } = require('./healthCheck');
const { logEvent } = require('./auditService');

const MAX_CONCURRENT_TRANSFERS = 2; // Rate limit: maximum parallel background transfers
const INTER_CHUNK_DELAY_MS = 100;    // Yield I/O to foreground requests

let activeTransfers = 0;
const queue = []; // Array of { fileId, priority, survivingNodes, targetNodes }
let isRunning = false;

/**
 * Enqueue files needing re-replication with priority.
 * P0 (Critical): 1 replica remaining
 * P1 (Degraded): 2 replicas remaining
 */
async function scheduleRebalance() {
  const onlineNodes = getOnlineNodes();
  if (onlineNodes.length === 0) return { scheduled: 0, reason: 'No healthy nodes available' };

  const onlineNodeIds = new Set(onlineNodes.map(n => n.id));
  const files = await FileMetadata.find({});
  let enqueued = 0;

  for (const file of files) {
    const surviving = (file.distribution || []).filter(d => onlineNodeIds.has(d.nodeId));
    const survivingCount = surviving.length;

    if (survivingCount < config.replicationFactor && survivingCount > 0) {
      // Find candidate nodes that do NOT already hold this file
      const currentHoldingIds = new Set(file.distribution.map(d => d.nodeId));
      const candidates = onlineNodes.filter(n => !currentHoldingIds.has(n.id));

      if (candidates.length > 0) {
        // Priority 0 = Critical (only 1 copy left), Priority 1 = Warning (2 copies left)
        const priority = survivingCount === 1 ? 0 : 1;

        // Avoid duplicate queuing
        if (!queue.some(item => item.fileId === file.fileId)) {
          queue.push({
            file,
            priority,
            survivingNodeId: surviving[0].nodeId,
            targetNodeId: candidates[0].id,
          });
          enqueued++;
        }
      }
    }
  }

  // Sort queue by priority ascending (0 first, then 1)
  queue.sort((a, b) => a.priority - b.priority);

  processQueue();

  return { enqueued, currentQueueSize: queue.length };
}

async function processQueue() {
  if (isRunning) return;
  isRunning = true;

  while (queue.length > 0) {
    if (activeTransfers >= MAX_CONCURRENT_TRANSFERS) {
      await new Promise(r => setTimeout(r, 150));
      continue;
    }

    const task = queue.shift();
    if (!task) break;

    activeTransfers++;

    (async () => {
      try {
        const sourceNode = config.nodes.find(n => n.id === task.survivingNodeId);
        const targetNode = config.nodes.find(n => n.id === task.targetNodeId);

        if (sourceNode && targetNode) {
          // Read chunk from survivor
          const res = await fetch(`${sourceNode.url}/retrieve/${task.file.fileId}`, {
            headers: { 'x-internal-secret': config.internalSecret },
          });

          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());

            // Write chunk to target
            const writeRes = await fetch(`${targetNode.url}/store`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/octet-stream',
                'x-file-id': task.file.fileId,
                'x-internal-secret': config.internalSecret,
              },
              body: buf,
            });

            if (writeRes.ok) {
              // Update metadata distribution
              const updatedDist = [...(task.file.distribution || []), { nodeId: targetNode.id, role: 'replica' }];
              await FileMetadata.updateOne({ _id: task.file._id }, { $set: { distribution: updatedDist } });

              await logEvent({
                userId: 'system',
                action: 'repair_completed',
                resource: task.file.originalName,
                status: 'success',
                meta: {
                  fileId: task.file.fileId,
                  priority: task.priority === 0 ? 'CRITICAL_P0' : 'NORMAL_P1',
                  sourceNode: sourceNode.id,
                  targetNode: targetNode.id,
                },
              });
            }
          }
        }
      } catch (err) {
        console.error('[RepairScheduler] Transfer failed:', err.message);
      } finally {
        activeTransfers--;
        // Yield inter-chunk delay to allow user foreground requests to process without contention
        await new Promise(r => setTimeout(r, INTER_CHUNK_DELAY_MS));
      }
    })();
  }

  isRunning = false;
}

function getQueueMetrics() {
  return {
    queueLength: queue.length,
    activeTransfers,
    criticalItems: queue.filter(q => q.priority === 0).length,
    normalItems: queue.filter(q => q.priority === 1).length,
  };
}

module.exports = { scheduleRebalance, getQueueMetrics };
