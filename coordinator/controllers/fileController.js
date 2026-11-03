const fs = require('node:fs');
const crypto = require('node:crypto');
const config = require('../config');
const { FileMetadata } = require('../models');
const { selectNode } = require('../services/loadBalancer');
const { getOnlineNodes } = require('../services/healthCheck');
const { detectCategory, decide } = require('../services/policy');
const {
  replicateFile,
  retrieveFile,
  deleteFromNodes,
  copyToNode,
  removeFromNode,
  saveBackupCopy,
  hasBackupCopy,
} = require('../services/replicationService');
const { fileCache, recordAccess, restoreFromBackupVault } = require('../services/tieringService');
const { reserveQuota, getQuotaInfo } = require('../services/quotaService');
const { logEvent } = require('../services/auditService');
const aiService = require('../services/aiService');

exports.upload = async (req, res) => {
  const uploadStart = Date.now();
  let quotaReservation = null;
  try {
    if (!req.file) return res.status(400).json({ error: 'No file payload provided' });

    // ─── 0. Smart Storage Policy Decision ─────────────────────
    const rawImportance = req.body?.importance || 'normal';
    const validImportances = ['critical', 'high', 'normal', 'low'];
    if (req.body?.importance && !validImportances.includes(String(rawImportance).toLowerCase())) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Invalid importance. Must be one of: critical, high, normal, low' });
    }

    const category = detectCategory(req.file.mimetype, req.file.originalname);
    const policy = decide(rawImportance, category, getOnlineNodes());

    // ─── 1. Atomic Quota Reservation ─────────────────────────
    quotaReservation = await reserveQuota(req.user.id, req.file.size);
    if (!quotaReservation.allowed) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      await logEvent({
        userId: req.user.id,
        action: 'upload',
        resource: req.file.originalname,
        actorIp: req.ip || req.socket.remoteAddress,
        status: 'failure',
        meta: { reason: 'quota_exceeded', sizeBytes: req.file.size },
      });
      return res.status(413).json({ error: quotaReservation.error });
    }

    const fileBuffer = fs.readFileSync(req.file.path);
    const checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // ─── 2. Reference Count Deduplication ─────────────────────
    const existingBlock = await FileMetadata.findOne({ checksum });
    if (existingBlock) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

      // Increment refCount on existing physical block
      await FileMetadata.updateOne({ fileId: existingBlock.fileId }, { $inc: { refCount: 1 } });

      // Save backup copy if this file's policy requires it
      if (policy.backup && !hasBackupCopy(existingBlock.fileId)) {
        await saveBackupCopy(fileBuffer, existingBlock.fileId);
      }

      // Create distinct logical file for current user
      const logicalDoc = await FileMetadata.create({
        fileId: existingBlock.fileId,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        checksum,
        owner: req.user.id,
        refCount: (existingBlock.refCount || 1) + 1,
        distribution: existingBlock.distribution,
        importance: policy.importance,
        category: policy.category,
        policy_reason: policy.reason,
        deleted_at: null,
        purge_at: null,
        access_count: 0,
        last_access: new Date(),
        aiSummary: '',
        tags: [],
      });

      aiService.indexInBackground({
        docId: logicalDoc._id,
        fileId: existingBlock.fileId,
        owner: req.user.id,
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        buffer: fileBuffer,
      });

      aiService.generateSummaryInBackground(
        logicalDoc._id,
        fileBuffer,
        req.file.originalname,
        req.file.mimetype,
        FileMetadata
      );

      quotaReservation.release();

      await logEvent({
        userId: req.user.id,
        action: 'upload_dedup',
        resource: req.file.originalname,
        actorIp: req.ip || req.socket.remoteAddress,
        status: 'success',
        meta: {
          checksum,
          fileId: existingBlock.fileId,
          importance: policy.importance,
          policy_reason: policy.reason,
          refCount: (existingBlock.refCount || 1) + 1,
          latencyMs: Math.max(1, Date.now() - uploadStart),
        },
      });

      return res.status(200).json({
        id: logicalDoc._id,
        fileId: logicalDoc.fileId,
        originalName: logicalDoc.originalName,
        sizeBytes: logicalDoc.sizeBytes,
        checksum: logicalDoc.checksum,
        sha256Hash: logicalDoc.checksum,
        distribution: logicalDoc.distribution,
        importance: logicalDoc.importance,
        category: logicalDoc.category,
        policy_reason: logicalDoc.policy_reason,
        uploadedAt: logicalDoc.createdAt,
        deduplicated: true,
      });
    }

    // ─── 3. Primary Node Selection & Storage ──────────────────
    const primaryNode = selectNode();
    if (!primaryNode) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      quotaReservation.release();
      return res.status(503).json({ error: 'No storage nodes available in cluster' });
    }

    const fileId = crypto.randomUUID();

    // ─── 3. Write-Ahead Log: Record Intent Before Physical Network Write ─
    const wal = require('../services/writeAheadLog');
    wal.recordIntent(fileId, req.file.originalname, req.file.size, [primaryNode.id]);

    const storeRes = await fetch(`${primaryNode.url}/store`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-file-id': fileId,
        'x-internal-secret': config.internalSecret,
      },
      body: fileBuffer,
    });

    if (!storeRes.ok) {
      await wal.abortAndRollback(fileId);
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      quotaReservation.release();
      return res.status(502).json({ error: 'Primary storage node rejected write' });
    }

    wal.markNodeWritten(fileId, primaryNode.id);

    // ─── 4. Policy-Driven Multi-Replica Replication ───────────
    const replicaNodeIds = await replicateFile(fileBuffer, fileId, primaryNode.id, policy.replicas);

    if (Array.isArray(replicaNodeIds)) {
      replicaNodeIds.forEach(id => wal.markNodeWritten(fileId, id));
    } else if (replicaNodeIds) {
      wal.markNodeWritten(fileId, replicaNodeIds);
    }

    // Designated Backup Vault Storage
    if (policy.backup) {
      await saveBackupCopy(fileBuffer, fileId);
    }

    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    const distribution = [{ nodeId: primaryNode.id, role: 'primary' }];
    if (Array.isArray(replicaNodeIds)) {
      replicaNodeIds.forEach(nodeId => distribution.push({ nodeId, role: 'replica' }));
    } else if (replicaNodeIds) {
      distribution.push({ nodeId: replicaNodeIds, role: 'replica' });
    }
    if (policy.backup) {
      distribution.push({ nodeId: 'backup-vault', role: 'backup' });
    }

    const metadata = await FileMetadata.create({
      fileId,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      checksum,
      owner: req.user.id,
      refCount: 1,
      distribution,
      importance: policy.importance,
      category: policy.category,
      policy_reason: policy.reason,
      deleted_at: null,
      purge_at: null,
      access_count: 0,
      last_access: new Date(),
      aiSummary: '',
      tags: [],
    });

    aiService.indexInBackground({
      docId: metadata._id,
      fileId,
      owner: req.user.id,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      buffer: fileBuffer,
    });

    aiService.generateSummaryInBackground(
      metadata._id,
      fileBuffer,
      req.file.originalname,
      req.file.mimetype,
      FileMetadata
    );

    // Cache small uploads immediately
    if (fileBuffer.length <= 1024 * 1024) {
      fileCache.set(fileId, fileBuffer, req.file.mimetype);
    }

    // ─── 5. Commit Intent in WAL ──────────────────────────────
    wal.commitIntent(fileId);

    quotaReservation.release();

    await logEvent({
      userId: req.user.id,
      action: 'upload',
      resource: req.file.originalname,
      actorIp: req.ip || req.socket.remoteAddress,
      requestId: req.headers['x-request-id'] || '',
      status: 'success',
      meta: {
        fileId,
        sizeBytes: req.file.size,
        importance: policy.importance,
        policy_reason: policy.reason,
        replicas: distribution.length,
        latencyMs: Math.max(1, Date.now() - uploadStart),
      },
    });

    res.status(201).json({
      id: metadata._id,
      fileId: metadata.fileId,
      originalName: metadata.originalName,
      sizeBytes: metadata.sizeBytes,
      checksum: metadata.checksum,
      sha256Hash: metadata.checksum,
      distribution: metadata.distribution,
      importance: metadata.importance,
      category: metadata.category,
      policy_reason: metadata.policy_reason,
      uploadedAt: metadata.createdAt,
      deduplicated: false,
    });
  } catch (err) {
    if (quotaReservation) quotaReservation.release();
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    console.error('[Upload error]', err.message);
    res.status(500).json({ error: `Upload failed: ${err.message}` });
  }
};

