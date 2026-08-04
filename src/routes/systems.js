const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function monthStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

function computeUptime(system) {
  const start = monthStart();
  const minutesSoFar = Math.max(1, (Date.now() - start) / 60000);
  let downtime = system.downtime_minutes_month;
  const ongoing = db
    .prepare(`SELECT * FROM incidents WHERE system = ? AND resolved_at IS NULL AND started_at >= ? AND severity IN ('Down','Degraded')`)
    .all(system.name, start);
  ongoing.forEach((i) => { downtime += (Date.now() - i.started_at) / 60000; });
  return Math.max(0, 100 - (downtime / minutesSoFar) * 100);
}

// GET /api/systems  (public: status page style read-only view)
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM systems').all();
  const modules = db.prepare('SELECT * FROM modules ORDER BY id').all();
  const systems = rows.map((s) => ({
    name: s.name,
    status: s.status,
    uptimeThisMonth: Number(computeUptime(s).toFixed(2)),
    modules: modules.filter((m) => m.system_name === s.name).map((m) => m.name),
    updatedAt: s.updated_at,
  }));
  res.json({ systems });
});

// PATCH /api/systems/:name  (staff: manually set status, e.g. Operational / Degraded / Down)
router.patch('/:name', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM systems WHERE name = ?').get(req.params.name);
  if (!row) return res.status(404).json({ error: 'System not found.' });
  const { status } = req.body || {};
  if (!['Operational', 'Degraded', 'Down'].includes(status)) {
    return res.status(400).json({ error: 'status must be Operational, Degraded, or Down.' });
  }
  db.prepare('UPDATE systems SET status = ?, updated_at = ? WHERE name = ?').run(status, Date.now(), row.name);
  res.json({ name: row.name, status });
});

module.exports = router;
