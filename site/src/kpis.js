// Pure aggregation of the migration rows into the dashboard's KPIs and
// breakdowns. No React or DOM here so it unit-tests directly.

import { ONGOING_STATES } from "../../src/states.js";


const RANGE_MS = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  quarter: 90 * 24 * 60 * 60 * 1000,
};

// Filters migrations to those created within `range` of `nowMs`. An unknown
// range (e.g. "all") returns every row.
function filterByRange(migrations, range, nowMs) {
  const span = RANGE_MS[range];
  if (!span) return migrations;
  const cutoff = nowMs - span;
  return migrations.filter((m) => {
    const created = Date.parse(m.createdAt);
    return Number.isFinite(created) && created >= cutoff;
  });
}

function computeKpis(migrations) {
  const total = migrations.length;
  let succeeded = 0;
  let failed = 0;
  let ongoing = 0;
  let withWarnings = 0;
  const warnings = [];
  const durations = [];
  const sizes = [];

  for (const m of migrations) {
    if (m.state === "SUCCEEDED") succeeded += 1;
    else if (m.state === "FAILED") failed += 1;
    if (ONGOING_STATES.has(m.state)) ongoing += 1;
    const warningCount = m.warningsCount ?? 0;
    if (warningCount > 0) withWarnings += 1;
    warnings.push(warningCount);
    if (typeof m.durationMinutes === "number") durations.push(m.durationMinutes);
    if (typeof m.repoSizeMB === "number") sizes.push(m.repoSizeMB);
  }

  const completed = succeeded + failed;
  return {
    total,
    succeeded,
    failed,
    ongoing,
    withWarnings,
    successRate: completed ? succeeded / completed : null,
    avgWarnings: average(warnings),
    avgDurationMinutes: average(durations),
    // A duration only exists where the audit log recorded the repository coming
    // online, so the average covers a subset. Carrying the sample size lets the
    // card say so instead of implying it covers the estate.
    durationSamples: durations.length,
    avgRepoSizeMB: average(sizes),
    repoSizeSamples: sizes.length,
  };
}

function stateBreakdown(migrations) {
  const counts = new Map();
  for (const m of migrations) counts.set(m.state, (counts.get(m.state) ?? 0) + 1);
  return [...counts.entries()]
    .map(([state, count]) => ({ state, count }))
    .sort((a, b) => b.count - a.count);
}

function teamBreakdown(migrations) {
  const byTeam = new Map();
  for (const m of migrations) {
    const team = m.team || "Unassigned";
    const entry = byTeam.get(team) ?? { team, succeeded: 0, failed: 0, other: 0 };
    if (m.state === "SUCCEEDED") entry.succeeded += 1;
    else if (m.state === "FAILED") entry.failed += 1;
    else entry.other += 1;
    byTeam.set(team, entry);
  }
  return [...byTeam.values()].sort(
    (a, b) => b.succeeded + b.failed + b.other - (a.succeeded + a.failed + a.other),
  );
}

function orgBreakdown(migrations) {
  const byOrg = new Map();
  for (const m of migrations) {
    const org = m.organization || "Unknown";
    const entry = byOrg.get(org) ?? { org, succeeded: 0, failed: 0, other: 0 };
    if (m.state === "SUCCEEDED") entry.succeeded += 1;
    else if (m.state === "FAILED") entry.failed += 1;
    else entry.other += 1;
    byOrg.set(org, entry);
  }
  return [...byOrg.values()].sort(
    (a, b) => b.succeeded + b.failed + b.other - (a.succeeded + a.failed + a.other),
  );
}

// Where each repository stands against its onboarding window. Repositories the
// window does not apply to (failed, deleted, or window disabled) count nowhere.
function onboardingBreakdown(migrations) {
  const totals = { inProgress: 0, complete: 0, incomplete: 0 };
  for (const m of migrations) {
    if (m.onboarding === "in-progress") totals.inProgress += 1;
    else if (m.onboarding === "complete") totals.complete += 1;
    else if (m.onboarding === "incomplete") totals.incomplete += 1;
  }
  return totals;
}

function workflowTotals(migrations) {
  const totals = { succeeded: 0, failing: 0, idle: 0 };
  let failingRepos = 0;
  let manual = 0;
  let postOnboarding = 0;
  for (const m of migrations) {
    if (!m.workflows) continue;
    totals.succeeded += m.workflows.succeeded ?? 0;
    totals.failing += m.workflows.failing ?? 0;
    totals.idle += m.workflows.idle ?? 0;
    manual += m.workflows.manual ?? 0;
    postOnboarding += m.workflows.postOnboarding ?? 0;
    if ((m.workflows.failing ?? 0) > 0) failingRepos += 1;
  }
  const rated = totals.succeeded + totals.failing;
  return {
    ...totals,
    total: totals.succeeded + totals.failing + totals.idle,
    failingRepos,
    manual,
    postOnboarding,
    successRate: rated ? totals.succeeded / rated : null,
  };
}

function workflowTeamBreakdown(migrations) {
  return workflowGroupBy(migrations, (m) => m.team || "Unassigned", "team");
}

function workflowOrgBreakdown(migrations) {
  return workflowGroupBy(migrations, (m) => m.organization || "Unknown", "org");
}

function workflowGroupBy(migrations, keyOf, keyName) {
  const groups = new Map();
  for (const m of migrations) {
    if (!m.workflows) continue;
    const key = keyOf(m);
    const entry = groups.get(key) ?? { [keyName]: key, succeeded: 0, failing: 0, idle: 0 };
    entry.succeeded += m.workflows.succeeded ?? 0;
    entry.failing += m.workflows.failing ?? 0;
    entry.idle += m.workflows.idle ?? 0;
    groups.set(key, entry);
  }
  return [...groups.values()].sort(
    (a, b) => b.succeeded + b.failing + b.idle - (a.succeeded + a.failing + a.idle),
  );
}

function average(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export {
  filterByRange,
  computeKpis,
  stateBreakdown,
  teamBreakdown,
  orgBreakdown,
  onboardingBreakdown,
  workflowTotals,
  workflowTeamBreakdown,
  workflowOrgBreakdown,
};
