const config = require('../config');
const { getAllHealth } = require('../services/healthCheck');
const { logEvent } = require('../services/auditService');

exports.status = async (req, res) => {
  try {
    const { getClusterMetrics } = require('../services/clusterStats');
    const metrics = await getClusterMetrics(req.user?.id);
    res.json({
      summary: metrics.cluster,
      storage: metrics.storage,
      nodes: metrics.nodes,
      userQuota: metrics.userQuota,
    });
  } catch (err) {
    res.status(500).json({ error: `Cluster status error: ${err.message}` });
  }
};

exports.toggleNode = async (req, res) => {
  const { nodeId } = req.params;
  const { action } = req.body;

  const node = config.nodes.find(n => n.id === nodeId);
  if (!node) return res.status(404).json({ error: 'Node not found' });

  if (action !== 'kill' && action !== 'revive') {
    return res.status(400).json({ error: 'Action must be "kill" or "revive"' });
  }

  try {
    const response = await fetch(`${node.url}/toggle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': config.internalSecret,
      },
      body: JSON.stringify({ action }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    // Audit the chaos engineering event
    await logEvent({
      userId: req.user?.id || 'system',
      action: action === 'kill' ? 'node_kill' : 'node_revive',
      resource: nodeId,
      status: 'info',
      meta: { nodeId, action, url: node.url },
    });

    // Immediately trigger health probe so cluster status reflects node transition instantly
    const { checkNode } = require('../services/healthCheck');
    await checkNode(node).catch(() => {});

    res.json({ nodeId, action, result: data });
  } catch (err) {
    res.status(502).json({ error: `Cannot reach ${nodeId}: ${err.message}` });
  }
};

exports.scrub = async (req, res) => {
  try {
    const { runScrub } = require('../services/scrubber');
    const fileId = req.body?.fileId || null;
    const result = await runScrub(fileId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: `Scrubber failed: ${err.message}` });
  }
};

exports.repair = async (_req, res) => {
  try {
    const { scheduleRebalance } = require('../services/repairScheduler');
    const result = await scheduleRebalance();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: `Repair scheduler failed: ${err.message}` });
  }
};

exports.repairMetrics = async (_req, res) => {
  try {
    const { getQueueMetrics } = require('../services/repairScheduler');
    res.json(getQueueMetrics());
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch queue metrics' });
  }
};

exports.injectCorruption = async (req, res) => {
  const { fileId, nodeId } = req.body;
  const node = config.nodes.find(n => n.id === nodeId);
  if (!node) return res.status(404).json({ error: 'Node not found' });

  try {
    const response = await fetch(`${node.url}/corrupt/${fileId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': config.internalSecret,
      },
    });
    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error || `HTTP ${response.status}`);
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Failed to inject corruption on ${nodeId}: ${err.message}` });
  }
};

exports.syncBackup = async (req, res) => {
  try {
    const { FileMetadata } = require('../models');
    const { getNodeHealth } = require('../services/healthCheck');
    const { retrieveFile, copyToNode } = require('../services/replicationService');

    const backupHealth = getNodeHealth('node-backup');
    if (!backupHealth || backupHealth.status !== 'online') {
      return res.status(503).json({ error: 'Node-Backup (port 5004) is offline or unreachable' });
    }

    const files = await FileMetadata.find({ deleted_at: null });
    let syncedCount = 0;
    let skippedCount = 0;

    for (const f of files) {
      try {
        const checkRes = await fetch(`${backupHealth.url}/checksum/${f.fileId}`, {
          headers: { 'x-internal-secret': config.internalSecret },
        });
        if (checkRes.ok) {
          skippedCount++;
          continue;
        }

        const fileResult = await retrieveFile(f.fileId, f.distribution);
        if (fileResult && fileResult.stream) {
          const chunks = [];
          for await (const chunk of fileResult.stream) chunks.push(chunk);
          const buf = Buffer.concat(chunks);
          const ok = await copyToNode('node-backup', f.fileId, buf);
          if (ok) {
            syncedCount++;
          }
        }
      } catch (err) {
        console.warn(`[SyncBackup] Error syncing ${f.fileId}: ${err.message}`);
      }
    }

    await logEvent({
      userId: req.user?.id || 'admin',
      action: 'vault_sync',
      resource: 'node-backup',
      status: 'success',
      meta: { syncedCount, skippedCount, totalFiles: files.length },
    });

    res.json({
      success: true,
      message: `Disaster Recovery sync complete: ${syncedCount} new files backed up to node-backup`,
      syncedCount,
      skippedCount,
      totalFiles: files.length,
    });
  } catch (err) {
    res.status(500).json({ error: `Sync backup failed: ${err.message}` });
  }
};


