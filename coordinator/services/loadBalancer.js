/**
 * Intelligent load balancer for storage node selection.
 *
 * Strategy:
 *  1. Primary: Least-loaded (lowest disk usage %) among online nodes.
 *  2. Fallback: Round-robin when disk data isn't available yet.
 *
 * excludeNodeIds lets the replication service avoid placing a replica
 * on the same node as the primary.
 */

const { getOnlineNodes } = require('./healthCheck');

let rrIndex = 0;

function selectNode(excludeNodeIds = []) {
  const candidates = getOnlineNodes().filter(n => !excludeNodeIds.includes(n.id) && n.role !== 'backup' && n.id !== 'node-backup');
  if (candidates.length === 0) return null;

  // Prefer least-loaded
  const withDisk = candidates.filter(n => n.diskUsage?.usedPercent != null);
  if (withDisk.length > 0) {
    withDisk.sort((a, b) => a.diskUsage.usedPercent - b.diskUsage.usedPercent);
    return withDisk[0];
  }

  // Fallback: round-robin
  rrIndex = (rrIndex + 1) % candidates.length;
  return candidates[rrIndex];
}

module.exports = { selectNode };
