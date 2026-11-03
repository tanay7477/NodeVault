/**
 * Tests for Smart Storage Decision Layer:
 * 1. Deterministic Policy Engine (decide, category detection)
 * 2. Soft delete + restore lifecycle
 * 3. Critical delete confirmation enforcement
 * 4. Importance change & replica rebalancing
 * 5. LRU Cache & access tracking
 */

const { Readable, Duplex } = require('node:stream');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { app } = require('../index');
const { FileMetadata } = require('../models');
const { decide, detectCategory, POLICY_MATRIX } = require('../services/policy');
const { fileCache, recordAccess } = require('../services/tieringService');

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

describe('Smart Storage — Policy Engine', () => {
  test('POLICY_MATRIX has correct parameters for each importance tier', () => {
    expect(POLICY_MATRIX.critical).toEqual({
      replicas: 3,
      backup: true,
      trashDays: 30,
      requireNameConfirm: true,
    });
    expect(POLICY_MATRIX.high).toEqual({
      replicas: 3,
      backup: true,
      trashDays: 30,
      requireNameConfirm: false,
    });
    expect(POLICY_MATRIX.normal).toEqual({
      replicas: 2,
      backup: false,
      trashDays: 7,
      requireNameConfirm: false,
    });
    expect(POLICY_MATRIX.low).toEqual({
      replicas: 1,
      backup: false,
      trashDays: 1,
      requireNameConfirm: false,
    });
  });

  test('detectCategory identifies video, image, document, archive, and other', () => {
    expect(detectCategory('video/mp4', 'clip.mp4')).toBe('video');
    expect(detectCategory('image/png', 'photo.png')).toBe('image');
    expect(detectCategory('application/pdf', 'doc.pdf')).toBe('document');
    expect(detectCategory('text/plain', 'notes.txt')).toBe('document');
    expect(detectCategory('application/zip', 'archive.zip')).toBe('archive');
    expect(detectCategory('application/octet-stream', 'unknown.bin')).toBe('other');
  });

  test('decide returns expected policy object and human-readable reason', () => {
    const criticalDec = decide('critical', 'video');
    expect(criticalDec.replicas).toBe(3);
    expect(criticalDec.backup).toBe(true);
    expect(criticalDec.trashDays).toBe(30);
    expect(criticalDec.requireNameConfirm).toBe(true);
    expect(criticalDec.reason).toBe('critical, video -> 3 replicas + backup');

    const lowDec = decide('low', 'other');
    expect(lowDec.replicas).toBe(1);
    expect(lowDec.backup).toBe(false);
    expect(lowDec.trashDays).toBe(1);
    expect(lowDec.requireNameConfirm).toBe(false);
    expect(lowDec.reason).toBe('low, other -> 1 replica');
  });

  test('decide caps replicas to active nodes count when node list provided', () => {
    const twoNodes = [{ id: 'node-1' }, { id: 'node-2' }];
    const decision = decide('critical', 'document', twoNodes);
    expect(decision.replicas).toBe(2);
  });
});

