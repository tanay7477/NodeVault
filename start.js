/**
 * Root cluster launcher — starts Coordinator + 3 Storage Nodes in one command.
 *
 * Usage: node start.js
 *
 * Each process gets a color-coded prefix in the terminal for easy debugging.
 * CTRL+C gracefully shuts down the entire cluster.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// Load coordinator .env into root process so child processes inherit env vars
try {
  const dotenv = require('dotenv');
  if (fs.existsSync(path.join(__dirname, 'coordinator', '.env'))) {
    dotenv.config({ path: path.join(__dirname, 'coordinator', '.env') });
  }
} catch (_) {}

// Ensure ENABLE_CHAOS defaults to 'true' so Chaos Lab and Resilience tests work seamlessly
if (!process.env.ENABLE_CHAOS) {
  process.env.ENABLE_CHAOS = 'true';
}

const RESET = '\x1b[0m';

const withClient = !process.argv.includes('--no-client');

const cluster = [
  { name: 'Coordinator', cwd: 'coordinator', cmd: 'node', args: ['index.js'],                                          color: '\x1b[36m' },
  { name: 'Node-1',      cwd: '.', cmd: 'node', args: ['storage-nodes/nodeService.js', '--id', 'node-1', '--port', '5001'], color: '\x1b[32m' },
  { name: 'Node-2',      cwd: '.', cmd: 'node', args: ['storage-nodes/nodeService.js', '--id', 'node-2', '--port', '5002'], color: '\x1b[33m' },
  { name: 'Node-3',      cwd: '.', cmd: 'node', args: ['storage-nodes/nodeService.js', '--id', 'node-3', '--port', '5003'], color: '\x1b[35m' },
  { name: 'Node-Backup', cwd: '.', cmd: 'node', args: ['storage-nodes/nodeService.js', '--id', 'node-backup', '--port', '5004'], color: '\x1b[95m' },
];

if (withClient) {
  cluster.push({
    name: 'Frontend',
    cwd: 'client',
    cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['run', 'dev'],
    color: '\x1b[34m',
  });
}

console.log('\x1b[1m\n  ╔══════════════════════════════════════╗');
console.log('  ║   NodeVault Distributed Cluster      ║');
console.log('  ╚══════════════════════════════════════╝\x1b[0m\n');

const children = [];

for (const proc of cluster) {
  const child = spawn(proc.cmd, proc.args, {
    cwd: path.join(__dirname, proc.cwd),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  const prefix = `${proc.color}[${proc.name}]${RESET}`;

  child.stdout.on('data', (data) => {
    data.toString().trim().split('\n').forEach(line => console.log(`${prefix} ${line}`));
  });

  child.stderr.on('data', (data) => {
    data.toString().trim().split('\n').forEach(line => console.error(`${prefix} ${line}`));
  });

  child.on('exit', (code) => {
    console.log(`${prefix} exited (code ${code})`);
  });

  children.push(child);
}

function killChild(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      const { execSync } = require('node:child_process');
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    } catch (_) {
      try { child.kill('SIGTERM'); } catch (__) {}
    }
  } else {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\x1b[1m[NodeVault] Shutting down cluster...\x1b[0m');
  children.forEach(killChild);
  process.exit(0);
});

// Windows CTRL+C handler
if (process.platform === 'win32') {
  process.on('SIGBREAK', () => {
    children.forEach(killChild);
    process.exit(0);
  });
}
