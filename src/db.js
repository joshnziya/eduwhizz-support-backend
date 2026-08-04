const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'eduwhizz.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('support','engineering','admin')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS systems (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'Operational' CHECK (status IN ('Operational','Degraded','Down')),
  downtime_minutes_month REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_name TEXT NOT NULL REFERENCES systems(name) ON DELETE CASCADE,
  name TEXT NOT NULL,
  UNIQUE(system_name, name)
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  system TEXT NOT NULL,
  module TEXT NOT NULL,
  category TEXT NOT NULL,
  subject TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  requester_name TEXT NOT NULL,
  requester_email TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL CHECK (priority IN ('critical','high','normal','low')),
  status TEXT NOT NULL CHECK (status IN ('open','assigned','in_progress','escalated','resolved','closed')),
  assignee TEXT NOT NULL DEFAULT 'Unassigned',
  team TEXT NOT NULL DEFAULT 'Support' CHECK (team IN ('Support','Engineering')),
  origin TEXT NOT NULL DEFAULT 'portal' CHECK (origin IN ('portal','staff')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS ticket_thread (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('reply','note')),
  body TEXT NOT NULL,
  at INTEGER NOT NULL,
  kb INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  system TEXT NOT NULL,
  module TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('Investigating','Degraded','Down','Resolved')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  related_ticket TEXT,
  started_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_system ON tickets(system);
CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(assignee);
CREATE INDEX IF NOT EXISTS idx_thread_ticket ON ticket_thread(ticket_id);
CREATE INDEX IF NOT EXISTS idx_incidents_system ON incidents(system);
`);

// Migration for databases created before the "active" column existed.
const userColumns = db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
if (!userColumns.includes('active')) {
  db.exec(`ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1`);
}

module.exports = db;
