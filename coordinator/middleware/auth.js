const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * JWT verification middleware.
 * Expects: Authorization: Bearer <token>
 * Sets req.user = { id, email, role } on success.
 */
function auth(req, res, next) {
  let token = null;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    token = header.slice(7);
  } else if (req.query?.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    req.user = jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Admin role guard middleware.
 * Rejects non-admin users with 403 Forbidden.
 */
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden: Admin access required' });
  }

  next();
}

module.exports = auth;
module.exports.auth = auth;
module.exports.requireAdmin = requireAdmin;
