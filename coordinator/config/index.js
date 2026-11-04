const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
if (!process.env.INTERNAL_SECRET || !process.env.JWT_SECRET) {
  dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });
}

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is missing. Please define it in .env');
  process.exit(1);
}

if (!process.env.INTERNAL_SECRET) {
  console.error('FATAL: INTERNAL_SECRET environment variable is missing. Please define it in .env');
  process.exit(1);
}

module.exports = {
  port: parseInt(process.env.PORT, 10) || 5000,
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/nodevault',
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiry: '24h',
  internalSecret: process.env.INTERNAL_SECRET,
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  nodes: [
    { id: 'node-1', url: process.env.NODE_1_URL || 'http://127.0.0.1:5001', role: 'primary' },
    { id: 'node-2', url: process.env.NODE_2_URL || 'http://127.0.0.1:5002', role: 'primary' },
    { id: 'node-3', url: process.env.NODE_3_URL || 'http://127.0.0.1:5003', role: 'primary' },
    { id: 'node-backup', url: process.env.NODE_BACKUP_URL || 'http://127.0.0.1:5004', role: 'backup' },
  ],
  backupNodeId: 'node-backup',
  healthCheckIntervalMs: 1500,
  maxFileSizeBytes: 50 * 1024 * 1024,
  replicationFactor: 3,
  tempDir: path.join(__dirname, '..', 'tmp'),
  backupDir: process.env.BACKUP_DIR || path.join(__dirname, '..', 'data', 'backup'),
  hotNodeId: process.env.HOT_NODE_ID || 'node-1',
  coldNodeId: process.env.COLD_NODE_ID || 'node-3',
  tieringIntervalMs: parseInt(process.env.TIERING_INTERVAL_MS, 10) || 60000,
  purgeIntervalMs: parseInt(process.env.PURGE_INTERVAL_MS, 10) || 3600000,
  ai: {
    provider: process.env.AI_PROVIDER || 'gemini',
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || '',
    baseUrl: process.env.AI_BASE_URL || '',
    storePath: process.env.AI_STORE_PATH || path.join(__dirname, '..', 'data', 'filetext.json'),
    maxCharsPerFile: 20000,
    maxCharsTotal: 100000,
    maxIndexBytes: 10 * 1024 * 1024,
    timeoutMs: 30000,
  },
};
