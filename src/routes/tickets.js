const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { requireAuth, JWT_SECRET } = require('../middleware/auth');
const { SYSTEMS, REPORTER_ROLES, slaResolveBy, slaState } = require('../utils/config');
const { tierOfName, listNotificationRecipients } = require('../utils/staff');
const { sendMail } = require('../utils/mailer');

const router = express.Router();
const MAX_ATTACHMENT_CHARS = 4_500_000; // ~3.3MB raw image, after base64 overhead

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

function serializeTicket(row, { includeNotes = true, includeAttachmentData = false } = {}) {
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
    requesterRole: row.requester_role || '',
    priority: row.priority,
    status: row.status,
    assignee: row.assignee,
    team: row.team,
    origin: row.origin,
    hasAttachment: !!row.attachment_data,
    attachmentName: row.attachment_name || null,
    attachmentType: row.attachment_type || null,
    attachmentData: includeAttachmentData ? row.attachment_data || null : undefined,
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/tickets  (public for portal submissions; if a valid staff token is sent, origin is "staff")
router.post('/', optionalAuth, (req, res) => {
  const { system, module, category, subject, description, requester, requesterEmail, requesterRole, priority, attachment } = req.body || {};
  if (!system || !module || !subject || !requester) {
    return res.status(400).json({ error: 'system, module, subject, and requester are required.' });
  }
  if (!requesterEmail || !EMAIL_RE.test(requesterEmail)) {
    return res.status(400).json({ error: 'A valid email is required so we can confirm your request and follow up.' });
  }
  const badSysMod = validateSystemModule(system, module);
  if (badSysMod) return res.status(400).json({ error: badSysMod });
  if (requesterRole && !REPORTER_ROLES.includes(requesterRole)) {
    return res.status(400).json({ error: 'Unrecognized role.' });
  }

  let attachmentName = null, attachmentType = null, attachmentData = null;
  if (attachment && attachment.dataUrl) {
    if (typeof attachment.dataUrl !== 'string' || !attachment.dataUrl.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Attachment must be an image.' });
    }
    if (attachment.dataUrl.length > MAX_ATTACHMENT_CHARS) {
      return res.status(400).json({ error: 'That screenshot is too large. Please attach an image under ~3MB.' });
    }
    attachmentName = (attachment.name || 'screenshot').slice(0, 200);
    attachmentType = (attachment.type || 'image/png').slice(0, 100);
    attachmentData = attachment.dataUrl;
  }

  const id = nextTicketId();
  const now = Date.now();
  const resolvedPriority = ['critical', 'high', 'normal', 'low'].includes(priority) ? priority : 'normal';

  db.prepare(`
    INSERT INTO tickets (id, system, module, category, subject, description, requester_name, requester_email, requester_role,
      priority, status, assignee, team, origin, attachment_name, attachment_type, attachment_data, created_at, updated_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'Unassigned', 'Support', ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    id, system, module, category || 'Other', subject, description || '',
    requester, requesterEmail, requesterRole || '', resolvedPriority,
    req.user ? 'staff' : 'portal', attachmentName, attachmentType, attachmentData, now, now
  );

  if (category === 'Outage' || priority === 'critical') {
    db.prepare(`INSERT INTO ticket_thread (ticket_id, author, type, body, at, kb) VALUES (?, ?, 'reply', ?, ?, 0)`).run(
      id, 'EduWhizz Support',
      'Thanks for the report \u2014 this has been flagged urgent and routed to our team. We\u2019ll follow up shortly.',
      now
    );
  }

  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
  res.status(201).json(serializeTicket(row, { includeAttachmentData: true }));

  // Fire-and-forget from here down: neither email ever affects the response already sent above.

  // 1) Confirmation to the person who raised it.
  const confirmLines = [
    `Hi ${requester},`,
    '',
    `We've received your request and it's been logged as ${id}.`,
    '',
    `Subject: ${subject}`,
    `System: ${system} / ${module}`,
    '',
    'Our team will follow up as soon as possible. You can check the status of this request anytime by visiting the support portal, going to "My requests", and entering this email address.',
    '',
    '\u2014 EduWhizz Support',
  ];
  sendMail({ to: requesterEmail, subject: `[EduWhizz] We've received your request (${id})`, text: confirmLines.join('\n') })
    .catch((e) => console.error('Confirmation email failed:', e.message));

  // 2) Internal notification to staff/admins with an email on file.
  const recipients = listNotificationRecipients();
  if (recipients.length) {
    const lines = [
      `New ticket ${id} \u2014 ${subject}`,
      '',
      `Raised by: ${requester}${requesterRole ? ' (' + requesterRole + ')' : ''} <${requesterEmail}>`,
      `System: ${system} / ${module}`,
      `Category: ${category || 'Other'}`,
      `Priority: ${resolvedPriority}`,
      '',
      description || '(no description provided)',
    ];
    sendMail({ to: recipients, subject: `[EduWhizz] New ticket ${id}: ${subject}`, text: lines.join('\n') })
      .catch((e) => console.error('Notification send failed:', e.message));
  } else {
    console.log(`[NOTIFY] No staff/admin accounts have an email on file \u2014 skipping internal notification for ${id}. Add emails via the admin panel to receive these.`);
  }
});

// GET /api/tickets  (staff console; requires auth) supports query filters
router.get('/', requireAuth, (req, res) => {
  const { system, module, assignee, priority, status, search } = req.query;
  let sql = 'SELECT * FROM tickets WHERE 1=1';
  const params = [];
  if (system) { sql += ' AND system = ?'; params.push(system); }
  if (module) { sql += ' AND module = ?'; params.push(module); }
  if (priority) { sql += ' AND priority = ?'; params.push(priority); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (search) {
    sql += ' AND (subject LIKE ? OR requester_name LIKE ? OR id LIKE ?)';
    const q = `%${search}%`;
    params.push(q, q, q);
  }

  // Access control: non-admins only ever see tickets assigned to them, or unassigned ones they
  // could pick up. This is enforced here, server-side, not just hidden in the UI — a non-admin
  // cannot see a colleague's queue by any request shape, including a requested `assignee` filter
  // for someone else's name.
  if (req.user.tier !== 'admin') {
    sql += ' AND (assignee = ? OR assignee = ?)';
    params.push(req.user.name, 'Unassigned');
    if (assignee && assignee !== req.user.name && assignee !== 'Unassigned') {
      // Requested a scope they're not allowed to see — return nothing rather than silently ignore.
      return res.json({ tickets: [] });
    }
    if (assignee) { sql += ' AND assignee = ?'; params.push(assignee); }
  } else if (assignee) {
    sql += ' AND assignee = ?'; params.push(assignee);
  }

  sql += ' ORDER BY updated_at DESC';
  const rows = db.prepare(sql).all(...params);
  let tickets = rows.map((r) => serializeTicket(r, { includeAttachmentData: false }));
  if (req.query.sla) tickets = tickets.filter((t) => t.slaState === req.query.sla);
  res.json({ tickets });
});

// GET /api/tickets/lookup?email=...  (public: customer's own tickets, notes hidden)
router.get('/lookup', (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'email query parameter is required.' });
  const rows = db.prepare('SELECT * FROM tickets WHERE LOWER(requester_email) = ? ORDER BY updated_at DESC').all(email);
  res.json({ tickets: rows.map((r) => serializeTicket(r, { includeNotes: false, includeAttachmentData: false })) });
});

// GET /api/tickets/:id  (staff detail, requires auth)
router.get('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Ticket not found.' });
  if (req.user.tier !== 'admin' && row.assignee !== req.user.name && row.assignee !== 'Unassigned') {
    return res.status(403).json({ error: 'This ticket is assigned to someone else.' });
  }
  res.json(serializeTicket(row, { includeAttachmentData: true }));
});

