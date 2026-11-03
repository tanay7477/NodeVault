/**
 * Independent storage node service.
 *
 * Usage:
 *   node nodeService.js --id node-1 --port 5001
 *   node nodeService.js --id node-2 --port 5002
 *   node nodeService.js --id node-3 --port 5003
 *
 * Security:
 *  - Internal secret header (x-internal-secret) required on EVERY endpoint except GET /health.
 *  - File IDs are validated as UUIDs to prevent path traversal.
 *  - /health returns ONLY status, nodeId, fileCount and diskUsage (no file names or hashes).
 *  - /corrupt and /toggle endpoints are only enabled when ENABLE_CHAOS=true in env; otherwise 404.
 *  - Storage node binds strictly to 127.0.0.1 loopback interface.
 */

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const cors = require('cors');
const dotenv = require('dotenv');

// Load environment variables from storage-nodes/.env, root .env, or coordinator/.env
dotenv.config({ path: path.join(__dirname, '.env') });
if (!process.env.INTERNAL_SECRET) {
  dotenv.config({ path: path.join(__dirname, '..', '.env') });
}
if (!process.env.INTERNAL_SECRET) {
  dotenv.config({ path: path.join(__dirname, '..', 'coordinator', '.env') });
}

// ─── CLI Args ──────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag, fallback) => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
};

const NODE_ID = getArg('--id', 'node-1');
const PORT = parseInt(getArg('--port', '5001'), 10);

if (!process.env.INTERNAL_SECRET) {
  console.error('FATAL: INTERNAL_SECRET environment variable is missing. Please define it in .env');
  process.exit(1);
}

const INTERNAL_SECRET = process.env.INTERNAL_SECRET;
const ENABLE_CHAOS = process.env.ENABLE_CHAOS === 'true';

const UUID_REGEX = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// ─── Data Directory ────────────────────────────────────
const dataDir = path.join(__dirname, 'data', NODE_ID);
fs.mkdirSync(dataDir, { recursive: true });

const app = express();
app.use(cors());

let killed = false;

// ─── Internal Auth Middleware ──────────────────────────
// Require x-internal-secret header on EVERY endpoint except GET /health.
app.use((req, res, next) => {
  if (req.method === 'GET' && req.path === '/health') {
    return next();
  }

  if (req.headers['x-internal-secret'] !== INTERNAL_SECRET) {
    return res.status(403).json({ error: 'Unauthorized: missing or invalid x-internal-secret header' });
  }

  if (killed && req.path !== '/toggle') {
    return res.status(503).json({ error: `${NODE_ID} is offline (simulated failure)` });
  }

  next();
});

// ─── Health Check (Public, status + summary metrics only) ─
app.get('/health', (_req, res) => {
  if (killed) return res.status(503).json({ status: 'offline', nodeId: NODE_ID });

  const TOTAL_CAPACITY = 500 * 1024 * 1024; // 500MB simulated capacity
  const files = fs.readdirSync(dataDir);
  let totalBytes = 0;
  for (const f of files) {
    try {
      totalBytes += fs.statSync(path.join(dataDir, f)).size;
    } catch (_) {}
  }

  res.json({
    status: 'online',
    nodeId: NODE_ID,
    fileCount: files.length,
    diskUsage: {
      usedBytes: totalBytes,
      totalBytes: TOTAL_CAPACITY,
      freeBytes: Math.max(0, TOTAL_CAPACITY - totalBytes),
      usedPercent: Math.min(100, Math.round((totalBytes / TOTAL_CAPACITY) * 100)),
    },
  });
});

// ─── Block Report (HDFS / Ceph style block inventory) ──
app.get('/blockreport', (_req, res) => {
  const crypto = require('node:crypto');
  const files = fs.readdirSync(dataDir);
  const blocks = [];

  for (const f of files) {
    if (!UUID_REGEX.test(f)) continue;
    try {
      const filePath = path.join(dataDir, f);
      const stat = fs.statSync(filePath);
      const buf = fs.readFileSync(filePath);
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      blocks.push({
        fileId: f,
        sizeBytes: stat.size,
        checksum: hash,
        modifiedAt: stat.mtime.toISOString(),
      });
    } catch (_) {}
  }

  res.json({
    nodeId: NODE_ID,
    timestamp: new Date().toISOString(),
    blockCount: blocks.length,
    blocks,
  });
});

