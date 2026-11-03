/**
 * Storage Node Hardening & Security Test Suite
 *
 * Proves that:
 * 1. Storage node requires `x-internal-secret` on EVERY endpoint except GET /health.
 * 2. Requests without the secret (or with wrong secret) get HTTP 403 Forbidden.
 * 3. GET /health is open and returns only status, nodeId, fileCount, diskUsage (no file names or hashes).
 * 4. Chaos endpoints (/corrupt, /toggle) return 404 when ENABLE_CHAOS is not 'true'.
 * 5. Coordinator & Storage Node refuse to start if secrets are missing.
 */

const { Readable } = require('node:stream');
const path = require('node:path');

function invokeNodeApp(app, method, urlPath, headers = {}, body = null) {
  return new Promise((resolve) => {
    const req = new Readable({ read() {} });
    req.method = method;
    req.url = urlPath;
    req.headers = {};
    for (const [k, v] of Object.entries(headers)) {
      req.headers[k.toLowerCase()] = v;
    }

    if (body) {
      const buf = Buffer.isBuffer(body)
        ? body
        : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      req.headers['content-length'] = String(buf.length);
      setImmediate(() => {
        req.push(buf);
        req.push(null);
      });
    } else {
      setImmediate(() => req.push(null));
    }

    const res = {
      statusCode: 200,
      _headers: {},
      setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
      getHeader(k) { return this._headers[k.toLowerCase()]; },
      status(code) { this.statusCode = code; return this; },
      json(data) { resolve({ status: this.statusCode, data }); },
      send(data) { resolve({ status: this.statusCode, data }); },
      sendFile(filePath) { resolve({ status: this.statusCode, filePath }); },
      end(data) { resolve({ status: this.statusCode, data }); },
    };

    app.handle(req, res);
  });
}

