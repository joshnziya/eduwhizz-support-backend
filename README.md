# EduWhizz Support Desk — Backend

A real backend for the EduWhizz SaaS Support Desk: Node.js + Express API on top of a SQLite
database, **now serving the connected frontend too** — this is a single deployable app, not two
separate things to wire together.

Covers ticketing, SLA tracking, system/incident monitoring, reports, and a knowledge base for
three products — School ERP, Rent Management, Pharmacy Management.

## 0. What's in `public/`

- `public/index.html` — the actual app your team and end users use: the customer portal and the
  staff console, now calling this API for everything (real login, real data, no demo storage).
- `public/admin.html` — where an admin creates/manages staff accounts (see Section 3).

Once this server is running, both are served automatically — visit `/` for the app and
`/admin.html` for account admin. Staff logins persist in the browser's `localStorage` (this is a
normal web page now, not a Claude artifact, so that's safe and expected) — signing in keeps you
signed in across refreshes until the token expires or you log out.

## 1. Setup (local)

Requires Node.js 18+.

```bash
npm install
cp .env.example .env      # then edit .env — at minimum change JWT_SECRET
npm run seed               # creates the SQLite file and seeds users/systems/sample data
npm start                  # starts everything on http://localhost:4000
```

Open `http://localhost:4000` — that's the live app. `http://localhost:4000/admin.html` is the
account admin page.

The database is a single file at `data/eduwhizz.sqlite`. Delete it and re-run `npm run seed` to
start over from scratch.

## 2. Getting your team on it today (deployment)

Running it on your own laptop only works for you — Joshua, Antony, Lucy, and Kyle each need a URL
they can reach from their own devices. The fastest path with no server management:

**Render (free, no credit card needed for a basic web service):**
1. Push this folder to a GitHub repo (or use Render's "upload" option if you don't want to use git).
2. In Render: New → Web Service → connect the repo.
3. Build command: `npm install && npm run seed` — Start command: `npm start`.
4. Add environment variables from `.env.example` (set a real `JWT_SECRET`, set `CORS_ORIGIN` to
   your Render URL once you have it, or leave as `*` to start).
5. Deploy. Render gives you a URL like `https://eduwhizz-support.onrender.com` — that's what you
   share with the team.
6. Visit `<your-url>/admin.html`, log in as `admin` / `changeme123`, **change that password
   immediately**, and create real accounts for Joshua, Antony, Lucy, and Kyle.

**Important caveat on Render's free tier:** the filesystem is not persistent on the free plan — a
redeploy or extended idle spin-down can reset the SQLite file back to the seed data. That's fine
for getting the team logged in and testing today; if you need data to survive indefinitely, either
upgrade to a Render plan with a persistent disk, or move to Postgres (see Section 6) before
treating this as your permanent system of record.

Railway and Fly.io work the same way if you prefer them.

## 3. Default accounts (change these passwords immediately)

Seeded by `npm run seed`, all with password from `SEED_DEFAULT_PASSWORD` in `.env` (default
`changeme123`):

| username | name    | tier        |
|----------|---------|-------------|
| joshua   | Joshua  | support     |
| antony   | Antony  | support     |
| lucy     | Lucy    | engineering |
| kyle     | Kyle    | engineering |
| admin    | Admin   | admin       |

**Change these immediately** — log into `http://localhost:4000/admin.html` as `admin` and use
"Reset password" on each account, or call `PATCH /api/auth/me/password` per account. Treat the
`admin` login itself as the most sensitive credential in this system.

## 4. Authentication, accounts & UI

`POST /api/auth/login` with `{ "username": "...", "password": "..." }` returns a token for any
active account (support, engineering, or admin) immediately — one step, no email/OTP involved:
```json
{ "token": "eyJ...", "user": { "username": "lucy", "name": "Lucy", "tier": "engineering" } }
```

Send the access token back as `Authorization: Bearer <token>` on staff-only endpoints. Tokens
expire after 12 hours (see `JWT_SECRET` / expiry in `src/middleware/auth.js`). Deactivated
accounts get a `403` on login, even with the correct password.

Portal endpoints (customers submitting or tracking their own requests) do **not** require a
token — there's no customer account system here, only an email-match check.

### The customer portal and staff console are visually distinct on purpose