// ─── Store File ────────────────────────────────────────
app.post('/store', express.raw({ type: 'application/octet-stream', limit: '50mb' }), (req, res) => {
  const fileId = req.headers['x-file-id'];
  if (!fileId || !UUID_REGEX.test(fileId)) {
    return res.status(400).json({ error: 'Valid x-file-id header required' });
  }

  fs.writeFileSync(path.join(dataDir, fileId), req.body);
  res.json({ stored: true, nodeId: NODE_ID, fileId, sizeBytes: req.body.length });
});

// ─── Retrieve File ─────────────────────────────────────
app.get('/retrieve/:fileId', (req, res) => {
  if (!UUID_REGEX.test(req.params.fileId)) {
    return res.status(400).json({ error: 'Invalid file ID' });
  }

  const filePath = path.join(dataDir, req.params.fileId);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  res.sendFile(filePath);
});

// ─── Silent Corruption Simulation (Chaos Lab) ──────────
app.post('/corrupt/:fileId', (req, res) => {
  if (process.env.ENABLE_CHAOS !== 'true') {
    return res.status(404).json({ error: 'Chaos testing endpoints are disabled' });
  }

  if (!UUID_REGEX.test(req.params.fileId)) {
    return res.status(400).json({ error: 'Invalid file ID' });
  }

  const filePath = path.join(dataDir, req.params.fileId);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });

  const buf = fs.readFileSync(filePath);
  if (buf.length === 0) return res.status(400).json({ error: 'File empty, cannot corrupt' });

  // Flip one byte (bit rot simulation)
  const targetIdx = Math.floor(Math.random() * buf.length);
  buf[targetIdx] = buf[targetIdx] ^ 0xFF; // XOR with 0xFF flips all 8 bits
  fs.writeFileSync(filePath, buf);

  console.log(`[${NODE_ID}] ⚠️ Injected 1-byte silent corruption into file ${req.params.fileId} at offset ${targetIdx}`);
  res.json({ corrupted: true, nodeId: NODE_ID, fileId: req.params.fileId, offset: targetIdx });
});

// ─── Local Checksum Probe ──────────────────────────────
app.get('/checksum/:fileId', (req, res) => {
  if (!UUID_REGEX.test(req.params.fileId)) {
    return res.status(400).json({ error: 'Invalid file ID' });
  }

  const filePath = path.join(dataDir, req.params.fileId);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  const crypto = require('node:crypto');
  const buf = fs.readFileSync(filePath);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');

  res.json({ nodeId: NODE_ID, fileId: req.params.fileId, checksum: hash, sizeBytes: buf.length });
});

// ─── Remove File ───────────────────────────────────────
app.delete('/remove/:fileId', (req, res) => {
  if (!UUID_REGEX.test(req.params.fileId)) {
    return res.status(400).json({ error: 'Invalid file ID' });
  }

  const filePath = path.join(dataDir, req.params.fileId);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ deleted: true, nodeId: NODE_ID });
});

// ─── Kill / Revive Toggle (Demo Chaos) ─────────────────
app.post('/toggle', express.json(), (req, res) => {
  if (process.env.ENABLE_CHAOS !== 'true') {
    return res.status(404).json({ error: 'Chaos testing endpoints are disabled' });
  }

  const { action } = req.body;
  if (action === 'kill') killed = true;
  else if (action === 'revive') killed = false;
  else return res.status(400).json({ error: 'Action must be "kill" or "revive"' });

  console.log(`[${NODE_ID}] ${killed ? '⛔ KILLED (simulated failure)' : '✅ REVIVED'}`);
  res.json({ nodeId: NODE_ID, killed });
});

// ─── Start (Strictly bound to 127.0.0.1) ────────────────
if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`[${NODE_ID}] Storage node running on http://127.0.0.1:${PORT}`);
  });
}

module.exports = { app, INTERNAL_SECRET };