exports.list = async (req, res) => {
  try {
    // Normal users only see their own active files (excluding trash); admins see all active files
    const query = req.user?.role === 'admin'
      ? { deleted_at: null }
      : { owner: req.user?.id, deleted_at: null };
    const files = await FileMetadata.find(query, { sort: { createdAt: -1 } });
    const enriched = files.map(f => ({
      ...f,
      id: f._id,
      _id: f._id,
      checksum: f.checksum || f.sha256Hash || '',
      sha256Hash: f.checksum || f.sha256Hash || '',
    }));
    res.json(enriched);
  } catch (err) {
    console.error('[List error]', err.message);
    res.status(500).json({ error: 'Failed to list files' });
  }
};

exports.download = async (req, res) => {
  try {
    const file = await FileMetadata.findOne({ _id: req.params.id }) ||
                 await FileMetadata.findOne({ fileId: req.params.id });
    if (!file) return res.status(404).json({ error: 'File not found' });

    if (file.deleted_at) {
      return res.status(410).json({ error: 'File is in trash. Please restore it before downloading.' });
    }

    if (req.user?.role !== 'admin' && file.owner !== req.user?.id) {
      return res.status(403).json({ error: 'Access denied: You do not own this file' });
    }

    // 1. Fast path: Check LRU Cache
    const cached = fileCache.get(file.fileId);
    if (cached) {
      recordAccess(file.fileId);
      await logEvent({
        userId: req.user?.id || 'anonymous',
        action: 'download',
        resource: file.originalName,
        actorIp: req.ip || req.socket.remoteAddress,
        requestId: req.headers['x-request-id'] || '',
        status: 'success',
        meta: { fileId: file.fileId, servedFrom: 'memory-lru-cache', failover: false },
      });

      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.originalName)}"`);
      res.setHeader('Content-Type', file.mimeType || cached.mimeType || 'application/octet-stream');
      res.setHeader('X-Served-From', 'memory-lru-cache');
      res.setHeader('X-Failover', 'false');
      return res.send(cached.buffer);
    }

    // 2. Fetch from least-loaded replica
    const result = await retrieveFile(file.fileId, file.distribution);
    if (!result) return res.status(503).json({ error: 'File unavailable: all holding replicas offline' });

    // Track access count and timestamp
    recordAccess(file.fileId);

    // Cache small files (< 1MB) for subsequent fast hits
    if (file.sizeBytes && file.sizeBytes <= 1024 * 1024) {
      const chunks = [];
      result.stream.on('data', chunk => chunks.push(chunk));
      result.stream.on('end', () => {
        fileCache.set(file.fileId, Buffer.concat(chunks), file.mimeType);
      });
    }

    await logEvent({
      userId: req.user?.id || 'anonymous',
      action: 'download',
      resource: file.originalName,
      actorIp: req.ip || req.socket.remoteAddress,
      requestId: req.headers['x-request-id'] || '',
      status: 'success',
      meta: { fileId: file.fileId, servedFrom: result.servedFrom, failover: result.failover },
    });

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.originalName)}"`);
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('X-Served-From', result.servedFrom);
    res.setHeader('X-Failover', String(result.failover));

    result.stream.pipe(res);
  } catch (err) {
    console.error('[Download error]', err.message);
    res.status(500).json({ error: 'Download failed' });
  }
};

