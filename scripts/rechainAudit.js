const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

function normalizeIp(ip) {
  if (!ip) return '127.0.0.1';
  const str = String(ip).trim();
  if (str === '::1' || str === '::ffff:127.0.0.1' || str === 'localhost') return '127.0.0.1';
  if (str.startsWith('::ffff:')) return str.substring(7);
  return str;
}

function computeHash(prevHash, timestamp, userId, action, resource, actorIp, status, meta) {
  const cleanIp = normalizeIp(actorIp);
  const content = `${prevHash}|${timestamp}|${userId}|${action}|${resource}|${cleanIp}|${status}|${JSON.stringify(meta || {})}`;
  return crypto.createHash('sha256').update(content).digest('hex');
}

const auditPath = path.join(__dirname, '..', 'coordinator', 'data', 'audit.json');
if (!fs.existsSync(auditPath)) {
  console.log('No audit.json found');
  process.exit(0);
}

const records = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
// Sort ascending by createdAt
records.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));

let expectedPrev = GENESIS_HASH;
for (let i = 0; i < records.length; i++) {
  const r = records[i];
  r.prevHash = expectedPrev;
  r.timestamp = r.timestamp || r.createdAt || new Date().toISOString();
  r.actorIp = normalizeIp(r.actorIp || '127.0.0.1');
  r.requestId = r.requestId || crypto.randomUUID();
  r.meta = r.meta || {};
  r.status = r.status || 'success';
  r.hash = computeHash(
    r.prevHash,
    r.timestamp,
    r.userId,
    r.action,
    r.resource || '',
    r.actorIp,
    r.status,
    r.meta
  );
  expectedPrev = r.hash;
}

fs.writeFileSync(auditPath, JSON.stringify(records, null, 2));
console.log(`Successfully re-chained ${records.length} audit records. Head hash: ${expectedPrev.substring(0, 16)}...`);