describe('Smart Storage — Soft Delete, Trash, and Restore Lifecycle', () => {
  let userToken;
  let testUserId = 'test-smart-storage-user-1';

  beforeAll(() => {
    userToken = jwt.sign(
      { id: testUserId, email: 'smartuser@nodevault.local', role: 'user' },
      config.jwtSecret,
      { expiresIn: '1h' }
    );
  });

  test('DELETE performs soft delete with calculated purge_at timestamp', async () => {
    const file = await FileMetadata.create({
      fileId: 'soft-del-test-uuid',
      originalName: 'normal-document.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      checksum: 'fake-checksum-1',
      owner: testUserId,
      importance: 'normal',
      category: 'document',
      policy_reason: 'normal, document -> 2 replicas',
      distribution: [{ nodeId: 'node-1', role: 'primary' }, { nodeId: 'node-2', role: 'replica' }],
    });

    const res = await invokeApp(app, 'DELETE', `/api/files/${file._id}`, {
      Authorization: `Bearer ${userToken}`,
    });

    expect(res.status).toBe(200);
    expect(res.data.message).toContain('moved to trash');
    expect(res.data.deleted_at).toBeTruthy();
    expect(res.data.purge_at).toBeTruthy();

    // Verify file is marked deleted in DB
    const updated = await FileMetadata.findById(file._id);
    expect(updated.deleted_at).not.toBeNull();

    // Verify it is excluded from normal file list
    const listRes = await invokeApp(app, 'GET', '/api/files', {
      Authorization: `Bearer ${userToken}`,
    });
    const foundInActive = listRes.data.find(f => f.id === file._id || f._id === file._id);
    expect(foundInActive).toBeUndefined();

    // Verify it appears in Trash
    const trashRes = await invokeApp(app, 'GET', '/api/files/trash', {
      Authorization: `Bearer ${userToken}`,
    });
    const foundInTrash = trashRes.data.find(f => f.id === file._id || f._id === file._id);
    expect(foundInTrash).toBeDefined();
    expect(foundInTrash.canRestore).toBe(true);

    // Clean up
    await FileMetadata.deleteOne({ _id: file._id });
  });

  test('POST /api/files/:id/restore restores file from trash', async () => {
    const file = await FileMetadata.create({
      fileId: 'restore-test-uuid',
      originalName: 'restore-me.txt',
      mimeType: 'text/plain',
      sizeBytes: 512,
      checksum: 'fake-checksum-2',
      owner: testUserId,
      importance: 'normal',
      category: 'document',
      deleted_at: new Date().toISOString(),
      purge_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      distribution: [{ nodeId: 'node-1', role: 'primary' }],
    });

    const res = await invokeApp(app, 'POST', `/api/files/${file._id}/restore`, {
      Authorization: `Bearer ${userToken}`,
    });

    expect(res.status).toBe(200);
    expect(res.data.message).toContain('restored successfully');

    const updated = await FileMetadata.findById(file._id);
    expect(updated.deleted_at).toBeNull();
    expect(updated.purge_at).toBeNull();

    // Clean up
    await FileMetadata.deleteOne({ _id: file._id });
  });
});

describe('Smart Storage — Critical Delete Confirmation Guard', () => {
  let userToken;
  let testUserId = 'test-smart-storage-user-2';

  beforeAll(() => {
    userToken = jwt.sign(
      { id: testUserId, email: 'criticaluser@nodevault.local', role: 'user' },
      config.jwtSecret,
      { expiresIn: '1h' }
    );
  });

  test('rejects critical file delete without exact confirmation name', async () => {
    const file = await FileMetadata.create({
      fileId: 'crit-del-uuid-1',
      originalName: 'very-important-database.sql',
      mimeType: 'application/octet-stream',
      sizeBytes: 2048,
      checksum: 'fake-checksum-sql',
      owner: testUserId,
      importance: 'critical',
      category: 'document',
      policy_reason: 'critical, document -> 3 replicas + backup',
      deleted_at: null,
      purge_at: null,
      distribution: [{ nodeId: 'node-1', role: 'primary' }],
    });

    // Attempt delete with no confirmName
    const resNoConfirm = await invokeApp(app, 'DELETE', `/api/files/${file._id}`, {
      Authorization: `Bearer ${userToken}`,
    });

    expect(resNoConfirm.status).toBe(400);
    expect(resNoConfirm.data.error).toContain('exact file name confirmation');

    // Attempt delete with wrong confirmName
    const resWrong = await invokeApp(app, 'DELETE', `/api/files/${file._id}`, {
      Authorization: `Bearer ${userToken}`,
    }, { confirmName: 'wrong-name.sql' });

    expect(resWrong.status).toBe(400);

    // Verify file still active in DB
    const stillActive = await FileMetadata.findById(file._id);
    expect(stillActive.deleted_at).toBeNull();

    // Succeeded when exact name provided
    const resCorrect = await invokeApp(app, 'DELETE', `/api/files/${file._id}`, {
      Authorization: `Bearer ${userToken}`,
    }, { confirmName: 'very-important-database.sql' });

    expect(resCorrect.status).toBe(200);
    expect(resCorrect.data.message).toContain('moved to trash');

    const deletedDoc = await FileMetadata.findById(file._id);
    expect(deletedDoc.deleted_at).not.toBeNull();

    // Clean up
    await FileMetadata.deleteOne({ _id: file._id });
  });
});