/**
 * Soft Delete with Critical File Confirmation
 */
exports.remove = async (req, res) => {
  try {
    const file = await FileMetadata.findOne({ _id: req.params.id }) ||
                 await FileMetadata.findOne({ fileId: req.params.id });
    if (!file) return res.status(404).json({ error: 'File not found' });

    if (req.user?.role !== 'admin' && file.owner !== req.user?.id) {
      return res.status(403).json({ error: 'Access denied: You do not own this file' });
    }

    // Critical delete confirmation check
    if (file.importance === 'critical') {
      const confirmName = req.body?.confirmName || req.query?.confirmName;
      if (confirmName !== file.originalName) {
        return res.status(400).json({
          error: `Critical file deletion requires exact file name confirmation: "${file.originalName}"`,
        });
      }
    }

    // Determine retention days from policy
    const policy = decide(file.importance, file.category);
    const trashDays = policy.trashDays || 7;
    const now = new Date();
    const purgeAt = new Date(now.getTime() + trashDays * 24 * 60 * 60 * 1000);

    // Soft delete: flag record with timestamps
    await FileMetadata.updateOne(
      { _id: file._id },
      {
        $set: {
          deleted_at: now,
          purge_at: purgeAt,
        },
      }
    );

    // Evict from LRU cache
    fileCache.delete(file.fileId);

    await logEvent({
      userId: req.user.id,
      action: 'soft_delete',
      resource: file.originalName,
      actorIp: req.ip || req.socket.remoteAddress,
      status: 'success',
      meta: {
        fileId: file.fileId,
        importance: file.importance,
        purgeAt: purgeAt.toISOString(),
      },
    });

    res.json({
      message: `File moved to trash. Will be retained for ${trashDays} days.`,
      deleted_at: now,
      purge_at: purgeAt,
    });
  } catch (err) {
    console.error('[Delete error]', err.message);
    res.status(500).json({ error: 'Delete failed' });
  }
};

