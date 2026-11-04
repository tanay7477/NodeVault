/**
 * Thin API client for the NodeVault coordinator.
 * All methods return { data, error } — no thrown exceptions in calling code.
 */

const API_BASE = import.meta.env.VITE_API_URL || '/api';

export function getToken()       { return localStorage.getItem('nodevault_token'); }
function setToken(t)      { localStorage.setItem('nodevault_token', t); }
function clearToken()     { localStorage.removeItem('nodevault_token'); }
function getUser()        { const r = localStorage.getItem('nodevault_user'); return r ? JSON.parse(r) : null; }
function setUser(u)       { localStorage.setItem('nodevault_user', JSON.stringify(u)); }
function clearUser()      { localStorage.removeItem('nodevault_user'); }

async function request(path, opts = {}) {
  const headers = { ...opts.headers };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  if (!(opts.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
    if (res.status === 401) {
      clearToken(); clearUser();
      window.location.href = '/login';
      return { data: null, error: 'Session expired' };
    }
    if (opts.rawResponse) return { data: res, error: null };
    const data = await res.json();
    if (!res.ok) return { data: null, error: data.error || 'Request failed' };
    return { data, error: null };
  } catch (err) {
    return { data: null, error: err.message };
  }
}

// ─── Auth ────────────────────────────────────────────────
export async function login(email, password) {
  const { data, error } = await request('/auth/login', {
    method: 'POST', body: JSON.stringify({ email, password }),
  });
  if (data) { setToken(data.token); setUser(data.user); }
  return { data, error };
}

export async function register(name, email, password) {
  const { data, error } = await request('/auth/register', {
    method: 'POST', body: JSON.stringify({ name, email, password }),
  });
  if (data) { setToken(data.token); setUser(data.user); }
  return { data, error };
}

export function logout()          { clearToken(); clearUser(); }
export function isAuthenticated() { return !!getToken(); }
export function getRole()         { const u = getUser(); return u?.role || 'user'; }
export function isAdmin()         { return getRole() === 'admin'; }
export { getUser };

// ─── Files ───────────────────────────────────────────────
export async function uploadFile(file, onProgress, importance = 'normal') {
  const formData = new FormData();
  formData.append('file', file);
  if (importance) formData.append('importance', importance);

  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const token = getToken();
    xhr.open('POST', `${API_BASE}/files/upload`);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve({ data, error: null });
        else resolve({ data: null, error: data.error || 'Upload failed' });
      } catch { resolve({ data: null, error: 'Upload failed' }); }
    };
    xhr.onerror = () => resolve({ data: null, error: 'Network error' });
    xhr.send(formData);
  });
}

export async function listFiles()         { return request('/files'); }
export async function listTrash()         { return request('/files/trash'); }
export async function restoreFile(fileId) { return request(`/files/${fileId}/restore`, { method: 'POST' }); }
export async function restoreBackupVault(fileId) { return request(`/files/${fileId}/restore-backup`, { method: 'POST' }); }
export async function updateFileImportance(fileId, importance) {
  return request(`/files/${fileId}/importance`, {
    method: 'PATCH',
    body: JSON.stringify({ importance }),
  });
}
export async function getUserQuota()      { return request('/files/quota'); }

export async function downloadFile(fileId, fileName) {
  const token = getToken();
  try {
    const res = await fetch(`${API_BASE}/files/${fileId}/download`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
      const err = await res.json();
      return { error: err.error, servedFrom: null, failover: false };
    }
    const servedFrom = res.headers.get('X-Served-From');
    const failover   = res.headers.get('X-Failover') === 'true';
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = fileName; a.click();
    URL.revokeObjectURL(url);
    return { error: null, servedFrom, failover };
  } catch (err) {
    return { error: err.message, servedFrom: null, failover: false };
  }
}

export async function deleteFile(fileId, confirmName = '') {
  return request(`/files/${fileId}`, {
    method: 'DELETE',
    body: JSON.stringify({ confirmName }),
  });
}
export async function verifyFileIntegrity(fileId) { return request(`/files/${fileId}/verify`); }

