const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { requireAuth, JWT_SECRET } = require('../middleware/auth');
const { SYSTEMS, slaResolveBy, slaState } = require('../utils/config');
const { tierOfName } = require('../utils/staff');

const router = express.Router();

function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      // ignore invalid token on a public endpoint; treat as anonymous
    }
  }
  next();
}

function nextTicketId() {
  const row = db.prepare(`SELECT id FROM tickets ORDER BY CAST(SUBSTR(id, 4) AS INTEGER) DESC LIMIT 1`).get();
  const lastNum = row ? parseInt(row.id.split('-')[1], 10) : 10040;
  return `EW-${lastNum + 1}`;
}

function serializeTicket(row, { includeNotes } = { includeNotes: true }) {
  const thread = db
    .prepare('SELECT * FROM ticket_thread WHERE ticket_id = ? ORDER BY at ASC')
    .all(row.id)
    .filter((m) => includeNotes || m.type === 'reply')
    .map((m) => ({ id: m.id, author: m.author, type: m.type, body: m.body, at: m.at, kb: !!m.kb }));

  return {
    id: row.id,
    system: row.system,
    module: row.module,
    category: row.category,
    subject: row.subject,
    description: row.description,
    requester: row.requester_name,
    requesterEmail: row.requester_email,
    priority: row.priority,
    status: row.status,
    assignee: row.assignee,
    team: row.team,
    origin: row.origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    slaResolveBy: slaResolveBy(row),
    slaState: slaState(row),
    thread,
  };
}

function validateSystemModule(system, module) {
  if (!SYSTEMS[system]) return 'Unknown system.';
  if (!SYSTEMS[system].includes(module)) return 'Unknown module for that system.';
  return null;
}

// POST /api/tickets  (public for portal submissions; if a valid staff token is sent, origin is "staff")
router.post('/', optionalAuth, (req, res) => {
  const { system, module, category, subject, description, requester, requesterEmail, priority } = req.body || {};
  if (!system || !module || !subject || !requester) {
    return res.status(400).json({ error: 'system, module, subject, and requester are required.' });
  }
  const badSysMod = validateSystemModule(system, module);
  if (badSysMod) return res.status(400).json({ error: badSysMod });

  const id = nextTicketId();
  const now = Date.now();
  const resolvedPriority = ['critical', 'high', 'normal', 'low'].includes(priority) ? priority : 'normal';

  db.prepare(`
    INSERT INTO tickets (id, system, module, category, subject, description, requester_name, requester_email,
      priority, status, assignee, team, origin, created_at, updated_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'Unassigned', 'Support', ?, ?, ?, NULL)
  `).run(
    id, system, module, category || 'Other', subject, description || '',
    requester, requesterEmail || '', resolvedPriority, req.user ? 'staff' : 'portal', now, now
  );

  if (category === 'Outage' || priority === 'critical') {
    db.prepare(`INSERT INTO ticket_thread (ticket_id, author, type, body, at, kb) VALUES (?, ?, 'reply', ?, ?, 0)`).run(
      id, 'EduWhizz Support',
      'Thanks for the report \u2014 this has been flagged urgent and routed to our team. We\u2019ll follow up shortly.',
      now
    );
  }

  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
  res.status(201).json(serializeTicket(row));
});

// GET /api/tickets  (staff console; requires auth) supports query filters
router.get('/', requireAuth, (req, res) => {
  const { system, module, assignee, priority, status, search } = req.query;
  let sql = 'SELECT * FROM tickets WHERE 1=1';
  const params = [];
  if (system) { sql += ' AND system = ?'; params.push(system); }
  if (module) { sql += ' AND module = ?'; params.push(module); }
  if (assignee) { sql += ' AND assignee = ?'; params.push(assignee); }
  if (priority) { sql += ' AND priority = ?'; params.push(priority); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (search) {
    sql += ' AND (subject LIKE ? OR requester_name LIKE ? OR id LIKE ?)';
    const q = `%${search}%`;
    params.push(q, q, q);
  }
  sql += ' ORDER BY updated_at DESC';
  const rows = db.prepare(sql).all(...params);
  let tickets = rows.map((r) => serializeTicket(r));
  if (req.query.sla) tickets = tickets.filter((t) => t.slaState === req.query.sla);
  res.json({ tickets });
});

// GET /api/tickets/lookup?email=...  (public: customer's own tickets, notes hidden)
router.get('/lookup', (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'email query parameter is required.' });
  const rows = db.prepare('SELECT * FROM tickets WHERE LOWER(requester_email) = ? ORDER BY updated_at DESC').all(email);
  res.json({ tickets: rows.map((r) => serializeTicket(r, { includeNotes: false })) });
});