/**
 * List soft-deleted files in Trash
 */
exports.trash = async (req, res) => {
  try {
    const query = req.user?.role === 'admin'
      ? { deleted_at: { $ne: null } }
      : { owner: req.user?.id, deleted_at: { $ne: null } };

    const trashFiles = await FileMetadata.find(query, { sort: { deleted_at: -1 } });
    const now = Date.now();

    const enriched = trashFiles.map(f => {
      const purgeTime = f.purge_at ? new Date(f.purge_at).getTime() : now;
      const msLeft = Math.max(0, purgeTime - now);
      const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));

      return {
        ...f,
        id: f._id,
        _id: f._id,
        daysLeft,
        canRestore: true,
      };
    });

    res.json(enriched);
  } catch (err) {
    console.error('[Trash list error]', err.message);
    res.status(500).json({ error: 'Failed to list trash' });
  }
};

/**
 * Restore soft-deleted file
 */
exports.restore = async (req, res) => {
  try {
    const file = await FileMetadata.findOne({ _id: req.params.id }) ||
                 await FileMetadata.findOne({ fileId: req.params.id });
    if (!file) return res.status(404).json({ error: 'File not found' });

    if (req.user?.role !== 'admin' && file.owner !== req.user?.id) {
      return res.status(403).json({ error: 'Access denied: You do not own this file' });
    }

    if (!file.deleted_at) {
      return res.status(400).json({ error: 'File is not in trash' });
    }

    await FileMetadata.updateOne(
      { _id: file._id },
      {
        $set: {
          deleted_at: null,
          purge_at: null,
        },
      }
    );

    await logEvent({
      userId: req.user.id,
      action: 'restore_file',
      resource: file.originalName,
      actorIp: req.ip || req.socket.remoteAddress,
      status: 'success',
      meta: { fileId: file.fileId },
    });

    res.json({ message: 'File restored successfully', id: file._id });
  } catch (err) {
    console.error('[Restore error]', err.message);
    res.status(500).json({ error: 'Restore failed' });
  }
};

