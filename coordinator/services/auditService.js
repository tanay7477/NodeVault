/**
 * Cryptographic Tamper-Evident Audit Ledger
 *
 * Each record is chained to the previous record's SHA-256 hash.
 * Modifying any historical log invalidates the cryptographic chain.
 */

const crypto = require('node:crypto');
const { AuditLog } = require('../models');

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

function normalizeIp(ip) {
  if (!ip) return '127.0.0.1';
  const str = String(ip).trim();
  if (str === '::1' || str === '::ffff:127.0.0.1' || str === 'localhost') return '127.0.0.1';
  if (str.startsWith('::ffff:')) return str.substring(7);
  return str;
}

function computeHash(prevHash, timestamp, userId, action, resource, actorIp, status, meta) {
  const normalizedActorIp = normalizeIp(actorIp);
  const content = `${prevHash}|${timestamp}|${userId}|${action}|${resource}|${normalizedActorIp}|${status}|${JSON.stringify(meta || {})}`;
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Log an event into the append-only cryptographic audit chain.
 */
async function logEvent({
  userId = 'system',
  action,
  resource = '',
  actorIp = '127.0.0.1',
  requestId = '',
  meta = {},
  status = 'success',
}) {
  const cleanIp = normalizeIp(actorIp);
  try {
    const existing = await AuditLog.find({}, { sort: { createdAt: -1 } });
    const lastEntry = existing[0] || null;
    const prevHash = lastEntry?.hash || GENESIS_HASH;
    const timestamp = new Date().toISOString();

    const hash = computeHash(prevHash, timestamp, userId, action, resource, cleanIp, status, meta);

    const doc = await AuditLog.create({
      userId,
      action,
      resource,
      actorIp: cleanIp,
      requestId: requestId || crypto.randomUUID(),
      prevHash,
      hash,
      meta,
      status,
      timestamp,
    });

    return doc;
  } catch (err) {
    console.error('[Audit] Logging error:', err.message);
  }
}

/**
 * Verify cryptographic integrity of the entire audit chain.
 * Returns { valid: boolean, brokenIndex: number|null, count: number }
 */
async function verifyChain() {
  const records = await AuditLog.find({}, { sort: { createdAt: 1 } });
  let expectedPrev = GENESIS_HASH;

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.prevHash !== expectedPrev) {
      return { valid: false, brokenIndex: i, reason: 'prevHash mismatch', recordId: r._id };
    }
    const computed = computeHash(
      r.prevHash,
      r.timestamp || r.createdAt,
      r.userId,
      r.action,
      r.resource,
      r.actorIp || '127.0.0.1',
      r.status,
      r.meta
    );
    if (r.hash !== computed) {
      return { valid: false, brokenIndex: i, reason: 'hash signature mismatch', recordId: r._id };
    }
    expectedPrev = r.hash;
  }

  return { valid: true, count: records.length };
}

module.exports = { logEvent, verifyChain };