// ─── Cluster & Telemetry ─────────────────────────────────
export async function getClusterStatus()             { return request('/cluster/status'); }
export async function getClusterStats()              { return request('/stats'); }
export async function getMetrics()                   { return request('/metrics'); }
export async function toggleNode(nodeId, action) {
  return request(`/cluster/nodes/${nodeId}/toggle`, {
    method: 'POST', body: JSON.stringify({ action }),
  });
}
export async function runScrubber(fileId = null) {
  return request('/cluster/scrub', {
    method: 'POST',
    body: fileId ? JSON.stringify({ fileId }) : undefined,
  });
}
export async function triggerRepair() {
  return request('/cluster/repair', { method: 'POST' });
}
export async function triggerBackupSync() {
  return request('/cluster/sync-backup', { method: 'POST' });
}
export async function injectCorruption(fileId, nodeId) {
  return request('/cluster/corrupt', {
    method: 'POST',
    body: JSON.stringify({ fileId, nodeId }),
  });
}

// ─── Audit Log ───────────────────────────────────────────
export async function getAuditLog(page = 1, limit = 50, filters = {}) {
  const params = new URLSearchParams({ page, limit });
  if (filters.action && filters.action !== 'all') params.set('action', filters.action);
  if (filters.status && filters.status !== 'all') params.set('status', filters.status);
  if (filters.q) params.set('q', filters.q);
  if (filters.scope) params.set('scope', filters.scope);
  return request(`/audit?${params.toString()}`);
}

export async function verifyAuditChain() {
  return request('/audit/verify');
}

export async function downloadAuditExport(format = 'json') {
  const token = getToken();
  try {
    const res = await fetch(`${API_BASE}/audit/export?format=${format}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nodevault-audit-trail.${format}`;
    a.click();
    URL.revokeObjectURL(url);
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
}

// ─── File Sharing ─────────────────────────────────────────
export async function createShareLink(fileId, expiryHours = 24, maxDownloads = null) {
  return request(`/share/files/${fileId}/share`, {
    method: 'POST',
    body: JSON.stringify({ expiryHours, maxDownloads }),
  });
}
export async function listShareLinks()               { return request('/share/my-links'); }
export async function revokeShareLink(shareId)       {
  return request(`/share/links/${shareId}`, { method: 'DELETE' });
}
export async function getShareInfo(token)            {
  return request(`/share/${token}/info`);
}

// ─── WebSocket Factory with Exponential Backoff & Jitter ────
export function createClusterSocket(onMessage, onStatusChange) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const defaultWsUrl = window.location.port === '5173'
    ? `${proto}//${window.location.hostname}:5000/ws`
    : `${proto}//${window.location.host}/ws`;
  const wsUrl = import.meta.env.VITE_WS_URL || defaultWsUrl;

  let ws = null;
  let attempts = 0;
  let closedManually = false;
  let reconnectTimer = null;

  const handle = {
    onopen: null,
    onclose: null,
    send: (data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(typeof data === 'string' ? data : JSON.stringify(data));
      }
    },
    close: () => {
      closedManually = true;
      clearTimeout(reconnectTimer);
      if (ws) ws.close();
      onStatusChange?.(false);
      handle.onclose?.();
    },
  };

  function connect() {
    if (closedManually) return;

    try {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        attempts = 0;
        onStatusChange?.(true);
        handle.onopen?.();
        // Request full state resync upon connection/reconnection
        try {
          ws.send(JSON.stringify({ type: 'resync' }));
        } catch {
          // Ignore resync error
        }
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type !== 'ping') {
            onMessage(msg);
          }
        } catch {
          // Ignore invalid message JSON
        }
      };

      ws.onclose = () => {
        onStatusChange?.(false);
        handle.onclose?.();
        if (!closedManually) {
          scheduleReconnect();
        }
      };

      ws.onerror = () => {
        onStatusChange?.(false);
        handle.onclose?.();
        ws?.close();
      };
    } catch {
      onStatusChange?.(false);
      handle.onclose?.();
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    attempts++;
    // Exponential backoff: min(30s, base * 2^attempts) + random jitter (0 to 1000ms)
    const delay = Math.min(30000, 1000 * Math.pow(1.5, attempts)) + Math.random() * 1000;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  }

  connect();

  return handle;
}

// ─── AI (Ask my files) ───────────────────────────────────
export async function askAI(question) {
  return request('/ai/ask', {
    method: 'POST',
    body: JSON.stringify({ question }),
  });
}

export async function getAIStatus() {
  return request('/ai/status');
}

