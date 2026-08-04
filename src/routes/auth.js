const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { requireAuth, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login  { username, password } -> { token, user }
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password are required.' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  if (!user.active) {
    return res.status(403).json({ error: 'This account has been deactivated. Contact an admin.' });
  }

  const token = jwt.sign(
    { sub: user.id, username: user.username, name: user.name, tier: user.tier },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
  res.json({ token, user: { username: user.username, name: user.name, tier: user.tier } });
});

// GET /api/auth/me -> current user from token
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: { username: req.user.username, name: req.user.name, tier: req.user.tier } });
});

// PATCH /api/auth/me/password  { currentPassword, newPassword } -> change your own password
router.patch('/me/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required.' });
  }
  if (newPassword.length < 8) return res.status(400).json({ error: 'newPassword must be at least 8 characters.' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(req.user.username);
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(bcrypt.hashSync(newPassword, 10), user.username);
  res.json({ ok: true });
});

module.exports = router;