/**
 * Restore from isolated offline backup vault (Admin only)
 */
exports.restoreBackup = async (req, res) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required to restore from backup vault' });
    }

    const file = await FileMetadata.findOne({ _id: req.params.id }) ||
                 await FileMetadata.findOne({ fileId: req.params.id });
    if (!file) return res.status(404).json({ error: 'File not found' });

    const result = await restoreFromBackupVault(file.fileId);

    await logEvent({
      userId: req.user.id,
      action: 'restore_backup_vault',
      resource: file.originalName,
      actorIp: req.ip || req.socket.remoteAddress,
      status: 'success',
      meta: { fileId: file.fileId },
    });

    res.json(result);
  } catch (err) {
    console.error('[RestoreBackup error]', err.message);
    res.status(500).json({ error: `Backup restore failed: ${err.message}` });
  }
};

/**
 * Update Importance Level & Rebalance Replicas
 */
exports.updateImportance = async (req, res) => {
  try {
    const { importance } = req.body;
    const validImportances = ['critical', 'high', 'normal', 'low'];
    if (!importance || !validImportances.includes(String(importance).toLowerCase())) {
      return res.status(400).json({ error: 'Invalid importance. Must be one of: critical, high, normal, low' });
    }

    const file = await FileMetadata.findOne({ _id: req.params.id }) ||
                 await FileMetadata.findOne({ fileId: req.params.id });
    if (!file) return res.status(404).json({ error: 'File not found' });

    if (req.user?.role !== 'admin' && file.owner !== req.user?.id) {
      return res.status(403).json({ error: 'Access denied: You do not own this file' });
    }

    const onlineNodes = getOnlineNodes();
    const newPolicy = decide(importance, file.category, onlineNodes);
    let dist = [...(file.distribution || [])];

    // Count current active storage nodes (excluding backup)
    const activeReplicas = dist.filter(d => d.role !== 'backup');
    const currentCount = activeReplicas.length;
    const targetCount = newPolicy.replicas;

    if (targetCount > currentCount) {
      // Need to add replicas: fetch file content and store to candidate nodes
      const streamResult = await retrieveFile(file.fileId, dist);
      if (streamResult?.stream) {
        const chunks = [];
        for await (const chunk of streamResult.stream) {
          chunks.push(chunk);
        }
        const fileBuffer = Buffer.concat(chunks);

        const holdingNodeIds = new Set(activeReplicas.map(d => d.nodeId));
        const needed = targetCount - currentCount;
        const candidates = onlineNodes.filter(n => !holdingNodeIds.has(n.id));

        for (let i = 0; i < Math.min(needed, candidates.length); i++) {
          const targetNode = candidates[i];
          const copied = await copyToNode(targetNode.id, file.fileId, fileBuffer);
          if (copied) {
            dist.push({ nodeId: targetNode.id, role: 'replica' });
          }
        }
      }
    } else if (targetCount < currentCount) {
      // Need to reduce replicas: remove non-primary nodes until target count reached
      const toRemoveCount = currentCount - targetCount;
      let removedSoFar = 0;

      for (let i = dist.length - 1; i >= 0 && removedSoFar < toRemoveCount; i--) {
        if (dist[i].role === 'replica') {
          const removedNodeId = dist[i].nodeId;
          await removeFromNode(removedNodeId, file.fileId);
          dist.splice(i, 1);
          removedSoFar++;
        }
      }
    }

    // Handle backup copy requirement
    if (newPolicy.backup && !hasBackupCopy(file.fileId)) {
      const streamResult = await retrieveFile(file.fileId, dist);
      if (streamResult?.stream) {
        const chunks = [];
        for await (const chunk of streamResult.stream) {
          chunks.push(chunk);
        }
        await saveBackupCopy(Buffer.concat(chunks), file.fileId);
        if (!dist.some(d => d.role === 'backup')) {
          dist.push({ nodeId: 'backup-vault', role: 'backup' });
        }
      }
    }

    await FileMetadata.updateOne(
      { _id: file._id },
      {
        $set: {
          importance: newPolicy.importance,
          policy_reason: newPolicy.reason,
          distribution: dist,
        },
      }
    );

    await logEvent({
      userId: req.user.id,
      action: 'update_importance',
      resource: file.originalName,
      actorIp: req.ip || req.socket.remoteAddress,
      status: 'success',
      meta: {
        fileId: file.fileId,
        previousImportance: file.importance,
        newImportance: newPolicy.importance,
        newPolicyReason: newPolicy.reason,
        replicasCount: dist.filter(d => d.role !== 'backup').length,
      },
    });

    res.json({
      id: file._id,
      fileId: file.fileId,
      originalName: file.originalName,
      importance: newPolicy.importance,
      category: file.category,
      policy_reason: newPolicy.reason,
      distribution: dist,
    });
  } catch (err) {
    console.error('[Update importance error]', err.message);
    res.status(500).json({ error: 'Failed to update importance' });
  }
};

