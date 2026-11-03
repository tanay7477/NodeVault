/**
 * Role-Based Access Control (RBAC) Test Suite
 *
 * Requirements:
 * 1. Users get a `role` field: 'admin' or 'user' (default 'user').
 * 2. Existing users in coordinator/data/users.json migrated: admin@nodevault.local becomes 'admin', others 'user'.
 * 3. Role is included in the JWT token.
 * 4. User token gets 403 on /api/cluster/nodes/node-1/toggle; Admin token gets 200.
 * 5. Normal user gets 403 on admin-protected endpoints: scrub, repair, corrupt, repair-metrics, audit verify/export, stats.
 * 6. Normal users can view and manage their own files, quota, and share links.
 */

const jwt = require('jsonwebtoken');
const { Readable, Duplex } = require('node:stream');
const path = require('node:path');
const config = require('../config');
const { migrateUserRoles } = require('../migrations/migrateRoles');

function invokeApp(app, method, urlPath, headers = {}, body = null) {
  return new Promise((resolve) => {
    const req = new Readable({ read() {} });
    req.method = method;
    req.url = urlPath;
    req.headers = {};
    const socket = new Duplex({ read() {}, write(c, e, cb) { cb(); } });
    socket.remoteAddress = '127.0.0.1';
    req.socket = socket;
    req.connection = socket;
    req.ip = '127.0.0.1';
    for (const [k, v] of Object.entries(headers)) {
      req.headers[k.toLowerCase()] = v;
    }

    if (body) {
      const buf = Buffer.isBuffer(body)
        ? body
        : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      req.headers['content-length'] = String(buf.length);
      req.headers['content-type'] = req.headers['content-type'] || 'application/json';
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
      end(data) { resolve({ status: this.statusCode, data }); },
    };

    app.handle(req, res);
  });
}