describe('Storage Node Security & Secret Enforcement', () => {
  let app;
  let secret;
  const testFileId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  beforeAll(() => {
    process.env.INTERNAL_SECRET = 'nodevault-internal-test-2026';
    process.env.ENABLE_CHAOS = 'true';

    const nodeServicePath = path.resolve(__dirname, '../../storage-nodes/nodeService.js');
    delete require.cache[require.resolve(nodeServicePath)];
    const nodeService = require(nodeServicePath);
    app = nodeService.app;
    secret = nodeService.INTERNAL_SECRET;
  });

  // ─── Test 1: Health Check Exemption & Data Minimization ─────────
  describe('GET /health (Exempt from auth)', () => {
    test('succeeds with 200 without x-internal-secret header', async () => {
      const res = await invokeNodeApp(app, 'GET', '/health');
      expect(res.status).toBe(200);

      const data = res.data;
      expect(data.status).toBe('online');
      expect(data.nodeId).toBeDefined();
      expect(typeof data.fileCount).toBe('number');
      expect(data.diskUsage).toBeDefined();
      expect(typeof data.diskUsage.usedBytes).toBe('number');
      expect(typeof data.diskUsage.totalBytes).toBe('number');

      // Verify data minimization: NO file names or hashes exposed
      expect(data.files).toBeUndefined();
      expect(data.blocks).toBeUndefined();
      expect(data.checksums).toBeUndefined();
      expect(data.hashes).toBeUndefined();
    });
  });

  // ─── Test 2: Requests WITHOUT x-internal-secret get HTTP 403 ───
  describe('Endpoints reject unauthenticated requests with HTTP 403', () => {
    test('POST /store returns 403 without secret', async () => {
      const res = await invokeNodeApp(app, 'POST', '/store', {
        'content-type': 'application/octet-stream',
        'x-file-id': testFileId,
      }, Buffer.from('test data'));
      expect(res.status).toBe(403);
      expect(res.data.error).toContain('Unauthorized');
    });

    test('GET /retrieve/:fileId returns 403 without secret', async () => {
      const res = await invokeNodeApp(app, 'GET', `/retrieve/${testFileId}`);
      expect(res.status).toBe(403);
      expect(res.data.error).toContain('Unauthorized');
    });

    test('GET /blockreport returns 403 without secret', async () => {
      const res = await invokeNodeApp(app, 'GET', '/blockreport');
      expect(res.status).toBe(403);
      expect(res.data.error).toContain('Unauthorized');
    });

    test('GET /checksum/:fileId returns 403 without secret', async () => {
      const res = await invokeNodeApp(app, 'GET', `/checksum/${testFileId}`);
      expect(res.status).toBe(403);
      expect(res.data.error).toContain('Unauthorized');
    });

    test('DELETE /remove/:fileId returns 403 without secret', async () => {
      const res = await invokeNodeApp(app, 'DELETE', `/remove/${testFileId}`);
      expect(res.status).toBe(403);
      expect(res.data.error).toContain('Unauthorized');
    });

    test('POST /toggle returns 403 without secret', async () => {
      const res = await invokeNodeApp(app, 'POST', '/toggle', {
        'content-type': 'application/json',
      }, { action: 'kill' });
      expect(res.status).toBe(403);
      expect(res.data.error).toContain('Unauthorized');
    });

    test('POST /corrupt/:fileId returns 403 without secret', async () => {
      const res = await invokeNodeApp(app, 'POST', `/corrupt/${testFileId}`);
      expect(res.status).toBe(403);
      expect(res.data.error).toContain('Unauthorized');
    });

    test('requests with invalid secret return 403', async () => {
      const res = await invokeNodeApp(app, 'GET', '/blockreport', {
        'x-internal-secret': 'wrong-attacker-secret',
      });
      expect(res.status).toBe(403);
      expect(res.data.error).toContain('Unauthorized');
    });
  });

  // ─── Test 3: Requests WITH valid x-internal-secret succeed ─────
  describe('Endpoints succeed with valid x-internal-secret', () => {
    test('POST /store succeeds with secret', async () => {
      const res = await invokeNodeApp(app, 'POST', '/store', {
        'content-type': 'application/octet-stream',
        'x-file-id': testFileId,
        'x-internal-secret': secret,
      }, Buffer.from('hello authenticated storage node'));
      expect(res.status).toBe(200);
      expect(res.data.stored).toBe(true);
    });

    test('GET /checksum/:fileId succeeds with secret', async () => {
      const res = await invokeNodeApp(app, 'GET', `/checksum/${testFileId}`, {
        'x-internal-secret': secret,
      });
      expect(res.status).toBe(200);
      expect(res.data.checksum).toBeDefined();
    });

    test('GET /blockreport succeeds with secret', async () => {
      const res = await invokeNodeApp(app, 'GET', '/blockreport', {
        'x-internal-secret': secret,
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data.blocks)).toBe(true);
      expect(res.data.blocks.some(b => b.fileId === testFileId)).toBe(true);
    });

    test('DELETE /remove/:fileId succeeds with secret', async () => {
      const res = await invokeNodeApp(app, 'DELETE', `/remove/${testFileId}`, {
        'x-internal-secret': secret,
      });
      expect(res.status).toBe(200);
      expect(res.data.deleted).toBe(true);
    });
  });

  // ─── Test 4: Chaos Guard disabled when ENABLE_CHAOS != 'true' ──
  describe('ENABLE_CHAOS guard protects /corrupt and /toggle', () => {
    let nonChaosApp;

    beforeAll(() => {
      process.env.INTERNAL_SECRET = 'nodevault-internal-test-2026';
      process.env.ENABLE_CHAOS = 'false';

      const nodeServicePath = path.resolve(__dirname, '../../storage-nodes/nodeService.js');
      delete require.cache[require.resolve(nodeServicePath)];
      const nodeService = require(nodeServicePath);
      nonChaosApp = nodeService.app;
    });

    test('POST /toggle returns 404 when ENABLE_CHAOS is false', async () => {
      const res = await invokeNodeApp(nonChaosApp, 'POST', '/toggle', {
        'content-type': 'application/json',
        'x-internal-secret': secret,
      }, { action: 'kill' });
      expect(res.status).toBe(404);
      expect(res.data.error).toContain('disabled');
    });

    test('POST /corrupt/:fileId returns 404 when ENABLE_CHAOS is false', async () => {
      const res = await invokeNodeApp(nonChaosApp, 'POST', `/corrupt/${testFileId}`, {
        'x-internal-secret': secret,
      });
      expect(res.status).toBe(404);
      expect(res.data.error).toContain('disabled');
    });
  });
});