exports.quota = async (req, res) => {
  try {
    const info = await getQuotaInfo(req.user.id);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch quota metrics' });
  }
};

exports.verify = async (req, res) => {
  try {
    const file = await FileMetadata.findOne({ _id: req.params.id }) ||
                 await FileMetadata.findOne({ fileId: req.params.id });
    if (!file) return res.status(404).json({ error: 'File not found' });

    if (req.user?.role !== 'admin' && file.owner !== req.user?.id) {
      return res.status(403).json({ error: 'Access denied: You do not own this file' });
    }

    const replicaResults = [];
    let allPass = true;
    const distribution = file.distribution || [];

    for (const dist of distribution) {
      if (dist.role === 'backup') continue;
      const node = config.nodes.find(n => n.id === dist.nodeId);
      if (!node) continue;
      try {
        const resp = await fetch(`${node.url}/checksum/${file.fileId}`, {
          headers: { 'x-internal-secret': config.internalSecret },
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) {
          const data = await resp.json();
          const match = data.checksum === file.checksum;
          if (!match) allPass = false;
          replicaResults.push({
            nodeId: node.id,
            role: dist.role || 'replica',
            status: match ? 'verified' : 'corrupted',
            expectedChecksum: file.checksum,
            actualChecksum: data.checksum,
            match,
          });
        } else {
          allPass = false;
          replicaResults.push({
            nodeId: node.id,
            role: dist.role || 'replica',
            status: 'offline',
            expectedChecksum: file.checksum,
            actualChecksum: null,
            match: false,
          });
        }
      } catch (err) {
        allPass = false;
        replicaResults.push({
          nodeId: node.id,
          role: dist.role || 'replica',
          status: 'unreachable',
          error: err.message,
          match: false,
        });
      }
    }

    const passed = allPass && replicaResults.length > 0;

    await logEvent({
      userId: req.user?.id || 'anonymous',
      action: 'verify_checksum',
      resource: file.originalName,
      actorIp: req.ip || req.socket.remoteAddress,
      status: passed ? 'success' : 'failure',
      meta: {
        fileId: file.fileId,
        expectedChecksum: file.checksum,
        passed,
        replicasCount: replicaResults.length,
      },
    });

    res.json({
      fileId: file.fileId,
      originalName: file.originalName,
      expectedChecksum: file.checksum,
      passed,
      replicas: replicaResults,
    });
  } catch (err) {
    console.error('[Verify error]', err.message);
    res.status(500).json({ error: 'Verification failed' });
  }
};
