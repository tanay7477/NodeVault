/**
 * Periodic Heartbeat Monitor & Cluster State Machine
 *
 * Emits state transition events when nodes go online or offline.
 * Triggers self-healing reconciliation with damping grace periods.
 */

const EventEmitter = require('node:events');
const config = require('../config');

const clusterEvents = new EventEmitter();

let _selfHeal = null;
function getSelfHeal() {
  if (!_selfHeal) _selfHeal = require('./selfHeal');
  return _selfHeal;
}

const nodeHealth = new Map();

for (const node of config.nodes) {
  nodeHealth.set(node.id, {
    id: node.id,
    url: node.url,
    role: node.role || (node.id === 'node-backup' ? 'backup' : 'primary'),
    status: 'unknown',
    lastCheck: null,
    latencyMs: null,
    diskUsage: null,
    fileCount: 0,
    error: null,
    prevStatus: 'unknown',
  });
}

async function checkNode(node) {
  const start = Date.now();
  const prev = nodeHealth.get(node.id);
  const wasOnline = prev?.status === 'online';

  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 3000);

    const res = await fetch(`${node.url}/health`, { signal: ctrl.signal });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const currentHealth = {
      id: node.id,
      url: node.url,
      role: node.role || (node.id === 'node-backup' ? 'backup' : 'primary'),
      status: 'online',
      lastCheck: new Date().toISOString(),
      latencyMs: Date.now() - start,
      diskUsage: data.diskUsage || null,
      fileCount: data.fileCount || 0,
      error: null,
      prevStatus: prev?.status || 'unknown',
    };
    nodeHealth.set(node.id, currentHealth);

    // Transition: offline -> online
    if (prev && prev.status !== 'online') {
      clusterEvents.emit('node_status_change', {
        nodeId: node.id,
        status: 'online',
        transition: 'revived',
        health: currentHealth,
      });

      // Self-heal: primary worker node revived, reconcile block reports
      if (node.role !== 'backup' && node.id !== 'node-backup') {
        setImmediate(() => getSelfHeal().selfHeal(node.id).catch(console.error));
      }
    }
  } catch (err) {
    const currentHealth = {
      ...prev,
      status: 'offline',
      lastFailedCheck: new Date().toISOString(),
      latencyMs: null,
      error: err.message,
      prevStatus: prev?.status || 'unknown',
    };
    nodeHealth.set(node.id, currentHealth);

    // Transition: online -> offline
    if (wasOnline) {
      clusterEvents.emit('node_status_change', {
        nodeId: node.id,
        status: 'offline',
        transition: 'fault_detected',
        health: currentHealth,
      });

      // Proactive re-replication for under-replicated files
      setImmediate(() => getSelfHeal().healUnderReplicated().catch(console.error));
    }
  }
}

function startHealthChecks() {
  const run = () => config.nodes.forEach(checkNode);
  run();
  setInterval(run, config.healthCheckIntervalMs);
}

function getNodeHealth(nodeId) {
  const n = nodeHealth.get(nodeId);
  if (!n) return null;
  // Enforce 3s heartbeat timeout: if last successful check was > 3000ms ago, mark offline
  if (n.status === 'online' && n.lastCheck && (Date.now() - new Date(n.lastCheck).getTime() > 3000)) {
    return { ...n, status: 'offline', error: 'Heartbeat timeout (>3s)' };
  }
  return n;
}

function getAllHealth() {
  const now = Date.now();
  return Array.from(nodeHealth.values()).map(n => {
    if (n.status === 'online' && n.lastCheck && (now - new Date(n.lastCheck).getTime() > 3000)) {
      return { ...n, status: 'offline', error: 'Heartbeat timeout (>3s)' };
    }
    return n;
  });
}

function getOnlineNodes() {
  return getAllHealth().filter(n => n.status === 'online');
}

module.exports = {
  startHealthChecks,
  checkNode,
  getNodeHealth,
  getAllHealth,
  getOnlineNodes,
  clusterEvents,
};
