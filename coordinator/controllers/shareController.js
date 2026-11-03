/**
 * Public File Sharing Controller
 *
 * Security architecture:
 * 1. Tokens are generated via crypto.randomBytes(32) (256-bit cryptographically secure).
 * 2. Database stores SHA-256 hash of the token, never the plaintext token.
 * 3. Enforces server-side expiration and optional max-download limits.
 * 4. Every access is recorded in the append-only audit ledger.
 */

const crypto = require('node:crypto');
const { FileMetadata, ShareLink } = require('../models');
const { retrieveFile } = require('../services/replicationService');
const { logEvent } = require('../services/auditService');

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// ─── Create Share Link ─────────────────────────────────────
exports.createShare = async (req, res) => {
  try {
    const file = await FileMetadata.findOne({ _id: req.params.id, owner: req.user.id }) ||
                 await FileMetadata.findOne({ fileId: req.params.id, owner: req.user.id });
    if (!file) return res.status(404).json({ error: 'File not found' });

    const { expiryHours = 24, maxDownloads = null } = req.body;
    const hours = Math.min(Math.max(parseInt(expiryHours, 10) || 24, 1), 168);
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);

    // 256-bit secure token
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);

    const shareLink = await ShareLink.create({
      tokenHash,
      fileId: file._id,
      fileUUID: file.fileId,
      fileName: file.originalName,
      mimeType: file.mimeType,
      owner: req.user.id,
      expiresAt,
      downloads: 0,
      maxDownloads: maxDownloads ? parseInt(maxDownloads, 10) : null,
      distribution: file.distribution,
    });

    await logEvent({
      userId: req.user.id,
      action: 'share_create',
      resource: file.originalName,
      actorIp: req.ip || req.socket.remoteAddress,
      requestId: req.headers['x-request-id'] || '',
      status: 'success',
      meta: { shareId: shareLink._id, expiresAt, maxDownloads },
    });

    res.status(201).json({
      token,
      url: `/api/share/${token}/download`,
      fileName: file.originalName,
      expiresAt,
      maxDownloads,
      shareId: shareLink._id,
    });
  } catch (err) {
    console.error('[Share] Create failed:', err.message);
    res.status(500).json({ error: 'Failed to create share link' });
  }
};

// ─── List Active Shares ───────────────────────────────────
exports.listShares = async (req, res) => {
  try {
    const shares = await ShareLink.find({ owner: req.user.id }, { sort: { createdAt: -1 } });
    const now = new Date();
    const result = shares.map(s => ({
      _id: s._id,
      fileName: s.fileName,
      fileId: s.fileId,
      expiresAt: s.expiresAt,
      downloads: s.downloads,
      maxDownloads: s.maxDownloads,
      expired: new Date(s.expiresAt) < now,
      exhausted: s.maxDownloads !== null && s.downloads >= s.maxDownloads,
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list share links' });
  }
};

// ─── Revoke Share Link ─────────────────────────────────────
exports.revokeShare = async (req, res) => {
  try {
    const share = await ShareLink.findOne({ _id: req.params.shareId, owner: req.user.id });
    if (!share) return res.status(404).json({ error: 'Share link not found' });

    await ShareLink.deleteOne({ _id: share._id });

    await logEvent({
      userId: req.user.id,
      action: 'share_revoke',
      resource: share.fileName,
      actorIp: req.ip || req.socket.remoteAddress,
      status: 'success',
      meta: { shareId: share._id },
    });

    res.json({ message: 'Share link revoked' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to revoke share link' });
  }
};

// ─── Public Download (Unauthenticated by Token Hash) ───────
exports.publicDownload = async (req, res) => {
  try {
    const rawToken = req.params.token;
    if (!rawToken || typeof rawToken !== 'string') {
      return res.status(400).json({ error: 'Invalid token format' });
    }

    const tokenHash = hashToken(rawToken);
    const share = await ShareLink.findOne({ tokenHash });
    if (!share) {
      return res.status(404).json({ error: 'Share link not found or expired' });
    }

    const now = new Date();
    if (new Date(share.expiresAt) < now) {
      return res.status(410).json({ error: 'Share link expired' });
    }

    if (share.maxDownloads !== null && share.downloads >= share.maxDownloads) {
      return res.status(410).json({ error: 'Share link download quota exceeded' });
    }

    const result = await retrieveFile(share.fileUUID, share.distribution);
    if (!result) {
      return res.status(503).json({ error: 'File unavailable — storage replicas offline' });
    }

    await ShareLink.updateOne({ _id: share._id }, { $inc: { downloads: 1 } });

    await logEvent({
      userId: 'anonymous',
      action: 'share_download',
      resource: share.fileName,
      actorIp: req.ip || req.socket.remoteAddress,
      requestId: req.headers['x-request-id'] || '',
      status: 'success',
      meta: { shareId: share._id, servedFrom: result.servedFrom, downloadNumber: share.downloads + 1 },
    });

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(share.fileName)}"`);
    res.setHeader('Content-Type', share.mimeType || 'application/octet-stream');
    res.setHeader('X-Served-From', result.servedFrom);

    result.stream.pipe(res);
  } catch (err) {
    console.error('[Share] Public download error:', err.message);
    res.status(500).json({ error: 'Download failed' });
  }
};

// ─── Public Share Metadata ─────────────────────────────────
exports.getShareInfo = async (req, res) => {
  try {
    const rawToken = req.params.token;
    if (!rawToken) return res.status(400).json({ error: 'Token required' });

    const tokenHash = hashToken(rawToken);
    const share = await ShareLink.findOne({ tokenHash });
    if (!share) return res.status(404).json({ error: 'Share link not found or expired' });

    const now = new Date();
    res.json({
      fileName: share.fileName,
      mimeType: share.mimeType,
      expiresAt: share.expiresAt,
      expired: new Date(share.expiresAt) < now,
      downloads: share.downloads,
      maxDownloads: share.maxDownloads,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve share metadata' });
  }
};

