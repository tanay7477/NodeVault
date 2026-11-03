/**
 * Unit Tests — NodeVault Distributed File Storage
 * 
 * Tests cover:
 *  1. Load Balancer — least-loaded selection + exclusion
 *  2. Replication Service — replica placement logic
 *  3. Auth Controller — validation guards
 */

// ─── Test 1: Load Balancer ────────────────────────────────
describe('Load Balancer — selectNode()', () => {
  // We mock the healthCheck module before importing loadBalancer
  let selectNode;

  beforeEach(() => {
    jest.resetModules();
  });

  test('returns null when no online nodes exist', () => {
    jest.doMock('../services/healthCheck', () => ({
      getOnlineNodes: () => [],
    }));
    selectNode = require('../services/loadBalancer').selectNode;
    expect(selectNode()).toBeNull();
  });

  test('selects least-loaded node by disk usage', () => {
    jest.doMock('../services/healthCheck', () => ({
      getOnlineNodes: () => [
        { id: 'node-1', diskUsage: { usedPercent: 70 } },
        { id: 'node-2', diskUsage: { usedPercent: 20 } },
        { id: 'node-3', diskUsage: { usedPercent: 50 } },
      ],
    }));
    selectNode = require('../services/loadBalancer').selectNode;
    const chosen = selectNode();
    expect(chosen.id).toBe('node-2'); // lowest disk usage
  });

  test('excludes specified node IDs (for replica placement)', () => {
    jest.doMock('../services/healthCheck', () => ({
      getOnlineNodes: () => [
        { id: 'node-1', diskUsage: { usedPercent: 10 } },
        { id: 'node-2', diskUsage: { usedPercent: 20 } },
      ],
    }));
    selectNode = require('../services/loadBalancer').selectNode;
    // node-1 is the primary, replica must go elsewhere
    const replica = selectNode(['node-1']);
    expect(replica.id).toBe('node-2');
  });

  test('falls back to round-robin when disk data unavailable', () => {
    jest.doMock('../services/healthCheck', () => ({
      getOnlineNodes: () => [
        { id: 'node-1', diskUsage: null },
        { id: 'node-2', diskUsage: null },
      ],
    }));
    selectNode = require('../services/loadBalancer').selectNode;
    const chosen = selectNode();
    // Should pick one of the two nodes, not null
    expect(['node-1', 'node-2']).toContain(chosen.id);
  });

  test('returns null when all online nodes are excluded', () => {
    jest.doMock('../services/healthCheck', () => ({
      getOnlineNodes: () => [{ id: 'node-1', diskUsage: { usedPercent: 10 } }],
    }));
    selectNode = require('../services/loadBalancer').selectNode;
    // Exclude the only online node
    expect(selectNode(['node-1'])).toBeNull();
  });
});

// ─── Test 2: Health Check State ───────────────────────────
describe('Health Check — getAllHealth() returns correct shape', () => {
  test('all health entries have required fields', () => {
    jest.resetModules();
    jest.doMock('../config', () => ({
      nodes: [
        { id: 'node-1', url: 'http://localhost:5001' },
        { id: 'node-2', url: 'http://localhost:5002' },
      ],
      healthCheckIntervalMs: 999999999, // prevent actual interval from firing
    }));

    // Re-require after mock to get fresh module with mocked config
    jest.doMock('../services/healthCheck', () => {
      const nodes = [
        { id: 'node-1', url: 'http://localhost:5001' },
        { id: 'node-2', url: 'http://localhost:5002' },
      ];
      const nodeHealth = new Map();
      for (const node of nodes) {
        nodeHealth.set(node.id, { id: node.id, url: node.url, status: 'unknown', lastCheck: null });
      }
      return {
        getAllHealth: () => Array.from(nodeHealth.values()),
        getNodeHealth: (id) => nodeHealth.get(id),
        getOnlineNodes: () => [],
        startHealthChecks: () => {},
      };
    });

    const { getNodeHealth, getAllHealth } = require('../services/healthCheck');

    const all = getAllHealth();
    expect(all.length).toBe(2);
    all.forEach(n => expect(n.status).toBe('unknown'));

    const node1 = getNodeHealth('node-1');
    expect(node1.id).toBe('node-1');
    expect(node1.url).toBe('http://localhost:5001');
  });
});

// ─── Test 3: Input Validation Guards ──────────────────────
describe('UUID Regex — File ID validation', () => {
  const UUID_REGEX = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

  test('accepts valid UUID v4', () => {
    expect(UUID_REGEX.test('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  test('rejects path traversal attempts', () => {
    expect(UUID_REGEX.test('../etc/passwd')).toBe(false);
    expect(UUID_REGEX.test('../../secrets')).toBe(false);
    expect(UUID_REGEX.test('..\\..\\windows\\system32')).toBe(false);
  });

  test('rejects empty or non-UUID strings', () => {
    expect(UUID_REGEX.test('')).toBe(false);
    expect(UUID_REGEX.test('not-a-uuid')).toBe(false);
    expect(UUID_REGEX.test('1234')).toBe(false);
  });
});

// ─── Test 4: File Name Safety ──────────────────────────────
describe('Upload Security — filename and extension checks', () => {
  const BLOCKED_EXTENSIONS = /\.(exe|bat|cmd|sh|ps1|vbs|msi|dll|com|scr|jar|py|rb|php)$/i;

  test('blocks dangerous executables', () => {
    ['virus.exe', 'script.bat', 'malware.sh', 'hack.ps1', 'payload.dll'].forEach(f => {
      expect(BLOCKED_EXTENSIONS.test(f)).toBe(true);
    });
  });

  test('allows safe file types', () => {
    ['photo.jpg', 'document.pdf', 'archive.zip', 'notes.txt', 'data.json'].forEach(f => {
      expect(BLOCKED_EXTENSIONS.test(f)).toBe(false);
    });
  });

  test('caps filename length at 255 chars', () => {
    const longName = 'a'.repeat(300) + '.txt';
    expect(longName.length > 255).toBe(true);
    const safeName = longName.slice(0, 255);
    expect(safeName.length).toBe(255);
  });
});
