require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./db');
const { SYSTEMS, TEAM } = require('./utils/config');

const DEFAULT_PASSWORD = process.env.SEED_DEFAULT_PASSWORD || 'changeme123';

function seedUsers() {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO users (username, name, email, password_hash, tier, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const hash = bcrypt.hashSync(DEFAULT_PASSWORD, 10);
  const now = Date.now();
  TEAM.forEach((m) => insert.run(m.username, m.name, `${m.username}@eduwhizz.example`, hash, m.tier, now));

  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@eduwhizz.example';
  insert.run('admin', 'Admin', adminEmail, bcrypt.hashSync(DEFAULT_PASSWORD, 10), 'admin', now);

  console.log(`Seeded users: ${TEAM.map((m) => m.username).join(', ')}, admin (password: ${DEFAULT_PASSWORD})`);
  if (!process.env.SEED_ADMIN_EMAIL) {
    console.log('\u26A0  SEED_ADMIN_EMAIL was not set, so the admin account has a placeholder email (admin@eduwhizz.example).');
    console.log('   Admin sign-in codes cannot reach a real inbox until you set a real email (via the admin panel, once you can log in some other way, or by setting SEED_ADMIN_EMAIL before seeding).');
  }
}

function seedSystems() {
  const insertSys = db.prepare(
    `INSERT OR IGNORE INTO systems (name, status, downtime_minutes_month, updated_at) VALUES (?, 'Operational', 0, ?)`
  );
  const insertMod = db.prepare(`INSERT OR IGNORE INTO modules (system_name, name) VALUES (?, ?)`);
  Object.entries(SYSTEMS).forEach(([system, modules]) => {
    insertSys.run(system, Date.now());
    modules.forEach((m) => insertMod.run(system, m));
  });
  console.log('Seeded systems and modules.');
}

function seedTickets() {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM tickets').get();
  if (existing.c > 0) {
    console.log('Tickets already present, skipping ticket seed.');
    return;
  }
  const now = Date.now();
  const insertTicket = db.prepare(`
    INSERT INTO tickets (id, system, module, category, subject, description, requester_name, requester_email,
      priority, status, assignee, team, origin, created_at, updated_at, resolved_at)
    VALUES (@id,@system,@module,@category,@subject,@description,@requester_name,@requester_email,
      @priority,@status,@assignee,@team,@origin,@created_at,@updated_at,@resolved_at)
  `);
  const insertMsg = db.prepare(`
    INSERT INTO ticket_thread (ticket_id, author, type, body, at, kb) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const tickets = [
    {
      id: 'EW-10042', system: 'School ERP', module: 'Teachers App', category: 'Bug',
      subject: 'Cannot submit attendance for afternoon session',
      description: 'The attendance submit button spins forever for the 2pm class only. Morning attendance works fine.',
      requester_name: 'Grace Mwangi', requester_email: 'grace@school.edu',
      priority: 'high', status: 'in_progress', assignee: 'Lucy', team: 'Engineering', origin: 'portal',
      created_at: now - 1000 * 60 * 60 * 7, updated_at: now - 1000 * 60 * 40, resolved_at: null,
      thread: [
        { author: 'Joshua', type: 'note', body: 'Reproduced on staging \u2014 looks like a timeout on the afternoon roster query. Escalating to engineering.', at: now - 1000 * 60 * 60 * 6, kb: 0 },
        { author: 'Lucy', type: 'reply', body: 'Thanks for the report \u2014 we\u2019ve found the cause and are deploying a fix today.', at: now - 1000 * 60 * 40, kb: 0 },
      ],
    },
    {
      id: 'EW-10041', system: 'Rent Management', module: 'Tenant Portal', category: 'Access Request',
      subject: 'Tenant locked out after changing email',
      description: 'Updated my email in the tenant portal and now can\u2019t log in with either address.',
      requester_name: 'Peter Otieno', requester_email: 'peter@email.com',
      priority: 'normal', status: 'open', assignee: 'Unassigned', team: 'Support', origin: 'portal',
      created_at: now - 1000 * 60 * 60 * 3, updated_at: now - 1000 * 60 * 60 * 3, resolved_at: null,
      thread: [],
    },
    {
      id: 'EW-10040', system: 'Pharmacy Management', module: 'POS / Sales', category: 'Outage',
      subject: 'POS terminal frozen at checkout, customers waiting',
      description: 'POS screen freezes right after scanning items, before payment. Happening at both tills.',
      requester_name: 'Anne Kariuki', requester_email: 'anne@pharmacy.co',
      priority: 'critical', status: 'escalated', assignee: 'Kyle', team: 'Engineering', origin: 'portal',
      created_at: now - 1000 * 60 * 60 * 2, updated_at: now - 1000 * 60 * 15, resolved_at: null,
      thread: [
        { author: 'Antony', type: 'note', body: 'Confirmed with the branch \u2014 both tills affected. Escalating immediately.', at: now - 1000 * 60 * 60 * 1.7, kb: 0 },
        { author: 'Kyle', type: 'reply', body: 'We\u2019re on this now \u2014 today\u2019s stock sync locked the sales table. Working on a fix.', at: now - 1000 * 60 * 15, kb: 0 },
      ],
    },
    {
      id: 'EW-10039', system: 'School ERP', module: 'Guardian App', category: 'Bug',
      subject: 'Fee balance shows wrong amount after part payment',
      description: 'Paid part of this term\u2019s fees but the app still shows the full balance as outstanding.',
      requester_name: 'Samuel Kiptoo', requester_email: 'samuel@email.com',
      priority: 'high', status: 'resolved', assignee: 'Lucy', team: 'Engineering', origin: 'portal',
      created_at: now - 1000 * 60 * 60 * 24 * 3, updated_at: now - 1000 * 60 * 60 * 24 * 2, resolved_at: now - 1000 * 60 * 60 * 24 * 2,
      thread: [
        { author: 'Lucy', type: 'reply', body: 'Caused by a delay syncing part-payments to the balance service. Fixed and reprocessed all affected balances.', at: now - 1000 * 60 * 60 * 24 * 2, kb: 1 },
      ],
    },
  ];

  const insertAll = db.transaction((list) => {
    list.forEach((t) => {
      const { thread, ...ticketRow } = t;
      insertTicket.run(ticketRow);
      thread.forEach((m) => insertMsg.run(t.id, m.author, m.type, m.body, m.at, m.kb));
    });
  });
  insertAll(tickets);
  console.log(`Seeded ${tickets.length} sample tickets.`);
}

function seedIncidents() {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM incidents').get();
  if (existing.c > 0) {
    console.log('Incidents already present, skipping incident seed.');
    return;
  }
  const now = Date.now();
  const insert = db.prepare(`
    INSERT INTO incidents (id, system, module, severity, title, description, related_ticket, started_at, resolved_at)
    VALUES (@id,@system,@module,@severity,@title,@description,@related_ticket,@started_at,@resolved_at)
  `);
  const incidents = [
    { id: 'INC-1004', system: 'Pharmacy Management', module: 'POS / Sales', severity: 'Down', title: 'POS terminals frozen at checkout', description: 'Both tills freezing after scanning items, tied to today\u2019s stock sync job.', related_ticket: 'EW-10040', started_at: now - 1000 * 60 * 60 * 1.8, resolved_at: null },
    { id: 'INC-1003', system: 'School ERP', module: 'Teachers App', severity: 'Degraded', title: 'Slow attendance submission, afternoon rosters', description: 'Attendance submit timing out for larger afternoon class rosters.', related_ticket: 'EW-10042', started_at: now - 1000 * 60 * 60 * 6, resolved_at: null },
    { id: 'INC-1002', system: 'Rent Management', module: 'Payments Module', severity: 'Resolved', title: 'Delayed payment confirmation emails', description: 'Email queue backlog behind a stuck retry job.', related_ticket: null, started_at: now - 1000 * 60 * 60 * 24 * 8, resolved_at: now - 1000 * 60 * 60 * 24 * 7.2 },
  ];
  incidents.forEach((i) => insert.run(i));
  console.log(`Seeded ${incidents.length} sample incidents.`);
}

seedUsers();
seedSystems();
seedTickets();
seedIncidents();
console.log('Seed complete.');