// GET /api/tickets/:id  (staff detail, requires auth)
router.get('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Ticket not found.' });
  res.json(serializeTicket(row));
});

// GET /api/tickets/:id/lookup?email=...  (public detail: must match requester email, notes hidden)
router.get('/:id/lookup', (req, res) => {
  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Ticket not found.' });
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email || email !== row.requester_email.toLowerCase()) {
    return res.status(403).json({ error: 'Email does not match this ticket.' });
  }
  res.json(serializeTicket(row, { includeNotes: false }));
});

// PATCH /api/tickets/:id  (staff: update status/priority/assignee)
router.patch('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Ticket not found.' });

  const { status, priority, assignee } = req.body || {};
  const fields = [];
  const params = [];

  if (status) { fields.push('status = ?'); params.push(status); }
  if (priority) { fields.push('priority = ?'); params.push(priority); }
  if (assignee) {
    fields.push('assignee = ?'); params.push(assignee);
    const team = assignee === 'Unassigned' ? row.team : (tierOfName(assignee) === 'engineering' ? 'Engineering' : 'Support');
    fields.push('team = ?'); params.push(team);
  }
  const now = Date.now();
  fields.push('updated_at = ?'); params.push(now);
  if ((status === 'resolved' || status === 'closed') && !row.resolved_at) {
    fields.push('resolved_at = ?'); params.push(now);
  }

  params.push(req.params.id);
  db.prepare(`UPDATE tickets SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  const updated = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  res.json(serializeTicket(updated));
});

// POST /api/tickets/:id/escalate  (staff: move from Support to Engineering)
router.post('/:id/escalate', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Ticket not found.' });
  if (row.team === 'Engineering') return res.status(400).json({ error: 'Already with Engineering.' });

  const now = Date.now();
  db.prepare(`UPDATE tickets SET team = 'Engineering', assignee = 'Unassigned', status = 'escalated', updated_at = ? WHERE id = ?`).run(now, req.params.id);
  db.prepare(`INSERT INTO ticket_thread (ticket_id, author, type, body, at, kb) VALUES (?, 'System', 'note', 'Escalated to Engineering.', ?, 0)`).run(req.params.id, now);

  const updated = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  res.json(serializeTicket(updated));
});

// POST /api/tickets/:id/messages  (staff: reply or internal note)
router.post('/:id/messages', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Ticket not found.' });

  const { type, body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'body is required.' });
  if (!['reply', 'note'].includes(type)) return res.status(400).json({ error: "type must be 'reply' or 'note'." });

  const now = Date.now();
  db.prepare(`INSERT INTO ticket_thread (ticket_id, author, type, body, at, kb) VALUES (?, ?, ?, ?, ?, 0)`).run(
    req.params.id, req.user.name, type, body.trim(), now
  );
  const statusUpdate = type === 'reply' && row.status === 'open' ? ', status = \'assigned\'' : '';
  db.prepare(`UPDATE tickets SET updated_at = ?${statusUpdate} WHERE id = ?`).run(now, req.params.id);

  const updated = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  res.status(201).json(serializeTicket(updated));
});

// POST /api/tickets/:id/messages/customer  (public: requester follow-up, requires matching email)
router.post('/:id/messages/customer', (req, res) => {
  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Ticket not found.' });

  const { email, body } = req.body || {};
  if (!email || email.toLowerCase() !== row.requester_email.toLowerCase()) {
    return res.status(403).json({ error: 'Email does not match this ticket.' });
  }
  if (!body || !body.trim()) return res.status(400).json({ error: 'body is required.' });
  if (row.status === 'closed') return res.status(400).json({ error: 'This ticket is closed.' });

  const now = Date.now();
  db.prepare(`INSERT INTO ticket_thread (ticket_id, author, type, body, at, kb) VALUES (?, ?, 'reply', ?, ?, 0)`).run(
    req.params.id, row.requester_name, body.trim(), now
  );
  db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(now, req.params.id);

  const updated = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  res.status(201).json(serializeTicket(updated, { includeNotes: false }));
});

// PATCH /api/tickets/:id/messages/:msgId  (staff: toggle "save to knowledge base")
router.patch('/:id/messages/:msgId', requireAuth, (req, res) => {
  const msg = db.prepare('SELECT * FROM ticket_thread WHERE id = ? AND ticket_id = ?').get(req.params.msgId, req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found.' });
  const kb = req.body && typeof req.body.kb === 'boolean' ? req.body.kb : !msg.kb;
  db.prepare('UPDATE ticket_thread SET kb = ? WHERE id = ?').run(kb ? 1 : 0, msg.id);
  res.json({ id: msg.id, kb });
});

module.exports = router;