describe('Role-Based Access Control (RBAC)', () => {
  let app;
  let adminToken;
  let userToken;

  beforeAll(() => {
    // Generate valid tokens for admin and regular user
    adminToken = jwt.sign(
      { id: 'admin-id-1', email: 'admin@nodevault.local', role: 'admin' },
      config.jwtSecret,
      { expiresIn: '1h' }
    );

    userToken = jwt.sign(
      { id: 'user-id-1', email: 'user@example.com', role: 'user' },
      config.jwtSecret,
      { expiresIn: '1h' }
    );

    const coordinatorModule = require('../index');
    app = coordinatorModule.app;
  });

  // ─── Test 1: Data Migration ─────────────────────────────────────
  describe('User role migration', () => {
    test('migrates admin@nodevault.local to admin and others to user', () => {
      const res = migrateUserRoles();
      expect(res).toBeDefined();

      const fs = require('node:fs');
      const usersPath = path.join(__dirname, '..', 'data', 'users.json');
      if (fs.existsSync(usersPath)) {
        const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
        const adminUser = users.find(u => u.email === 'admin@nodevault.local');
        expect(adminUser).toBeDefined();
        expect(adminUser.role).toBe('admin');

        const tanayAdmin = users.find(u => u.email === 'vyastanay67@gmail.com');
        if (tanayAdmin) {
          expect(tanayAdmin.role).toBe('admin');
        }

        const normalUsers = users.filter(u => u.email !== 'admin@nodevault.local' && u.email !== 'vyastanay67@gmail.com');
        for (const u of normalUsers) {
          expect(u.role).toBe('user');
        }
      }
    });
  });

  // ─── Test 2: Node Toggle RBAC Guard ────────────────────────────
  describe('POST /api/cluster/nodes/:nodeId/toggle', () => {
    test('user token gets 403 on /api/cluster/nodes/node-1/toggle', async () => {
      const res = await invokeApp(
        app,
        'POST',
        '/api/cluster/nodes/node-1/toggle',
        { Authorization: `Bearer ${userToken}` },
        { action: 'kill' }
      );

      expect(res.status).toBe(403);
      expect(res.data.error).toContain('Admin access required');
    });

    test('admin token gets 200 on /api/cluster/nodes/node-1/toggle', async () => {
      // Mock global fetch for storage node toggle
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ nodeId: 'node-1', killed: true }),
      });

      try {
        const res = await invokeApp(
          app,
          'POST',
          '/api/cluster/nodes/node-1/toggle',
          { Authorization: `Bearer ${adminToken}` },
          { action: 'kill' }
        );

        expect(res.status).toBe(200);
        expect(res.data.nodeId).toBe('node-1');
        expect(res.data.result.killed).toBe(true);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  // ─── Test 3: Other Admin-Only Endpoints ─────────────────────────
  describe('Admin-only endpoints return 403 for normal users', () => {
    test('POST /api/cluster/scrub returns 403 for user token', async () => {
      const res = await invokeApp(
        app,
        'POST',
        '/api/cluster/scrub',
        { Authorization: `Bearer ${userToken}` },
        {}
      );
      expect(res.status).toBe(403);
      expect(res.data.error).toContain('Admin access required');
    });

    test('POST /api/cluster/repair returns 403 for user token', async () => {
      const res = await invokeApp(
        app,
        'POST',
        '/api/cluster/repair',
        { Authorization: `Bearer ${userToken}` },
        {}
      );
      expect(res.status).toBe(403);
      expect(res.data.error).toContain('Admin access required');
    });

    test('POST /api/cluster/corrupt returns 403 for user token', async () => {
      const res = await invokeApp(
        app,
        'POST',
        '/api/cluster/corrupt',
        { Authorization: `Bearer ${userToken}` },
        { nodeId: 'node-1', fileId: 'test-uuid' }
      );
      expect(res.status).toBe(403);
      expect(res.data.error).toContain('Admin access required');
    });

    test('GET /api/cluster/repair-metrics returns 403 for user token', async () => {
      const res = await invokeApp(
        app,
        'GET',
        '/api/cluster/repair-metrics',
        { Authorization: `Bearer ${userToken}` }
      );
      expect(res.status).toBe(403);
      expect(res.data.error).toContain('Admin access required');
    });

    test('GET /api/cluster/status returns 403 for user token', async () => {
      const res = await invokeApp(
        app,
        'GET',
        '/api/cluster/status',
        { Authorization: `Bearer ${userToken}` }
      );
      expect(res.status).toBe(403);
      expect(res.data.error).toContain('Admin access required');
    });

    test('GET /api/audit/verify returns 403 for user token', async () => {
      const res = await invokeApp(
        app,
        'GET',
        '/api/audit/verify',
        { Authorization: `Bearer ${userToken}` }
      );
      expect(res.status).toBe(403);
      expect(res.data.error).toContain('Admin access required');
    });

    test('GET /api/audit/export returns 403 for user token', async () => {
      const res = await invokeApp(
        app,
        'GET',
        '/api/audit/export',
        { Authorization: `Bearer ${userToken}` }
      );
      expect(res.status).toBe(403);
      expect(res.data.error).toContain('Admin access required');
    });

    test('GET /api/stats returns 403 for user token', async () => {
      const res = await invokeApp(
        app,
        'GET',
        '/api/stats',
        { Authorization: `Bearer ${userToken}` }
      );
      expect(res.status).toBe(403);
      expect(res.data.error).toContain('Admin access required');
    });
  });

  // ─── Test 4: Normal Users Can Access Their Own Resources ───────
  describe('Normal users can access own files, quota, and share links', () => {
    test('GET /api/files/quota succeeds for normal user', async () => {
      const res = await invokeApp(
        app,
        'GET',
        '/api/files/quota',
        { Authorization: `Bearer ${userToken}` }
      );
      expect(res.status).toBe(200);
      expect(res.data.quotaBytes).toBeDefined();
    });

    test('GET /api/files succeeds for normal user', async () => {
      const res = await invokeApp(
        app,
        'GET',
        '/api/files',
        { Authorization: `Bearer ${userToken}` }
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data)).toBe(true);
    });

    test('GET /api/share/my-links succeeds for normal user', async () => {
      const res = await invokeApp(
        app,
        'GET',
        '/api/share/my-links',
        { Authorization: `Bearer ${userToken}` }
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data)).toBe(true);
    });
  });
});
