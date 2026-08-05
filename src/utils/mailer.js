const nodemailer = require('nodemailer');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  const { SMTP_HOST, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

/**
 * Fire-and-forget notification email. Never throws into the caller — a failed or
 * unconfigured mail setup should never block ticket creation or any other user-facing
 * action. If SMTP isn't configured, this just logs instead of sending.
 */
async function sendMail({ to, subject, text }) {
  if (!to || (Array.isArray(to) && to.length === 0)) return { skipped: true, reason: 'no recipients' };
  const t = getTransporter();
  if (!t) {
    console.log(`\n[NOTIFY - SMTP NOT CONFIGURED, LOGGING INSTEAD]\nTo: ${Array.isArray(to) ? to.join(', ') : to}\nSubject: ${subject}\n${text}\n`);
    return { delivered: false, loggedOnly: true };
  }
  try {
    await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
    return { delivered: true };
  } catch (e) {
    console.error('Notification email failed to send:', e.message);
    return { delivered: false, error: e.message };
  }
}

module.exports = { sendMail };
