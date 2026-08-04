const SYSTEMS = {
  'School ERP': ['Manager Console', 'CRM Console', 'Director Console', 'Teachers App', 'Guardian App'],
  'Rent Management': ['Admin Console', 'Landlord Portal', 'Tenant Portal', 'Payments Module'],
  'Pharmacy Management': ['Admin Console', 'Inventory & Stock', 'POS / Sales', 'Prescription Desk'],
};

const CATEGORIES = ['Bug', 'Access Request', 'Performance', 'Data Issue', 'Feature Request', 'Outage'];

const REPORTER_ROLES = [
  'Manager', 'Director', 'CRM User', 'Teacher', 'Guardian',
  'Tenant', 'Landlord', 'Pharmacy Staff', 'Other',
];

// name -> tier, used to auto-derive a ticket's team when it's assigned to someone
const TEAM = [
  { username: 'joshua', name: 'Joshua', tier: 'support' },
  { username: 'antony', name: 'Antony', tier: 'support' },
  { username: 'lucy', name: 'Lucy', tier: 'engineering' },
  { username: 'kyle', name: 'Kyle', tier: 'engineering' },
];

const PRIORITIES = {
  critical: { label: 'Critical', responseMin: 30, resolveMin: 240 },
  high: { label: 'High', responseMin: 60, resolveMin: 480 },
  normal: { label: 'Normal', responseMin: 240, resolveMin: 1440 },
  low: { label: 'Low', responseMin: 480, resolveMin: 4320 },
};

function tierOfName(name) {
  const m = TEAM.find((t) => t.name === name);
  return m ? m.tier : 'support';
}

function slaResolveBy(ticket) {
  const p = PRIORITIES[ticket.priority] || PRIORITIES.normal;
  return ticket.created_at + p.resolveMin * 60000;
}

function slaState(ticket) {
  const due = slaResolveBy(ticket);
  if (ticket.status === 'resolved' || ticket.status === 'closed') {
    const finishedAt = ticket.resolved_at || ticket.updated_at;
    return finishedAt <= due ? 'met' : 'breached';
  }
  const now = Date.now();
  if (now > due) return 'breached';
  const total = due - ticket.created_at;
  const remaining = due - now;
  if (remaining < total * 0.2) return 'at_risk';
  return 'on_track';
}

module.exports = { SYSTEMS, CATEGORIES, REPORTER_ROLES, TEAM, PRIORITIES, tierOfName, slaResolveBy, slaState };