The frontend switches its whole color treatment depending on who's using it — a light, friendly
header and softer background for the customer-facing "Report an issue" side, versus a dark, dense
"operations console" look for the staff console. `admin.html` goes further: a coral warning stripe
and a "Restricted" badge, since account management is the most sensitive screen in the system.
There is also **no way to switch between the customer and staff sides mid-session** — no "switch
view" button anywhere. Once someone is in one, the only way to the other is logging out and going
back to the landing page from scratch. This is purely visual/navigational — the actual access
control is still enforced by the API (`requireAuth` / `requireTier('admin')`), not by which page
someone happens to be looking at.

### New-ticket email notifications (optional, never blocks anything)

When a ticket is created — from the portal or logged by staff — the API sends a notification email
to everyone active who has an email on file, saying who raised it (name, role, email if given),
which system/module, and the description. This is **entirely separate from login** and never blocks
or delays ticket creation: if it fails or isn't configured, the request still succeeds.

To actually receive these, two things need to be true:
1. **The account needs an email on file** — set one when creating an account in `/admin.html`
   (now optional there), or add one later via "Set email" next to any existing account.
2. **SMTP needs to be configured** — set `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` (and usually
   `SMTP_PORT`/`SMTP_FROM`) in your environment variables. Gmail (with an
   [App Password](https://myaccount.google.com/apppasswords)), Resend, SendGrid, and Mailgun all
   work the same way — host, port, username, password.

If SMTP isn't configured, notifications are printed to the server console/logs instead (visible in
Render's "Logs" tab) — nothing breaks, you just won't get an actual email until it's set up.

### Where staff accounts get created

There is no self-signup. New staff accounts are created by an **admin** in one of two ways:

1. **The admin panel** — run the server and open `http://localhost:4000/admin.html` (or your
   deployed URL + `/admin.html`) in a browser. Log in with an admin account, then use the "Create
   an account" form (name, username, optional email, temporary password, role). You can deactivate
   accounts, issue a new temporary password, or set/update someone's email from the same page.
2. **Directly via the API** — `POST /api/users` with an admin's token (see below).

The seeded `admin` account (password `changeme123` — **change this immediately**, either via the
admin panel or `PATCH /api/auth/me/password`) is the one to log into `/admin.html` with. Give
Joshua, Antony, Lucy, and Kyle their own admin-created accounts too, rather than sharing the
seeded ones long-term.

Anyone who is deactivated is excluded from `/api/users/assignable`, so they stop showing up as an
option when assigning tickets, without deleting their history.

## 5. API reference

Base URL: `http://localhost:4000/api`

### Auth & accounts
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/auth/login` | — | `{ username, password }` → token. One step for every tier. |
| GET | `/auth/me` | staff | current user from token |
| PATCH | `/auth/me/password` | staff | `{ currentPassword, newPassword }` — change your own password |
| GET | `/users/assignable` | staff | active support/engineering staff (incl. email), for an "assign to" dropdown |
| GET | `/users` | admin | list every account, including inactive ones |
| POST | `/users` | admin | `{ username, name, email?, password, tier }` — email is optional, used only for notifications |
| PATCH | `/users/:username` | admin | `{ name?, email?, tier?, active? }` — update, set email, or deactivate/reactivate |
| POST | `/users/:username/reset-password` | admin | `{ newPassword }` — set someone else's password |

### Tickets
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/tickets` | public | create a ticket: `{ system, module, category, subject, description, requester, requesterEmail, requesterRole, priority, attachment? }`. `attachment` is `{ name, type, dataUrl }` — an optional image, base64 data URL, ~3MB max. |
| GET | `/tickets` | staff | list/filter: `?system=&module=&assignee=&priority=&status=&sla=&search=` (attachment data omitted here for speed — use the detail endpoint) |
| GET | `/tickets/lookup?email=` | public | a customer's own tickets, internal notes hidden |
| GET | `/tickets/:id` | staff | full detail incl. internal notes and any attachment |
| GET | `/tickets/:id/lookup?email=` | public | detail if `email` matches the requester |
| PATCH | `/tickets/:id` | staff | update `{ status, priority, assignee }` — team/SLA auto-managed |
| POST | `/tickets/:id/escalate` | staff | moves ticket to Engineering, unassigns, status → escalated |
| POST | `/tickets/:id/messages` | staff | `{ type: 'reply'|'note', body }` |
| POST | `/tickets/:id/messages/customer` | public | `{ email, body }` — must match requester email |
| PATCH | `/tickets/:id/messages/:msgId` | staff | `{ kb: true|false }` — toggle "save to knowledge base" |

### Systems & incidents
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/systems` | public | status + uptime % this month per system, e.g. for a status page |
| PATCH | `/systems/:name` | staff | `{ status: 'Operational'|'Degraded'|'Down' }` |
| GET | `/incidents` | public | incident feed |
| POST | `/incidents` | staff | log a new incident |
| POST | `/incidents/:id/resolve` | staff | marks resolved, rolls duration into monthly downtime |

### Reports & knowledge base
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/reports?period=daily\|weekly` | staff | see below — stats, a per-staff `scorecard`, and full `ticketsRaised` / `ticketsResolved` lists |
| GET | `/kb?search=` | public | documented fixes (ticket replies flagged `kb`) |

All ticket/incident IDs follow the same formats as the frontend (`EW-100xx`, `INC-10xx`).

### Reporting: activity log, staff scorecard, and Excel export

The Reports screen (`/` → Support console → Reports) is now split into four tabs so it's not one
long scrolling page:

- **Overview** — new requests, resolved, SLA compliance, avg. resolution time, backlog, and
  breakdowns by system/priority/assignee.
- **Staff scorecard** — one row per active support/engineer: tickets resolved, SLA compliance,
  avg. resolution time, replies sent, knowledge-base contributions, current workload.
- **Tickets raised** and **Tickets resolved** — the actual list of tickets in that period, each row
  showing the reference, subject, system/module, priority, status or SLA outcome, and the **support
  person in charge** (the assignee) — the "who raised what, who resolved what, who was responsible"
  record.

Each tab respects the Daily/Weekly toggle. Two ways to get a tab out of the browser:
- **Print** — a clean, letterhead-style printout of whichever tab is currently open (sidebar,
  buttons, and the tab bar itself are auto-hidden for print).
- **Export to Excel** — a real `.xlsx` workbook (built client-side with SheetJS, no server round
  trip) with four sheets regardless of which tab you're on: **Summary**, **Staff Scorecard**,
  **Tickets Raised**, and **Tickets Resolved** — open it directly in Excel or Google Sheets, no
  conversion needed. This is the "connect the data with an Excel sheet" piece — every report you
  pull is a real spreadsheet, not just numbers in a browser tab.

## 6. Alternate deployment options

Render is the fastest path (Section 2), but any Node-friendly host works:

- **Railway / Fly.io** — same idea as Render: connect the repo, set env vars from
  `.env.example`, deploy.
- **A VPS (e.g. a small Ubuntu box)** — `npm install --omit=dev`, run behind `pm2` or `systemd`,
  put Nginx in front for HTTPS. More setup, but you get a real persistent disk with no caveats.
- **Note on SQLite**: it's a single file, great for getting started but not built for multiple
  server instances writing at once. If you outgrow a single instance, migrate to Postgres — the
  schema in `src/db.js` is simple enough to port directly.

## 7. Known limitations (read before relying on this for real users)

- Account creation is intentionally admin-only — there's no public staff signup, by design, since
  anyone able to self-register as "engineering" would be a serious hole in a support tool. If you
  want a self-service request-access flow instead, that's a deliberate addition, not a bug fix.
- No rate limiting on login attempts, and no audit log of who changed what (e.g. who deactivated
  an account, who reassigned a ticket).
- Login is a single factor (password only) for every tier, including admin — simpler and more
  reliable than the emailed-code approach this used to have, but it does mean a leaked admin
  password is enough on its own. If you want two-factor back, it's a deliberate re-add, not a
  restored default — this version intentionally trades that off for something that works out of
  the box without an email provider.
- The "customer" endpoints trust whatever email is passed in — there's no verification (e.g. a
  magic link) that the person submitting is really that email's owner.
- Single JWT secret, no refresh tokens, no session revocation (a leaked token stays valid for the
  rest of its 12-hour life — deactivating the account doesn't invalidate tokens already issued).
- Screenshots are stored as base64 text directly in the SQLite database (capped at ~3MB each).
  That's simple and works, but it means a lot of attachments will bloat `data/eduwhizz.sqlite`
  noticeably faster than ticket text alone — fine for normal support-desk volumes, but if this
  gets heavy image traffic, moving attachments to real object storage (S3, R2, etc.) would be the
  next step.
- The Excel export runs entirely in the browser (via the SheetJS library loaded from a CDN) —
  no server involved, but it does mean export needs an internet connection to load that library
  the first time on a given device/session.
- New-ticket notification emails are fire-and-forget — if SMTP is down or misconfigured, the
  ticket is still created successfully but nobody gets emailed (it falls back to server logs).
  There's no retry queue or delivery confirmation.

None of these are hard to add, but they're genuinely important before this handles real customer
or account data — treat this as a solid, working foundation rather than a finished production
system.
