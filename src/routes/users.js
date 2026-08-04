const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireTier } = require('../middleware/auth');
const { listAssignableStaff } = require('../utils/staff');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function serializeUser(row) {
  return { username: row.username, name: row.name, email: row.email || '', tier: row.tier, active: !!row.active, createdAt: row.created_at };
}

// GET /api/users/assignable  (any logged-in staff member: for populating an "assign to" dropdown)
router.get('/assignable', requireAuth, (req, res) => {
  res.json({ staff: listAssignableStaff() });
});

// GET /api/users  (admin only: full account list, including inactive/admin accounts)
router.get('/', requireAuth, requireTier('admin'), (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY tier, name').all();
  res.json({ users: rows.map(serializeUser) });
});

// POST /api/users  (admin only: create a new staff account)
router.post('/', requireAuth, requireTier('admin'), (req, res) => {
  const { username, name, email, password, tier } = req.body || {};
  if (!username || !name || !password || !tier) {
    return res.status(400).json({ error: 'username, name, password, and tier are required.' });
  }
  if (!['support', 'engineering', 'admin'].includes(tier)) {
    return res.status(400).json({ error: "tier must be 'support', 'engineering', or 'admin'." });
  }
  if (tier === 'admin' && (!email || !EMAIL_RE.test(email))) {
    return res.status(400).json({ error: 'A valid email is required for admin accounts, since sign-in codes are sent there.' });
  }
  if (email && !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'That email address doesn\u2019t look valid.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters.' });
  }
  const cleanUsername = String(username).toLowerCase().trim();
  if (!/^[a-z0-9._-]{3,32}$/.test(cleanUsername)) {
    return res.status(400).json({ error: 'username must be 3-32 characters: letters, numbers, dots, dashes, or underscores.' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(cleanUsername);
  if (existing) return res.status(409).json({ error: 'That username is already taken.' });

  const hash = bcrypt.hashSync(password, 10);
  const now = Date.now();
  db.prepare(`INSERT INTO users (username, name, email, password_hash, tier, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`)
    .run(cleanUsername, name.trim(), (email || '').trim().toLowerCase(), hash, tier, now);

  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(cleanUsername);
  res.status(201).json(serializeUser(row));
});

// PATCH /api/users/:username  (admin only: update name/email/tier, or activate/deactivate)
router.patch('/:username', requireAuth, requireTier('admin'), (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username.toLowerCase());
  if (!row) return res.status(404).json({ error: 'Account not found.' });

  const { name, email, tier, active } = req.body || {};
  if (tier && !['support', 'engineering', 'admin'].includes(tier)) {
    return res.status(400).json({ error: "tier must be 'support', 'engineering', or 'admin'." });
  }
  if (email !== undefined && email !== '' && !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'That email address doesn\u2019t look valid.' });
  }
  const effectiveTier = tier || row.tier;
  const effectiveEmail = email !== undefined ? email : row.email;
  if (effectiveTier === 'admin' && !effectiveEmail) {
    return res.status(400).json({ error: 'Admin accounts need an email on file for sign-in codes.' });
  }
  if (row.username === req.user.username && active === false) {
    return res.status(400).json({ error: 'You cannot deactivate the account you are currently logged in with.' });
  }

  const fields = [];
  const params = [];
  if (name) { fields.push('name = ?'); params.push(name.trim()); }
  if (email !== undefined) { fields.push('email = ?'); params.push(email.trim().toLowerCase()); }
  if (tier) { fields.push('tier = ?'); params.push(tier); }
  if (typeof active === 'boolean') { fields.push('active = ?'); params.push(active ? 1 : 0); }
  if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update.' });

  params.push(row.username);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE username = ?`).run(...params);
  const updated = db.prepare('SELECT * FROM users WHERE username = ?').get(row.username);
  res.json(serializeUser(updated));
});

// POST /api/users/:username/reset-password  (admin only: set someone else's password directly)
router.post('/:username/reset-password', requireAuth, requireTier('admin'), (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username.toLowerCase());
  if (!row) return res.status(404).json({ error: 'Account not found.' });
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'newPassword must be at least 8 characters.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(bcrypt.hashSync(newPassword, 10), row.username);
  res.json({ ok: true });
});

module.exports = router;
