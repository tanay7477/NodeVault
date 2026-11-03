const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { User } = require('../models');
const { logEvent } = require('../services/auditService');

exports.register = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name?.trim() || !email?.trim() || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const existing = await User.findOne({ email: cleanEmail });
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const hash = await bcrypt.hash(password, 12);

    // New signups are always 'user'; admin can only be set by seed or env (ADMIN_EMAIL)
    const adminEmail = process.env.ADMIN_EMAIL ? process.env.ADMIN_EMAIL.toLowerCase().trim() : null;
    const role = (adminEmail && cleanEmail === adminEmail) ? 'admin' : 'user';

    const user = await User.create({
      name: name.trim(),
      email: cleanEmail,
      password: hash,
      role,
    });

    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role || 'user' },
      config.jwtSecret,
      { expiresIn: config.jwtExpiry }
    );

    await logEvent({ userId: user._id, action: 'register', resource: user.email, status: 'success' });

    res.status(201).json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role || 'user',
      },
    });
  } catch (err) {
    console.error('[Auth] Register:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: cleanEmail });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const role = user.role || 'user';
    const token = jwt.sign(
      { id: user._id, email: user.email, role },
      config.jwtSecret,
      { expiresIn: config.jwtExpiry }
    );

    await logEvent({ userId: user._id, action: 'login', resource: user.email, status: 'success' });

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role,
      },
    });
  } catch (err) {
    console.error('[Auth] Login:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
};
