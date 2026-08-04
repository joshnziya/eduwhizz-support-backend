const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { requireAuth, JWT_SECRET } = require('../middleware/auth');
const { sendMail } = require('../utils/mailer');

const router = express.Router();
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_MAX_ATTEMPTS = 5;

function issueToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, name: user.name, tier: user.tier },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
}

function generateOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function maskEmail(email) {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}

// POST /api/auth/login  { username, password } -> either { token, user } directly (support/engineering)
// or { otpRequired: true, otpToken } for admin accounts, which must then call /verify-otp.
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password are required.' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  if (!user.active) {
    return res.status(403).json({ error: 'This account has been deactivated. Contact an admin.' });
  }

  if (user.tier !== 'admin') {
    return res.json({ token: issueToken(user), user: { username: user.username, name: user.name, tier: user.tier } });
  }

  // Admin accounts require a second factor: a one-time code emailed to them.
  if (!user.email) {
    return res.status(400).json({
      error: 'This admin account has no email on file, so a verification code can\u2019t be sent. Have another admin add one via the account admin panel.',
    });
  }

  db.prepare('DELETE FROM pending_logins WHERE user_id = ?').run(user.id);

  const code = generateOtp();
  const token = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  db.prepare(`
    INSERT INTO pending_logins (token, user_id, code_hash, attempts, expires_at, created_at)
    VALUES (?, ?, ?, 0, ?, ?)
  `).run(token, user.id, bcrypt.hashSync(code, 10), now + OTP_TTL_MS, now);

  try {
    await sendMail({
      to: user.email,
      subject: 'Your EduWhizz admin sign-in code',
      text: `Your verification code is ${code}. It expires in 10 minutes. If you didn't try to sign in, you can ignore this email.`,
    });
  } catch (e) {
    console.error('Failed to send OTP email:', e.message);
    return res.status(500).json({ error: 'Could not send the verification email. Try again shortly.' });
  }

  res.json({ otpRequired: true, otpToken: token, maskedEmail: maskEmail(user.email) });
});

// POST /api/auth/verify-otp  { otpToken, code } -> { token, user }
router.post('/verify-otp', (req, res) => {
  const { otpToken, code } = req.body || {};
  if (!otpToken || !code) return res.status(400).json({ error: 'otpToken and code are required.' });

  const pending = db.prepare('SELECT * FROM pending_logins WHERE token = ?').get(otpToken);
  if (!pending) return res.status(400).json({ error: 'This sign-in attempt is invalid or already used. Please log in again.' });

  if (Date.now() > pending.expires_at) {
    db.prepare('DELETE FROM pending_logins WHERE token = ?').run(otpToken);
    return res.status(400).json({ error: 'That code expired. Please log in again to get a new one.' });
  }
  if (pending.attempts >= OTP_MAX_ATTEMPTS) {
    db.prepare('DELETE FROM pending_logins WHERE token = ?').run(otpToken);
    return res.status(429).json({ error: 'Too many incorrect attempts. Please log in again to get a new code.' });
  }

  if (!bcrypt.compareSync(String(code).trim(), pending.code_hash)) {
    db.prepare('UPDATE pending_logins SET attempts = attempts + 1 WHERE token = ?').run(otpToken);
    return res.status(401).json({ error: 'That code is incorrect.' });
  }

  db.prepare('DELETE FROM pending_logins WHERE token = ?').run(otpToken);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(pending.user_id);
  if (!user || !user.active) return res.status(403).json({ error: 'This account is no longer active.' });

  res.json({ token: issueToken(user), user: { username: user.username, name: user.name, tier: user.tier } });
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
