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

## 4. Authentication & accounts

`POST /api/auth/login` with `{ "username": "...", "password": "..." }`:
- For **support/engineering** accounts, returns a token immediately:
  ```json
  { "token": "eyJ...", "user": { "username": "lucy", "name": "Lucy", "tier": "engineering" } }
  ```
- For **admin** accounts, this is a two-step process (see below) — the response is instead
  `{ "otpRequired": true, "otpToken": "...", "maskedEmail": "ad***@yourcompany.com" }`, and no
  access token is issued until the code is verified.

Send the access token back as `Authorization: Bearer <token>` on staff-only endpoints. Tokens
expire after 12 hours (see `JWT_SECRET` / expiry in `src/middleware/auth.js`). Deactivated
accounts get a `403` on login, even with the correct password.

Portal endpoints (customers submitting or tracking their own requests) do **not** require a
token — there's no customer account system here, only an email-match check.

### Admin sign-in requires a second factor (emailed code)

Because admin accounts can create/deactivate accounts and see everything, logging in as one takes
an extra step: after the correct password, a 6-digit code is emailed to that admin's address, and
`POST /api/auth/verify-otp` with `{ "otpToken": "...", "code": "123456" }` is required to actually
get an access token. Codes expire after 10 minutes, are single-use, and lock out after 5 wrong
attempts (asking the admin to log in again for a fresh code). This applies both on `/admin.html`
and if an admin account signs into the main support console.

**For this to actually email anyone, you need to configure SMTP** — set `SMTP_HOST`, `SMTP_USER`,
`SMTP_PASS` (and usually `SMTP_PORT`/`SMTP_FROM`) in your environment variables. Any standard
provider works, for example:
- **Gmail**: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER=youraddress@gmail.com`,
  `SMTP_PASS=` an [App Password](https://myaccount.google.com/apppasswords) (not your normal
  Gmail password — Gmail blocks that for SMTP).
- **Resend / SendGrid / Mailgun**: sign up, verify a sending domain or address, use their SMTP
  credentials the same way.

**If you don't set these up right away**, the app doesn't break — codes are printed to the server
console/logs instead (visible in Render's "Logs" tab). That's a real but inconvenient fallback:
fine for testing today, not something to rely on for actual daily use, since it means checking
server logs every time an admin needs to log in.

Also set `SEED_ADMIN_EMAIL` to a real address before running `npm run seed` for the first time —
otherwise the seeded `admin` account gets a placeholder email and can only receive codes via the
log fallback until someone edits its email through the admin panel itself (a bit of a chicken-and-egg
problem, so it's worth setting this up front).

### Where staff accounts get created

There is no self-signup. New staff accounts are created by an **admin** in one of two ways:

1. **The admin panel** — run the server and open `http://localhost:4000/admin.html` (or your
   deployed URL + `/admin.html`) in a browser. Log in with an admin account (password, then
   emailed code), then use the "Create an account" form — this now also collects an email address,
   required for admin-tier accounts. You can deactivate accounts, issue a new temporary password,
   or update someone's email from the same page.
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
| POST | `/auth/login` | — | `{ username, password }` → token, or `{ otpRequired: true, otpToken }` for admins |
| POST | `/auth/verify-otp` | — | `{ otpToken, code }` → token. Required to finish an admin login. |
| GET | `/auth/me` | staff | current user from token |
| PATCH | `/auth/me/password` | staff | `{ currentPassword, newPassword }` — change your own password |
| GET | `/users/assignable` | staff | active support/engineering staff, for an "assign to" dropdown |
| GET | `/users` | admin | list every account, including inactive ones |
| POST | `/users` | admin | `{ username, name, email, password, tier }` — email required for admin tier |
| PATCH | `/users/:username` | admin | `{ name?, email?, tier?, active? }` — update or deactivate/reactivate |
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
| GET | `/reports?period=daily\|weekly` | staff | the numbers behind your daily/weekly submission, plus a per-staff `scorecard` array |
| GET | `/kb?search=` | public | documented fixes (ticket replies flagged `kb`) |

All ticket/incident IDs follow the same formats as the frontend (`EW-100xx`, `INC-10xx`).

### Printable staff scorecard

The Reports screen in the console (`/` → Support console → Reports) now includes a **Staff
scorecard** table alongside the usual daily/weekly numbers — resolved tickets, SLA compliance,
average resolution time, replies sent, knowledge-base contributions, and current workload, one row
per active support/engineer. Click **Print** there for a clean, letterhead-style printout (the
sidebar, buttons, and everything else are hidden automatically for print) — that's the "documented
workflow for scorecard purposes" piece. **Download report** produces the same data as a plain-text
file if you'd rather attach it somewhere than print it.

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
- No rate limiting on login attempts beyond the 5-try OTP lockout, and no audit log of who changed
  what (e.g. who deactivated an account, who reassigned a ticket).
- The "customer" endpoints trust whatever email is passed in — there's no verification (e.g. a
  magic link or OTP) that the person submitting is really that email's owner. (Admins now do get
  OTP verification; customers still don't, since forcing them through email verification just to
  file a request would add friction most support desks don't want at intake.)
- Single JWT secret, no refresh tokens, no session revocation (a leaked token stays valid for the
  rest of its 12-hour life — deactivating the account doesn't invalidate tokens already issued).
- Screenshots are stored as base64 text directly in the SQLite database (capped at ~3MB each).
  That's simple and works, but it means a lot of attachments will bloat `data/eduwhizz.sqlite`
  noticeably faster than ticket text alone — fine for normal support-desk volumes, but if this
  gets heavy image traffic, moving attachments to real object storage (S3, R2, etc.) would be the
  next step.
- The OTP email code depends entirely on SMTP being configured (Section 4). Until it is, admin
  codes only reach you via server logs — workable for testing, not for daily reliance.

None of these are hard to add, but they're genuinely important before this handles real customer
or account data — treat this as a solid, working foundation rather than a finished production
system.
