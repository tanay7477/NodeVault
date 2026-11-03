/**
 * Deterministic Smart Storage Policy Engine
 *
 * Maps (importance, category, cluster nodes) -> storage policies:
 * - replicas: number of active distributed copies
 * - backup: whether to store an isolated offline copy in the backup vault
 * - trashDays: days kept in soft-delete trash before purging
 * - requireNameConfirm: whether file deletion requires typing the exact file name
 * - reason: human-readable explanation
 */

const POLICY_MATRIX = {
  critical: { replicas: 3, backup: true,  trashDays: 30, requireNameConfirm: true },
  high:     { replicas: 3, backup: true,  trashDays: 30, requireNameConfirm: false },
  normal:   { replicas: 2, backup: false, trashDays: 7,  requireNameConfirm: false },
  low:      { replicas: 1, backup: false, trashDays: 1,  requireNameConfirm: false },
};

const VALID_IMPORTANCE = Object.keys(POLICY_MATRIX);

/**
 * Auto-detect category from MIME type or file extension.
 * Categories: video | image | document | archive | other
 */
function detectCategory(mimeType = '', fileName = '') {
  const mime = String(mimeType || '').toLowerCase();
  const name = String(fileName || '').toLowerCase();

  if (mime.startsWith('video/') || /\.(mp4|mkv|avi|mov|webm|flv|wmv|m4v)$/i.test(name)) {
    return 'video';
  }
  if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?)$/i.test(name)) {
    return 'image';
  }
  if (
    mime.startsWith('text/') ||
    mime === 'application/pdf' ||
    mime.includes('word') ||
    mime.includes('spreadsheet') ||
    mime.includes('presentation') ||
    mime.includes('json') ||
    mime.includes('xml') ||
    mime.includes('csv') ||
    /\.(pdf|txt|md|csv|json|log|doc|docx|xls|xlsx|ppt|pptx)$/i.test(name)
  ) {
    return 'document';
  }
  if (
    mime.includes('zip') ||
    mime.includes('tar') ||
    mime.includes('gzip') ||
    mime.includes('compressed') ||
    /\.(zip|tar|gz|7z|rar|bz2|xz)$/i.test(name)
  ) {
    return 'archive';
  }
  return 'other';
}

/**
 * Decide storage policy based on file importance and detected category.
 * @param {string} importance - 'critical' | 'high' | 'normal' | 'low'
 * @param {string} category - 'video' | 'image' | 'document' | 'archive' | 'other'
 * @param {Array} nodes - Optional array of active storage nodes (for capping replica count)
 * @returns {{ importance: string, category: string, replicas: number, backup: boolean, trashDays: number, requireNameConfirm: boolean, reason: string }}
 */
function decide(importance = 'normal', category = 'other', nodes = null) {
  const imp = VALID_IMPORTANCE.includes(importance?.toLowerCase()) ? importance.toLowerCase() : 'normal';
  const cat = ['video', 'image', 'document', 'archive', 'other'].includes(category?.toLowerCase())
    ? category.toLowerCase()
    : 'other';

  const entry = POLICY_MATRIX[imp];
  let replicas = entry.replicas;

  // If node list is provided, cap replicas to available online nodes (minimum 1)
  if (Array.isArray(nodes) && nodes.length > 0) {
    replicas = Math.max(1, Math.min(replicas, nodes.length));
  }

  const reason = `${imp}, ${cat} -> ${replicas} replica${replicas > 1 ? 's' : ''}${entry.backup ? ' + backup' : ''}`;

  return {
    importance: imp,
    category: cat,
    replicas,
    backup: entry.backup,
    trashDays: entry.trashDays,
    requireNameConfirm: entry.requireNameConfirm,
    reason,
  };
}

module.exports = {
  POLICY_MATRIX,
  VALID_IMPORTANCE,
  detectCategory,
  decide,
};

