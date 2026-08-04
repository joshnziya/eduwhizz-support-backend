const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { SYSTEMS } = require('../utils/config');

const router = express.Router();

function nextIncidentId() {
  const row = db.prepare(`SELECT id FROM incidents ORDER BY CAST(SUBSTR(id, 5) AS INTEGER) DESC LIMIT 1`).get();
  const lastNum = row ? parseInt(row.id.split('-')[1], 10) : 1000;
  return `INC-${lastNum + 1}`;
}

function serialize(row) {
  const ongoing = !row.resolved_at;
  const durationMin = (ongoing ? Date.now() : row.resolved_at) - row.started_at;
  return {
    id: row.id,
    system: row.system,
    module: row.module,
    severity: row.severity,
    title: row.title,
    description: row.description,
    relatedTicket: row.related_ticket,
    startedAt: row.started_at,
    resolvedAt: row.resolved_at,
    ongoing,
    durationMinutes: Math.round(durationMin / 60000),
  };
}

// GET /api/incidents  (public read-only feed, e.g. for a status page)
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM incidents ORDER BY started_at DESC').all();
  res.json({ incidents: rows.map(serialize) });
});

// POST /api/incidents  (staff: log a new incident)
router.post('/', requireAuth, (req, res) => {
  const { system, module, severity, title, description, relatedTicket } = req.body || {};
  if (!system || !SYSTEMS[system]) return res.status(400).json({ error: 'A valid system is required.' });
  if (module && !SYSTEMS[system].includes(module)) return res.status(400).json({ error: 'Unknown module for that system.' });
  if (!['Investigating', 'Degraded', 'Down'].includes(severity)) {
    return res.status(400).json({ error: 'severity must be Investigating, Degraded, or Down.' });
  }
  if (!title) return res.status(400).json({ error: 'title is required.' });

  const id = nextIncidentId();
  const now = Date.now();
  db.prepare(`
    INSERT INTO incidents (id, system, module, severity, title, description, related_ticket, started_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(id, system, module || null, severity, title, description || '', relatedTicket || null, now);

  if (severity === 'Down' || severity === 'Degraded') {
    db.prepare('UPDATE systems SET status = ?, updated_at = ? WHERE name = ?').run(severity, now, system);
  }

  const row = db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
  res.status(201).json(serialize(row));
});

// POST /api/incidents/:id/resolve  (staff: mark resolved, roll duration into monthly downtime)
router.post('/:id/resolve', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM incidents WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Incident not found.' });
  if (row.resolved_at) return res.status(400).json({ error: 'Already resolved.' });

  const now = Date.now();
  db.prepare('UPDATE incidents SET resolved_at = ? WHERE id = ?').run(now, row.id);

  const durationMin = (now - row.started_at) / 60000;
  db.prepare('UPDATE systems SET downtime_minutes_month = downtime_minutes_month + ? WHERE name = ?').run(durationMin, row.system);

  const stillOpen = db.prepare(`SELECT COUNT(*) AS c FROM incidents WHERE system = ? AND resolved_at IS NULL`).get(row.system);
  if (stillOpen.c === 0) {
    db.prepare(`UPDATE systems SET status = 'Operational', updated_at = ? WHERE name = ?`).run(now, row.system);
  }

  const updated = db.prepare('SELECT * FROM incidents WHERE id = ?').get(row.id);
  res.json(serialize(updated));
});

module.exports = router;
