require('dotenv').config();
const http = require('node:http');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const fs = require('node:fs');
const { WebSocketServer } = require('ws');
const config = require('./config');
const { connectDB, FileMetadata } = require('./models');
const { startHealthChecks, getAllHealth, clusterEvents } = require('./services/healthCheck');
const { getEnrichedNodes } = require('./services/clusterStats');

const app = express();

// Request timing & metrics tracking
const requestMetrics = {
  totalRequests: 0,
  uploadedBytes: 0,
  latencies: [],
};

app.use((req, res, next) => {
  const start = performance.now();
  requestMetrics.totalRequests++;

  res.on('finish', () => {
    const durationSec = (performance.now() - start) / 1000;
    requestMetrics.latencies.push(durationSec);
    if (requestMetrics.latencies.length > 500) {
      requestMetrics.latencies.shift();
    }
  });
  next();
});

app.use(morgan('combined'));
app.use(cors({ origin: config.clientUrl }));
app.use(express.json());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please retry in 15 minutes.' },
});

// API Routes
app.use('/api/auth', authLimiter, require('./routes/auth'));
app.use('/api/files', require('./routes/files'));
app.use('/api/cluster', require('./routes/cluster'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/share', require('./routes/share'));
app.use('/api/ai', require('./routes/ai'));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// JSON stats endpoint for dashboard and programmatic API consumption (Admin only)
app.get('/api/stats', require('./middleware/auth'), require('./middleware/auth').requireAdmin, async (req, res) => {
  try {
    const { getClusterMetrics } = require('./services/clusterStats');
    const metrics = await getClusterMetrics(req.user?.id);
    res.json({
      uptime_seconds: process.uptime(),
      memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      ...metrics,
    });
  } catch (err) {
    res.status(500).json({ error: `Stats calculation error: ${err.message}` });
  }
});

// Prometheus Standard Text Exposition Format (/metrics)
// RFC / Prometheus standard: text/plain; version=0.0.4; charset=utf-8
app.get('/metrics', async (_req, res) => {
  const nodes = getAllHealth();
  const files = await FileMetadata.find({});
  const totalStoredBytes = files.reduce((s, f) => s + (f.sizeBytes || 0), 0);

  const lats = [...requestMetrics.latencies].sort((a, b) => a - b);
  const count = lats.length;
  const sum = lats.reduce((s, x) => s + x, 0);

  const b005 = lats.filter(x => x <= 0.05).length;
  const b010 = lats.filter(x => x <= 0.10).length;
  const b025 = lats.filter(x => x <= 0.25).length;
  const b050 = lats.filter(x => x <= 0.50).length;
  const b100 = lats.filter(x => x <= 1.00).length;

  let out = '';

  out += '# HELP dfs_node_up Storage node reachability (1=online, 0=offline)\n';
  out += '# TYPE dfs_node_up gauge\n';
  for (const n of nodes) {
    out += `dfs_node_up{node="${n.id}",url="${n.url}"} ${n.status === 'online' ? 1 : 0}\n`;
  }

  out += '\n# HELP dfs_node_latency_seconds Storage node heartbeat latency\n';
  out += '# TYPE dfs_node_latency_seconds gauge\n';
  for (const n of nodes) {
    if (n.latencyMs != null) {
      out += `dfs_node_latency_seconds{node="${n.id}"} ${(n.latencyMs / 1000).toFixed(4)}\n`;
    }
  }

  out += '\n# HELP dfs_chunk_upload_bytes_total Total bytes committed to storage\n';
  out += '# TYPE dfs_chunk_upload_bytes_total counter\n';
  out += `dfs_chunk_upload_bytes_total ${totalStoredBytes}\n`;

  out += '\n# HELP dfs_replication_pending_chunks Chunks awaiting re-replication\n';
  out += '# TYPE dfs_replication_pending_chunks gauge\n';
  const underReplicated = files.filter(f => (f.distribution?.length || 0) < 3).length;
  out += `dfs_replication_pending_chunks ${underReplicated}\n`;

  out += '\n# HELP dfs_coordinator_uptime_seconds Coordinator process uptime\n';
  out += '# TYPE dfs_coordinator_uptime_seconds gauge\n';
  out += `dfs_coordinator_uptime_seconds ${process.uptime().toFixed(1)}\n`;

  out += '\n# HELP dfs_request_duration_seconds Histogram of request latencies\n';
  out += '# TYPE dfs_request_duration_seconds histogram\n';
  out += `dfs_request_duration_seconds_bucket{le="0.05"} ${b005}\n`;
  out += `dfs_request_duration_seconds_bucket{le="0.1"} ${b010}\n`;
  out += `dfs_request_duration_seconds_bucket{le="0.25"} ${b025}\n`;
  out += `dfs_request_duration_seconds_bucket{le="0.5"} ${b050}\n`;
  out += `dfs_request_duration_seconds_bucket{le="1.0"} ${b100}\n`;
  out += `dfs_request_duration_seconds_bucket{le="+Inf"} ${count}\n`;
  out += `dfs_request_duration_seconds_sum ${sum.toFixed(4)}\n`;
  out += `dfs_request_duration_seconds_count ${count}\n`;

  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(out);
});

// API 404 handler
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Endpoint not found: ${req.method} ${req.originalUrl}` });
});

// Global JSON error handler
app.use((err, req, res, _next) => {
  console.error('[API Error]', err.message || err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Internal Server Error' });
});

fs.mkdirSync(config.tempDir, { recursive: true });

const server = http.createServer(app);

// Event-driven WebSocket Server
const wss = new WebSocketServer({ server, path: '/ws' });
const wsClients = new Set();

function broadcast(msgObj) {
  if (wsClients.size === 0) return;
  const payload = JSON.stringify(msgObj);
  for (const client of wsClients) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    } else {
      wsClients.delete(client);
    }
  }
}

wss.on('connection', async (ws) => {
  wsClients.add(ws);

  // Send initial full snapshot with real physical file mapping on connection
  try {
    const snapshot = await getEnrichedNodes();
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'cluster_update', nodes: snapshot, timestamp: Date.now() }));
    }
  } catch (_) {
    const snapshot = getAllHealth();
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'cluster_update', nodes: snapshot, timestamp: Date.now() }));
    }
  }

  // Handle client requests (e.g. manual resync request)
  ws.on('message', async (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === 'resync') {
        const enriched = await getEnrichedNodes();
        ws.send(JSON.stringify({ type: 'cluster_update', nodes: enriched, timestamp: Date.now() }));
      }
    } catch (_) {}
  });

  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

// Push updates ONLY on actual node status transitions
clusterEvents.on('node_status_change', async (event) => {
  let nodes = getAllHealth();
  try {
    nodes = await getEnrichedNodes();
  } catch (_) {}
  broadcast({
    type: 'cluster_update',
    event: 'node_status_change',
    nodeId: event.nodeId,
    status: event.status,
    nodes,
    timestamp: Date.now(),
  });
});

// Periodic lightweight keepalive ping every 15 seconds
if (require.main === module) {
  const pingInterval = setInterval(() => {
    broadcast({ type: 'ping', timestamp: Date.now() });
  }, 15000);
  pingInterval.unref?.();
}

async function start() {
  await connectDB(config.mongoUri);
  startHealthChecks();
  const { startTieringServices } = require('./services/tieringService');
  startTieringServices();

  // Crash recovery: scan for uncommitted intents from aborted uploads & unreferenced disk blocks
  const { sweepOrphans, sweepUnreferencedBlocks } = require('./services/writeAheadLog');
  sweepOrphans().then(res => {
    if (res.purgedCount > 0) {
      console.log(`[WAL] Startup recovery: purged ${res.purgedCount} uncommitted orphan chunks`);
    }
    return sweepUnreferencedBlocks();
  }).then(res => {
    if (res?.cleaned > 0) {
      console.log(`[WAL] Startup disk GC: cleaned ${res.cleaned} unreferenced orphan blocks from worker nodes`);
    }
  }).catch(() => {});

  server.listen(config.port, () => {
    console.log(`[Coordinator] API listening on http://localhost:${config.port}`);
    console.log(`[Coordinator] Prometheus metrics on http://localhost:${config.port}/metrics`);
    console.log(`[Coordinator] WebSocket server on ws://localhost:${config.port}/ws`);
  });
}

if (require.main === module) {
  start().catch(console.error);
}

module.exports = { app, server };