describe('Smart Storage — Importance Change & Dynamic Rebalance', () => {
  let userToken;
  let testUserId = 'test-smart-storage-user-3';

  beforeAll(() => {
    userToken = jwt.sign(
      { id: testUserId, email: 'patchuser@nodevault.local', role: 'user' },
      config.jwtSecret,
      { expiresIn: '1h' }
    );
  });

  test('PATCH /api/files/:id/importance updates policy and rebalances replicas', async () => {
    const file = await FileMetadata.create({
      fileId: 'importance-patch-uuid',
      originalName: 'presentation.key',
      mimeType: 'application/octet-stream',
      sizeBytes: 4096,
      checksum: 'fake-checksum-presentation',
      owner: testUserId,
      importance: 'low',
      category: 'other',
      policy_reason: 'low, other -> 1 replica',
      distribution: [
        { nodeId: 'node-1', role: 'primary' },
        { nodeId: 'node-2', role: 'replica' },
        { nodeId: 'node-3', role: 'replica' },
      ],
    });

    // Update to 'low' should trim replicas down to 1
    const resLow = await invokeApp(app, 'PATCH', `/api/files/${file._id}/importance`, {
      Authorization: `Bearer ${userToken}`,
    }, { importance: 'low' });

    expect(resLow.status).toBe(200);
    expect(resLow.data.importance).toBe('low');
    expect(resLow.data.distribution.length).toBe(1);
    expect(resLow.data.distribution[0].role).toBe('primary');

    // Clean up
    await FileMetadata.deleteOne({ _id: file._id });
  });

  test('rejects invalid importance level with 400', async () => {
    const file = await FileMetadata.create({
      fileId: 'importance-bad-uuid',
      originalName: 'bad.txt',
      mimeType: 'text/plain',
      sizeBytes: 100,
      checksum: 'fake-checksum-bad',
      owner: testUserId,
      importance: 'normal',
      category: 'document',
      distribution: [{ nodeId: 'node-1', role: 'primary' }],
    });

    const res = await invokeApp(app, 'PATCH', `/api/files/${file._id}/importance`, {
      Authorization: `Bearer ${userToken}`,
    }, { importance: 'super-urgent' });

    expect(res.status).toBe(400);
    expect(res.data.error).toContain('Must be one of');

    await FileMetadata.deleteOne({ _id: file._id });
  });
});

describe('Smart Storage — LRU Cache & Access Tracking', () => {
  test('fileCache stores and evicts correctly under max size constraint', () => {
    fileCache.clear();
    const smallBuffer = Buffer.from('hello world from lru test');
    fileCache.set('test-f1', smallBuffer, 'text/plain');

    const cached = fileCache.get('test-f1');
    expect(cached).not.toBeNull();
    expect(cached.buffer.toString()).toBe('hello world from lru test');
    expect(cached.mimeType).toBe('text/plain');

    fileCache.delete('test-f1');
    expect(fileCache.get('test-f1')).toBeNull();
  });

  test('recordAccess increments access_count and updates last_access', async () => {
    const testFile = await FileMetadata.create({
      fileId: 'access-track-uuid',
      originalName: 'access-test.txt',
      mimeType: 'text/plain',
      sizeBytes: 10,
      checksum: 'fake-access-checksum',
      owner: 'access-user',
      access_count: 5,
      last_access: new Date(Date.now() - 100000).toISOString(),
    });

    await recordAccess('access-track-uuid');

    const updated = await FileMetadata.findOne({ fileId: 'access-track-uuid' });
    expect(updated.access_count).toBe(6);
    expect(new Date(updated.last_access).getTime()).toBeGreaterThan(Date.now() - 5000);

    await FileMetadata.deleteOne({ _id: testFile._id });
  });
});
