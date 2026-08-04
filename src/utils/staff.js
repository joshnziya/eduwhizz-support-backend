const db = require('../db');

// Active support + engineering staff, for assignment dropdowns and report breakdowns.
// Admin accounts are excluded — they manage the desk, they aren't assigned tickets.
function listAssignableStaff() {
  return db
    .prepare(`SELECT username, name, tier FROM users WHERE tier IN ('support','engineering') AND active = 1 ORDER BY name`)
    .all();
}

function tierOfName(name) {
  const row = db.prepare(`SELECT tier FROM users WHERE name = ? AND active = 1`).get(name);
  return row ? row.tier : 'support';
}

module.exports = { listAssignableStaff, tierOfName };
