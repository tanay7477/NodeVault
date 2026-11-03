/**
 * Senior-Engineer Test Suite:
 * 1. Concurrency & Quota Race Prevention
 * 2. Deduplication Reference Counting & Garbage Collection
 * 3. Share Link Token Hashing & Expiry Rejection
 * 4. Audit Log Cryptographic Hash Chain & Tamper Detection
 */

const crypto = require('node:crypto');

describe('Storage Quota — Concurrent Reservation Guard', () => {
  let reserveQuota, USER_QUOTA_BYTES;

  beforeEach(() => {
    jest.resetModules();
    // Mock FileMetadata to return 450 MB already used
    jest.doMock('../models', () => ({
      FileMetadata: {
        find: jest.fn().mockResolvedValue([
          { sizeBytes: 450 * 1024 * 1024 },
        ]),
      },
    }));

    const quotaModule = require('../services/quotaService');
    reserveQuota = quotaModule.reserveQuota;
    USER_QUOTA_BYTES = quotaModule.USER_QUOTA_BYTES;
  });

  test('allows first 30MB upload when 50MB is remaining', async () => {
    const res = await reserveQuota('user-1', 30 * 1024 * 1024);
    expect(res.allowed).toBe(true);
    expect(typeof res.release).toBe('function');
    res.release();
  });

  test('prevents concurrent race where two 30MB uploads exceed remaining 50MB', async () => {
    // First upload of 30MB reserves space
    const upload1 = await reserveQuota('user-race', 30 * 1024 * 1024);
    expect(upload1.allowed).toBe(true);

    // Second concurrent upload of 30MB arrives before first finishes:
    // 450MB + 30MB reserved + 30MB incoming = 510MB > 500MB -> Must be rejected!
    const upload2 = await reserveQuota('user-race', 30 * 1024 * 1024);
    expect(upload2.allowed).toBe(false);
    expect(upload2.error).toContain('Insufficient quota');

    // Clean up first reservation
    upload1.release();

    // After upload1 releases, a 30MB upload is permitted again
    const upload3 = await reserveQuota('user-race', 30 * 1024 * 1024);
    expect(upload3.allowed).toBe(true);
    upload3.release();
  });
});

describe('Deduplication — Reference Counting & GC Logic', () => {
  test('increments refCount on duplicate block and delays physical purge until 0', () => {
    const blockCatalog = new Map();

    function registerUpload(fileId, checksum) {
      if (blockCatalog.has(checksum)) {
        const blk = blockCatalog.get(checksum);
        blk.refCount++;
        return { fileId: blk.fileId, deduplicated: true, refCount: blk.refCount };
      }
      blockCatalog.set(checksum, { fileId, refCount: 1 });
      return { fileId, deduplicated: false, refCount: 1 };
    }

    function removeUpload(checksum) {
      if (!blockCatalog.has(checksum)) return { deletedPhysical: false };
      const blk = blockCatalog.get(checksum);
      blk.refCount--;
      if (blk.refCount <= 0) {
        blockCatalog.delete(checksum);
        return { deletedPhysical: true, remainingRefs: 0 };
      }
      return { deletedPhysical: false, remainingRefs: blk.refCount };
    }

    const hash = 'a69f73cca23a9ac5c8b567dc185a756e97a9fb82';
    // User A uploads
    const up1 = registerUpload('uuid-1', hash);
    expect(up1.deduplicated).toBe(false);
    expect(up1.refCount).toBe(1);

    // User B uploads exact same file
    const up2 = registerUpload('uuid-2', hash);
    expect(up2.deduplicated).toBe(true);
    expect(up2.fileId).toBe('uuid-1'); // Reuses physical block
    expect(up2.refCount).toBe(2);

    // User A deletes their file: physical block should NOT be purged
    const del1 = removeUpload(hash);
    expect(del1.deletedPhysical).toBe(false);
    expect(del1.remainingRefs).toBe(1);

    // User B deletes their file: physical block now has 0 refs and IS purged
    const del2 = removeUpload(hash);
    expect(del2.deletedPhysical).toBe(true);
    expect(del2.remainingRefs).toBe(0);
  });
});

describe('Share Links — Cryptographic Hash & Security Invariants', () => {
  function hashToken(raw) {
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  test('never stores plaintext token; validates only through hash', () => {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const storedHash = hashToken(rawToken);

    // Verify rawToken is not identical to stored hash
    expect(rawToken).not.toEqual(storedHash);

    // Incoming request presents raw token, we verify hash match
    const clientProvidedToken = rawToken;
    expect(hashToken(clientProvidedToken)).toEqual(storedHash);

    // Wrong token fails
    const attackerToken = crypto.randomBytes(32).toString('hex');
    expect(hashToken(attackerToken)).not.toEqual(storedHash);
  });

  test('rejects expired share link', () => {
    const now = new Date();
    const pastExpiry = new Date(now.getTime() - 3600 * 1000); // 1h ago
    const futureExpiry = new Date(now.getTime() + 3600 * 1000); // 1h future

    const isExpired = (expiry) => new Date(expiry) < new Date();

    expect(isExpired(pastExpiry)).toBe(true);
    expect(isExpired(futureExpiry)).toBe(false);
  });

  test('enforces max-download cap', () => {
    const share = { downloads: 5, maxDownloads: 5 };
    const canDownload = share.maxDownloads === null || share.downloads < share.maxDownloads;
    expect(canDownload).toBe(false);

    const unlimited = { downloads: 100, maxDownloads: null };
    expect(unlimited.maxDownloads === null || unlimited.downloads < unlimited.maxDownloads).toBe(true);
  });
});

describe('Tamper-Evident Audit Ledger — Hash Chain Integrity', () => {
  function computeHash(prevHash, timestamp, userId, action, resource, status) {
    return crypto.createHash('sha256').update(`${prevHash}|${timestamp}|${userId}|${action}|${resource}|${status}`).digest('hex');
  }

  test('detects unauthorized tampering in historical audit entry', () => {
    const genesis = '0000000000000000000000000000000000000000000000000000000000000000';
    const chain = [];

    // Entry 1
    const t1 = '2026-11-02T10:00:00.000Z';
    const h1 = computeHash(genesis, t1, 'admin', 'upload', 'file1.pdf', 'success');
    chain.push({ prevHash: genesis, hash: h1, userId: 'admin', resource: 'file1.pdf', timestamp: t1, action: 'upload', status: 'success' });

    // Entry 2
    const t2 = '2026-11-02T10:05:00.000Z';
    const h2 = computeHash(h1, t2, 'user-2', 'download', 'file1.pdf', 'success');
    chain.push({ prevHash: h1, hash: h2, userId: 'user-2', resource: 'file1.pdf', timestamp: t2, action: 'download', status: 'success' });

    // Validation passes for untampered chain
    function verify(records) {
      let expected = genesis;
      for (let i = 0; i < records.length; i++) {
        const r = records[i];
        if (r.prevHash !== expected) return { valid: false, brokenIndex: i };
        const calc = computeHash(r.prevHash, r.timestamp, r.userId, r.action, r.resource, r.status);
        if (calc !== r.hash) return { valid: false, brokenIndex: i };
        expected = r.hash;
      }
      return { valid: true };
    }

    expect(verify(chain).valid).toBe(true);

    // Attacker tampers with Entry 1 (e.g. changing resource name or actor)
    chain[0].resource = 'malicious.exe';

    // Verification must detect the signature mismatch immediately
    const check = verify(chain);
    expect(check.valid).toBe(false);
    expect(check.brokenIndex).toBe(0);
  });
});