// GET /api/tickets/:id/lookup?email=...  (public detail: must match requester email, notes hidden)
router.get('/:id/lookup', (req, res) => {
  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Ticket not found.' });
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email || email !== row.requester_email.toLowerCase()) {
    return res.status(403).json({ error: 'Email does not match this ticket.' });
  }
  res.json(serializeTicket(row, { includeNotes: false, includeAttachmentData: true }));
});

// PATCH /api/tickets/:id  (staff: update status/priority/assignee)
router.patch('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Ticket not found.' });
  if (req.user.tier !== 'admin' && row.assignee !== req.user.name && row.assignee !== 'Unassigned') {
    return res.status(403).json({ error: 'This ticket is assigned to someone else.' });
  }

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
  if (req.user.tier !== 'admin' && row.assignee !== req.user.name && row.assignee !== 'Unassigned') {
    return res.status(403).json({ error: 'This ticket is assigned to someone else.' });
  }
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
  if (req.user.tier !== 'admin' && row.assignee !== req.user.name && row.assignee !== 'Unassigned') {
    return res.status(403).json({ error: 'This ticket is assigned to someone else.' });
  }

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
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
  if (req.user.tier !== 'admin' && ticket.assignee !== req.user.name && ticket.assignee !== 'Unassigned') {
    return res.status(403).json({ error: 'This ticket is assigned to someone else.' });
  }
  const msg = db.prepare('SELECT * FROM ticket_thread WHERE id = ? AND ticket_id = ?').get(req.params.msgId, req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found.' });
  const kb = req.body && typeof req.body.kb === 'boolean' ? req.body.kb : !msg.kb;
  db.prepare('UPDATE ticket_thread SET kb = ? WHERE id = ?').run(kb ? 1 : 0, msg.id);
  res.json({ id: msg.id, kb });
});

module.exports = router;
