/**
 * Audit Log Controller
 * Cryptographic Tamper-Evident Ledger queries, verification, and export.
 */

const { AuditLog } = require('../models');
const { verifyChain } = require('../services/auditService');

exports.getAuditLog = async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(200, parseInt(req.query.limit) || 50);
    const action = req.query.action;
    const status = req.query.status;
    const q      = (req.query.q || '').trim().toLowerCase();
    const scope  = req.query.scope; // 'user' or default (all)

    let logs = await AuditLog.find({}, { sort: { createdAt: -1 } });

    if (req.user?.role !== 'admin') {
      logs = logs.filter(l => l.userId === req.user?.id);
    } else if (scope === 'user') {
      logs = logs.filter(l => l.userId === req.user.id);
    }

    if (action && action !== 'all') {
      logs = logs.filter(l => l.action === action);
    }

    if (status && status !== 'all') {
      logs = logs.filter(l => l.status === status);
    }

    if (q) {
      logs = logs.filter(l =>
        (l.resource && l.resource.toLowerCase().includes(q)) ||
        (l.action && l.action.toLowerCase().includes(q)) ||
        (l.actorIp && l.actorIp.toLowerCase().includes(q)) ||
        (l.requestId && l.requestId.toLowerCase().includes(q)) ||
        (l.hash && l.hash.toLowerCase().includes(q)) ||
        (l.prevHash && l.prevHash.toLowerCase().includes(q))
      );
    }

    const total  = logs.length;
    const start  = (page - 1) * limit;
    const events = logs.slice(start, start + limit);

    res.json({
      events,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit) || 1,
    });
  } catch (err) {
    console.error('[Audit]', err.message);
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
};

exports.verifyAuditChain = async (_req, res) => {
  try {
    const result = await verifyChain();
    res.json(result);
  } catch (err) {
    console.error('[Audit Verify]', err.message);
    res.status(500).json({ error: 'Integrity verification failed', details: err.message });
  }
};

exports.exportAuditLog = async (req, res) => {
  try {
    const format = (req.query.format || 'json').toLowerCase();
    const logs = await AuditLog.find({}, { sort: { createdAt: 1 } });

    if (format === 'csv') {
      const headers = ['Timestamp', 'Action', 'Resource', 'Status', 'ActorIP', 'UserID', 'PrevHash', 'Hash', 'RequestID'];
      const rows = logs.map(l => [
        `"${l.timestamp || l.createdAt || ''}"`,
        `"${l.action || ''}"`,
        `"${(l.resource || '').replace(/"/g, '""')}"`,
        `"${l.status || ''}"`,
        `"${l.actorIp || ''}"`,
        `"${l.userId || ''}"`,
        `"${l.prevHash || ''}"`,
        `"${l.hash || ''}"`,
        `"${l.requestId || ''}"`,
      ].join(','));

      const csvContent = [headers.join(','), ...rows].join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="nodevault-audit-trail.csv"');
      return res.send(csvContent);
    }

    // Default JSON export
    const verification = await verifyChain();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="nodevault-audit-trail.json"');
    res.send(JSON.stringify({
      exportedAt: new Date().toISOString(),
      cryptographicVerification: verification,
      totalRecords: logs.length,
      records: logs,
    }, null, 2));
  } catch (err) {
    console.error('[Audit Export]', err.message);
    res.status(500).json({ error: 'Failed to export audit log' });
  }
};
