const multer = require('multer');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');

/**
 * Secure file upload middleware.
 *
 * Security measures:
 *  1. Original filename is NEVER used on disk (prevents path traversal).
 *  2. Files are stored with a cryptographic UUID name.
 *  3. Dangerous executable extensions are blocked.
 *  4. File size is capped (config.maxFileSizeBytes).
 */

const BLOCKED_EXTENSIONS = /\.(exe|bat|cmd|sh|ps1|vbs|msi|dll|com|scr|jar|py|rb|php)$/i;

// Allow only safe MIME type categories
const ALLOWED_MIME_REGEX = /^(image\/|video\/|audio\/|text\/|application\/octet-stream|application\/pdf|application\/zip|application\/x-zip|application\/msword|application\/vnd\.|application\/json|application\/xml)/;

const storage = multer.diskStorage({
  destination: config.tempDir,
  filename: (_req, _file, cb) => {
    cb(null, crypto.randomUUID());
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.maxFileSizeBytes },
  fileFilter: (_req, file, cb) => {
    // 1. Block dangerous extensions
    if (BLOCKED_EXTENSIONS.test(file.originalname)) {
      return cb(new Error('File type not allowed: dangerous extension'));
    }
    // 2. Validate MIME type (attackers can rename malware.exe to malware.pdf)
    if (!ALLOWED_MIME_REGEX.test(file.mimetype)) {
      return cb(new Error('File type not allowed: unsupported MIME type'));
    }
    // 3. Cap filename length
    if (file.originalname.length > 255) {
      return cb(new Error('Filename too long (max 255 characters)'));
    }
    cb(null, true);
  },
});

module.exports = { single: upload.single('file') };
