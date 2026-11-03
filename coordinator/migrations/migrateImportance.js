/**
 * Migration: Default existing files without importance to 'normal'.
 * Also populates category, policy_reason, access_count, last_access, deleted_at, purge_at.
 */

const fs = require('node:fs');
const path = require('node:path');
const { detectCategory, decide } = require('../services/policy');

function migrateImportance() {
  const dataDir = path.join(__dirname, '..', 'data');
  const filesPath = path.join(dataDir, 'files.json');

  if (!fs.existsSync(filesPath)) return;

  try {
    const raw = fs.readFileSync(filesPath, 'utf8');
    if (!raw.trim()) return;
    const files = JSON.parse(raw);
    let modified = false;

    for (const file of files) {
      if (!file.importance) {
        const cat = file.category || detectCategory(file.mimeType, file.originalName);
        const policy = decide('normal', cat);

        file.importance = 'normal';
        file.category = cat;
        file.policy_reason = policy.reason;
        modified = true;
      }

      if (file.deleted_at === undefined) {
        file.deleted_at = null;
        modified = true;
      }
      if (file.purge_at === undefined) {
        file.purge_at = null;
        modified = true;
      }
      if (file.access_count === undefined) {
        file.access_count = 0;
        modified = true;
      }
      if (!file.last_access) {
        file.last_access = file.createdAt || new Date().toISOString();
        modified = true;
      }
      if (file.aiSummary === undefined) {
        file.aiSummary = '';
        modified = true;
      }
      if (!Array.isArray(file.tags)) {
        file.tags = [];
        modified = true;
      }
    }

    if (modified) {
      const tmpPath = `${filesPath}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpPath, JSON.stringify(files, null, 2));
      fs.renameSync(tmpPath, filesPath);
      console.log(`[Migration] Successfully migrated ${files.length} files to include Smart Storage policy defaults.`);
    }
  } catch (err) {
    console.error(`[Migration] Failed to migrate file importance: ${err.message}`);
  }
}

module.exports = { migrateImportance };

