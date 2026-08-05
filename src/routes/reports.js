const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { SYSTEMS, PRIORITIES, slaState } = require('../utils/config');
const { listAssignableStaff } = require('../utils/staff');

const router = express.Router();

function periodBounds(period) {
  const now = new Date();
  if (period === 'weekly') return [Date.now() - 1000 * 60 * 60 * 24 * 7, Date.now()];
  return [new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), Date.now()];
}

// GET /api/reports?period=daily|weekly  (staff: the numbers behind the daily/weekly submission)
router.get('/', requireAuth, (req, res) => {
  const period = req.query.period === 'weekly' ? 'weekly' : 'daily';
  const [start, end] = periodBounds(period);

  const allTickets = db.prepare('SELECT * FROM tickets').all();
  const created = allTickets.filter((t) => t.created_at >= start && t.created_at <= end);
  const resolved = allTickets.filter((t) => t.resolved_at && t.resolved_at >= start && t.resolved_at <= end);

  const bySystem = {};
  Object.keys(SYSTEMS).forEach((s) => (bySystem[s] = 0));
  created.forEach((t) => (bySystem[t.system] = (bySystem[t.system] || 0) + 1));

  const byPriority = {};
  Object.keys(PRIORITIES).forEach((p) => (byPriority[p] = 0));
  created.forEach((t) => (byPriority[t.priority] = (byPriority[t.priority] || 0) + 1));

  const byAssignee = { Unassigned: 0 };
  listAssignableStaff().forEach((m) => (byAssignee[m.name] = 0));
  allTickets
    .filter((t) => t.status !== 'resolved' && t.status !== 'closed')
    .forEach((t) => (byAssignee[t.assignee] = (byAssignee[t.assignee] || 0) + 1));

  const metCount = resolved.filter((t) => slaState(t) === 'met').length;
  const slaCompliance = resolved.length ? (metCount / resolved.length) * 100 : 100;
  const avgResolutionHours = resolved.length
    ? resolved.reduce((sum, t) => sum + (t.resolved_at - t.created_at), 0) / resolved.length / 3600000
    : 0;

  const incidents = db.prepare('SELECT * FROM incidents').all();
  const incInPeriod = incidents.filter((i) => i.started_at >= start && i.started_at <= end);
  const downtimeMinutes = incInPeriod.reduce(
    (sum, i) => sum + ((i.resolved_at || Date.now()) - i.started_at) / 60000,
    0
  );

  const openBacklog = allTickets.filter((t) => t.status !== 'resolved' && t.status !== 'closed').length;
  const breached = allTickets.filter(
    (t) => t.status !== 'resolved' && t.status !== 'closed' && slaState(t) === 'breached'
  ).length;

  // Per-staff scorecard: what each active support/engineering person actually did in this period.
  // Non-admins only ever see their own row here \u2014 "each support team member should just view
  // their own progress" \u2014 admins see everyone's, since they need the full picture.
  const isAdmin = req.user.tier === 'admin';
  const staff = isAdmin ? listAssignableStaff() : listAssignableStaff().filter((m) => m.name === req.user.name);
  const allThreadRows = db.prepare('SELECT tt.*, t.created_at AS ticket_created_at FROM ticket_thread tt JOIN tickets t ON t.id = tt.ticket_id').all();
  const scorecard = staff.map((m) => {
    const theirResolved = resolved.filter((t) => t.assignee === m.name);
    const theirMet = theirResolved.filter((t) => slaState(t) === 'met').length;
    const theirAvgHours = theirResolved.length
      ? theirResolved.reduce((sum, t) => sum + (t.resolved_at - t.created_at), 0) / theirResolved.length / 3600000
      : 0;
    const currentOpenLoad = allTickets.filter(
      (t) => t.assignee === m.name && t.status !== 'resolved' && t.status !== 'closed'
    ).length;
    const repliesInPeriod = allThreadRows.filter(
      (r) => r.author === m.name && r.type === 'reply' && r.at >= start && r.at <= end
    ).length;
    const kbContributions = allThreadRows.filter((r) => r.author === m.name && r.kb).length;

    return {
      username: m.username,
      name: m.name,
      tier: m.tier,
      ticketsResolved: theirResolved.length,
      slaCompliancePct: theirResolved.length ? Number(((theirMet / theirResolved.length) * 100).toFixed(1)) : null,
      avgResolutionHours: theirResolved.length ? Number(theirAvgHours.toFixed(1)) : null,
      currentOpenLoad,
      repliesSent: repliesInPeriod,
      knowledgeBaseContributions: kbContributions,
    };
  });

  // Same principle for the workload breakdown \u2014 a non-admin sees only their own count, not
  // how much everyone else on the team currently has open.
  const scopedByAssignee = isAdmin ? byAssignee : { [req.user.name]: byAssignee[req.user.name] || 0 };

  function ticketRow(t) {
    return {
      id: t.id,
      subject: t.subject,
      system: t.system,
      module: t.module,
      category: t.category,
      priority: t.priority,
      status: t.status,
      assignee: t.assignee,
      team: t.team,
      requester: t.requester_name,
      requesterRole: t.requester_role || '',
      origin: t.origin,
      createdAt: t.created_at,
      resolvedAt: t.resolved_at,
      slaState: slaState(t),
    };
  }

  // Ticket-level lists follow the same queue-visibility rule as GET /api/tickets: non-admins see
  // only what's assigned to them, or unassigned tickets they could still pick up.
  const visibleCreated = isAdmin ? created : created.filter((t) => t.assignee === req.user.name || t.assignee === 'Unassigned');
  const visibleResolved = isAdmin ? resolved : resolved.filter((t) => t.assignee === req.user.name);

  res.json({
    period,
    start,
    end,
    newRequests: created.length,
    resolved: resolved.length,
    slaCompliancePct: Number(slaCompliance.toFixed(1)),
    avgResolutionHours: Number(avgResolutionHours.toFixed(1)),
    openBacklog,
    currentlyBreached: breached,
    incidentsLogged: incInPeriod.length,
    downtimeMinutes: Math.round(downtimeMinutes),
    bySystem,
    byPriority,
    byAssigneeOpenLoad: scopedByAssignee,
    scorecard,
    ticketsRaised: visibleCreated.sort((a, b) => b.created_at - a.created_at).map(ticketRow),
    ticketsResolved: visibleResolved.sort((a, b) => b.resolved_at - a.resolved_at).map(ticketRow),
  });
});

module.exports = router;
