const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/kb?search=...  (public: documented fixes pulled from ticket replies flagged kb=1)
router.get('/', (req, res) => {
  const search = (req.query.search || '').trim().toLowerCase();
  const rows = db.prepare(`
    SELECT tt.id AS message_id, tt.author, tt.body, tt.at,
           t.id AS ticket_id, t.system, t.module, t.subject
    FROM ticket_thread tt
    JOIN tickets t ON t.id = tt.ticket_id
    WHERE tt.kb = 1
    ORDER BY tt.at DESC
  `).all();

  const filtered = search
    ? rows.filter((r) =>
        r.subject.toLowerCase().includes(search) ||
        r.body.toLowerCase().includes(search) ||
        r.system.toLowerCase().includes(search) ||
        r.module.toLowerCase().includes(search))
    : rows;

  res.json({
    entries: filtered.map((r) => ({
      ticketId: r.ticket_id,
      system: r.system,
      module: r.module,
      subject: r.subject,
      author: r.author,
      body: r.body,
      at: r.at,
    })),
  });
});

module.exports = router;
