/**
 * User Role Migration
 *
 * Migrates existing users in coordinator/data/users.json:
 * - admin@nodevault.local becomes 'admin'
 * - Any user matching ADMIN_EMAIL env var becomes 'admin'
 * - All other users become 'user' (default)
 */

const fs = require('node:fs');
const path = require('node:path');

function migrateUserRoles() {
  const usersPath = path.join(__dirname, '..', 'data', 'users.json');
  if (!fs.existsSync(usersPath)) return { migrated: 0 };

  try {
    const raw = fs.readFileSync(usersPath, 'utf8');
    const users = JSON.parse(raw);
    if (!Array.isArray(users)) return { migrated: 0 };

    const adminEmail = (process.env.ADMIN_EMAIL || 'vyastanay67@gmail.com').toLowerCase().trim();
    let migratedCount = 0;

    for (const u of users) {
      const email = (u.email || '').toLowerCase().trim();
      const targetRole = (email === 'admin@nodevault.local' || email === adminEmail || email === 'vyastanay67@gmail.com') ? 'admin' : 'user';
      if (u.role !== targetRole) {
        u.role = targetRole;
        migratedCount++;
      }
    }

    if (migratedCount > 0) {
      fs.writeFileSync(usersPath, JSON.stringify(users, null, 2), 'utf8');
      console.log(`[Migration] Updated roles for ${migratedCount} users in ${usersPath}`);
    }

    return { migrated: migratedCount, total: users.length };
  } catch (err) {
    console.error(`[Migration] Failed to migrate user roles: ${err.message}`);
    return { error: err.message };
  }
}

if (require.main === module) {
  const result = migrateUserRoles();
  console.log('Migration completed:', result);
}

module.exports = { migrateUserRoles };

