const nodemailer = require('nodemailer');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

/**
 * Sends an email if SMTP is configured (SMTP_HOST/SMTP_USER/SMTP_PASS env vars).
 * If not configured, logs the message to the server console instead — this keeps
 * login/OTP flows usable in development or before a real mail provider is set up,
 * without silently failing.
 */
async function sendMail({ to, subject, text }) {
  const t = getTransporter();
  if (!t) {
    console.log(`\n[MAIL - SMTP NOT CONFIGURED, LOGGING INSTEAD]\nTo: ${to}\nSubject: ${subject}\n${text}\n`);
    return { delivered: false, loggedOnly: true };
  }
  await t.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
  });
  return { delivered: true, loggedOnly: false };
}

module.exports = { sendMail };
