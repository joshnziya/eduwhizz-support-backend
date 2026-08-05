const db = require('../db');

// Active support + engineering staff, for assignment dropdowns and report breakdowns.
// Admin accounts are excluded — they manage the desk, they aren't assigned tickets.
function listAssignableStaff() {
  return db
    .prepare(`SELECT username, name, email, tier FROM users WHERE tier IN ('support','engineering') AND active = 1 ORDER BY name`)
    .all();
}

function tierOfName(name) {
  const row = db.prepare(`SELECT tier FROM users WHERE name = ? AND active = 1`).get(name);
  return row ? row.tier : 'support';
}

// Everyone active who has an email on file — used for "new ticket" notifications.
// Admins are included here (unlike listAssignableStaff) since they may want visibility too.
function listNotificationRecipients() {
  return db
    .prepare(`SELECT email FROM users WHERE active = 1 AND email IS NOT NULL AND TRIM(email) != ''`)
    .all()
    .map((r) => r.email);
}

module.exports = { listAssignableStaff, tierOfName, listNotificationRecipients };
