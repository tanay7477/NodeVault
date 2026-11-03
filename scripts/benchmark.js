/**
 * NodeVault Performance & Resilience Benchmark Suite
 *
 * Runs real end-to-end load tests against the running cluster:
 * 1. Sequential Write Latency (p50, p95, p99)
 * 2. Failover Read Latency (with active node failure)
 * 3. Deduplication Hit Latency
 *
 * Saves raw benchmark metrics to benchmarks/results.json
 */

const fs = require('node:fs');
const path = require('node:path');

const COORDINATOR_URL = process.env.COORDINATOR_URL || 'http://localhost:5000';

async function main() {
  console.log('====================================================');
  console.log('   NodeVault Cluster Benchmark & SLA Verification   ');
  console.log('====================================================');
  console.log(`Target: ${COORDINATOR_URL}`);
  console.log(`Node.js: ${process.version} | Platform: ${process.platform} ${process.arch}`);
  console.log('');

  // 1. Check health
  try {
    const healthRes = await fetch(`${COORDINATOR_URL}/api/health`);
    if (!healthRes.ok) throw new Error(`HTTP ${healthRes.status}`);
    console.log('[OK] Coordinator reachable.');
  } catch (err) {
    console.error(`[FAIL] Coordinator unreachable at ${COORDINATOR_URL}. Please start cluster with "npm start" first.`);
    process.exit(1);
  }

  // 2. Auth demo user
  const email = `bench-${Date.now()}@internal.net`;
  const pass = 'BenchmarkPass123!';
  let token = '';

  try {
    const regRes = await fetch(`${COORDINATOR_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Benchmarker', email, password: pass }),
    });
    const regData = await regRes.json();
    token = regData.token;
  } catch (err) {
    console.error('[FAIL] Auth registration failed:', err.message);
    process.exit(1);
  }

  const headers = { 'Authorization': `Bearer ${token}` };

  const os = require('node:os');
  const samples = parseInt(process.env.SAMPLES || '200', 10);
  console.log(`\n--- Running Commit Latency Benchmark (${samples} samples, 256 KB, 3 Replicas) ---`);
  const latencies = [];
  const testPayload = Buffer.alloc(256 * 1024, 'A'); // 256 KB buffer
  const createdFileIds = [];

  for (let i = 0; i < samples; i++) {
    const formData = new FormData();
    const blob = new Blob([testPayload], { type: 'application/octet-stream' });
    formData.append('file', blob, `bench-${i}.dat`);

    const t0 = performance.now();
    const res = await fetch(`${COORDINATOR_URL}/api/files/upload`, {
      method: 'POST',
      headers,
      body: formData,
    });
    const elapsed = Math.round(performance.now() - t0);

    if (res.ok) {
      const data = await res.json();
      latencies.push(elapsed);
      const fid = data.id || data.fileId;
      if (fid) createdFileIds.push(fid);
      if ((i + 1) % 25 === 0 || i === samples - 1) {
        process.stdout.write(`[${i + 1}/${samples}: ${elapsed}ms] `);
      }
    } else {
      console.error(`Sample ${i + 1} failed: HTTP ${res.status}`);
    }
  }

  latencies.sort((a, b) => a - b);
  const min = latencies[0] || 0;
  const max = latencies[latencies.length - 1] || 0;
  const avg = Math.round(latencies.reduce((s, x) => s + x, 0) / (latencies.length || 1));
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || max;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || max;

  console.log('\n\nCommit Latency Distribution:');
  console.log(`  Samples: ${latencies.length}`);
  console.log(`  Min: ${min} ms`);
  console.log(`  Avg: ${avg} ms`);
  console.log(`  p50: ${p50} ms`);
  console.log(`  p95: ${p95} ms`);
  console.log(`  p99: ${p99} ms`);
  console.log(`  Max: ${max} ms`);

  // 4. Deduplication Hit Test
  console.log('\n--- Running Deduplication Latency Test ---');
  const dedupForm = new FormData();
  const dedupBlob = new Blob([testPayload], { type: 'application/octet-stream' });
  dedupForm.append('file', dedupBlob, 'bench-dedup.dat');

  const tDedup0 = performance.now();
  const dedupRes = await fetch(`${COORDINATOR_URL}/api/files/upload`, {
    method: 'POST',
    headers,
    body: dedupForm,
  });
  const dedupElapsed = Math.round(performance.now() - tDedup0);
  const dedupData = await dedupRes.json();
  if (dedupData.id) createdFileIds.push(dedupData.id);

  console.log(`  Dedup Commit: ${dedupElapsed} ms (Hit: ${dedupData.deduplicated})`);

  // 5. Failover Read Test
  console.log('\n--- Running Fault Injection & Failover Read Test ---');
  console.log('  1. Terminating node-1...');
  await fetch(`${COORDINATOR_URL}/api/cluster/nodes/node-1/toggle`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'kill' }),
  });

  const testFileId = createdFileIds[0];
  console.log('  2. Reading file during active hardware outage...');
  const tRead0 = performance.now();
  const readRes = await fetch(`${COORDINATOR_URL}/api/files/${testFileId}/download`, { headers });
  const readElapsed = Math.round(performance.now() - tRead0);
  const servedFrom = readRes.headers.get('x-served-from');
  const failover = readRes.headers.get('x-failover');

  console.log(`  Failover Latency: ${readElapsed} ms (Served by: ${servedFrom}, Failover: ${failover})`);

  // Revive node-1
  await fetch(`${COORDINATOR_URL}/api/cluster/nodes/node-1/toggle`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'revive' }),
  });

  // 6. Clean up all benchmark files
  console.log('\n--- Teardown: Purging Benchmark Test Files ---');
  for (const fid of createdFileIds) {
    try {
      await fetch(`${COORDINATOR_URL}/api/files/${fid}`, {
        method: 'DELETE',
        headers,
      });
    } catch (_) {}
  }
  console.log(`  Purged ${createdFileIds.length} benchmark files.`);

  // Machine specifications
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model.trim() : 'Unknown CPU';
  const totalMemGb = Math.round((os.totalmem() / (1024 * 1024 * 1024)) * 10) / 10;

  const results = {
    timestamp: new Date().toISOString(),
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      osType: os.type(),
      osRelease: os.release(),
      cpu: cpuModel,
      cores: cpus.length,
      memoryGb: totalMemGb,
    },
    metrics: {
      samples: latencies.length,
      writeLatencyMs: { min, avg, p50, p95, p99, max },
      dedupLatencyMs: dedupElapsed,
      failoverReadLatencyMs: readElapsed,
      failoverNode: servedFrom,
    },
  };

  const outDir = path.join(__dirname, '..', 'benchmarks');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));

  console.log(`\n[SUCCESS] Raw results and machine specs saved to benchmarks/results.json`);
}

main().catch(console.error);
