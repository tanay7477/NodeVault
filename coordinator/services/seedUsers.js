const bcrypt = require('bcryptjs');
const { User } = require('../models');

/**
 * Bootstrap essential cluster accounts on startup.
 * Ensures admin account vyastanay67@gmail.com and demo users always exist,
 * even on ephemeral cloud deployments like Render.
 */
async function seedDefaultUsers() {
  try {
    const adminEmail = (process.env.ADMIN_EMAIL || 'vyastanay67@gmail.com').toLowerCase().trim();

    // 1. Ensure primary admin exists
    const existingAdmin = await User.findOne({ email: adminEmail });
    if (!existingAdmin) {
      const hash = await bcrypt.hash('tanay@#$%', 12);
      await User.create({
        name: 'Tanay Vyas',
        email: adminEmail,
        password: hash,
        role: 'admin',
      });
      console.log(`[Seed] Seeded primary admin user: ${adminEmail}`);
    } else if (existingAdmin.role !== 'admin') {
      await User.updateOne({ email: adminEmail }, { $set: { role: 'admin' } });
      console.log(`[Seed] Elevated ${adminEmail} to admin`);
    }

    // 2. Ensure cluster fallback admin exists
    const fallbackAdmin = await User.findOne({ email: 'admin@nodevault.local' });
    if (!fallbackAdmin) {
      const hash = await bcrypt.hash('AdminPassword123!', 12);
      await User.create({
        name: 'Cluster Admin',
        email: 'admin@nodevault.local',
        password: hash,
        role: 'admin',
      });
      console.log('[Seed] Seeded fallback admin: admin@nodevault.local');
    } else if (fallbackAdmin.role !== 'admin') {
      await User.updateOne({ email: 'admin@nodevault.local' }, { $set: { role: 'admin' } });
    }

    // 3. Ensure demo user exists
    const demoUser = await User.findOne({ email: 'demo@nodevault.local' });
    if (!demoUser) {
      const hash = await bcrypt.hash('DemoPassword123!', 12);
      await User.create({
        name: 'Demo Engineer',
        email: 'demo@nodevault.local',
        password: hash,
        role: 'user',
      });
      console.log('[Seed] Seeded demo user: demo@nodevault.local');
    }
  } catch (err) {
    console.error(`[Seed] Error seeding default users: ${err.message}`);
  }
}

module.exports = { seedDefaultUsers };
