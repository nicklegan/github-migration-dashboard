import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterByRange,
  computeKpis,
  stateBreakdown,
  teamBreakdown,
  orgBreakdown,
  onboardingBreakdown,
  workflowTotals,
  workflowTeamBreakdown,
  workflowOrgBreakdown,
  workflowPlatformBreakdown,
} from "../src/kpis.js";

const rows = [
  { organization: "org-a", state: "SUCCEEDED", warningsCount: 0, durationMinutes: 10, repoSizeMB: 100, team: "A", workflows: { succeeded: 2, failing: 1, idle: 0 } },
  { organization: "org-a", state: "SUCCEEDED", warningsCount: 2, durationMinutes: 20, repoSizeMB: 300, team: "A", workflows: { succeeded: 1, failing: 0, idle: 3 } },
  { organization: "org-b", state: "FAILED", warningsCount: 0, durationMinutes: null, repoSizeMB: null, team: "B", workflows: null },
  { organization: "org-b", state: "IN_PROGRESS", warningsCount: 0, durationMinutes: null, repoSizeMB: null, team: null, workflows: null },
];

test("computeKpis aggregates totals, rates, and averages", () => {
  const k = computeKpis(rows);
  assert.equal(k.total, 4);
  assert.equal(k.succeeded, 2);
  assert.equal(k.failed, 1);
  assert.equal(k.ongoing, 1);
  assert.equal(k.withWarnings, 1);
  assert.equal(k.successRate, 2 / 3);
  assert.equal(k.avgWarnings, 0.5);
  assert.equal(k.avgDurationMinutes, 15);
  assert.equal(k.avgRepoSizeMB, 200);
});

test("computeKpis handles an empty set", () => {
  const k = computeKpis([]);
  assert.equal(k.total, 0);
  assert.equal(k.successRate, null);
  assert.equal(k.avgDurationMinutes, null);
  assert.equal(k.avgWarnings, null);
});

test("stateBreakdown counts and sorts by frequency", () => {
  const b = stateBreakdown(rows);
  assert.deepEqual(b[0], { state: "SUCCEEDED", count: 2 });
  assert.equal(b.length, 3);
});

test("teamBreakdown buckets by team with Unassigned fallback", () => {
  const t = teamBreakdown(rows);
  const a = t.find((x) => x.team === "A");
  assert.equal(a.succeeded, 2);
  assert.ok(t.some((x) => x.team === "Unassigned"));
});

test("orgBreakdown buckets repos by organization", () => {
  const o = orgBreakdown(rows);
  const a = o.find((x) => x.org === "org-a");
  const b = o.find((x) => x.org === "org-b");
  assert.equal(a.succeeded, 2);
  assert.equal(b.failed, 1);
  assert.equal(b.other, 1);
});

test("workflowTotals sums, rates, totals, and failing repos", () => {
  const p = workflowTotals(rows);
  assert.equal(p.succeeded, 3);
  assert.equal(p.failing, 1);
  assert.equal(p.idle, 3);
  assert.equal(p.total, 7);
  assert.equal(p.failingRepos, 1);
  assert.equal(p.successRate, 3 / 4);
});

test("workflowTeamBreakdown and workflowOrgBreakdown only include repos with workflows", () => {
  const byTeam = workflowTeamBreakdown(rows);
  assert.equal(byTeam.length, 1);
  assert.equal(byTeam[0].team, "A");
  assert.equal(byTeam[0].succeeded, 3);

  const byOrg = workflowOrgBreakdown(rows);
  assert.equal(byOrg.length, 1);
  assert.equal(byOrg[0].org, "org-a");
  assert.equal(byOrg[0].idle, 3);
});

// Workflow health against where the code came from, which a repository-level
// success count cannot show: both these migrations succeeded.
test("workflowPlatformBreakdown splits workflow health by source system", () => {
  const platformRows = [
    { ...rows[0], sourceType: "GitLab Source", sourceUrl: "https://gitlab.dev/a/b" },
    { ...rows[1], sourceType: "Azure DevOps Source", sourceUrl: "https://dev.azure.com/o/p/_git/r" },
    { ...rows[2], sourceType: "GitLab Source", sourceUrl: "https://gitlab.dev/a/c" },
  ];
  assert.deepEqual(workflowPlatformBreakdown(platformRows), [
    { sourcePlatform: "Azure DevOps", succeeded: 1, failing: 0, idle: 3 },
    { sourcePlatform: "GitLab", succeeded: 2, failing: 1, idle: 0 },
  ]);
});

test("filterByRange keeps only rows within the window, 'all' returns everything", () => {
  const now = Date.parse("2026-09-01T00:00:00Z");
  const dated = [
    { createdAt: "2026-08-31T00:00:00Z" }, // within 24h and 7d and month
    { createdAt: "2026-08-20T00:00:00Z" }, // within month only
    { createdAt: "2026-07-01T00:00:00Z" }, // within 3 months only
    { createdAt: "2026-01-01T00:00:00Z" }, // outside all windows
  ];
  assert.equal(filterByRange(dated, "all", now).length, 4);
  assert.equal(filterByRange(dated, "quarter", now).length, 3);
  assert.equal(filterByRange(dated, "month", now).length, 2);
  assert.equal(filterByRange(dated, "week", now).length, 1);
  assert.equal(filterByRange(dated, "day", now).length, 1);
});

// Onboarding is measured against each repository's own window, so narrowing it
// by migration date on top of that would hide the repositories whose window
// closed long ago without their workflows coming back — the overdue ones.
test("onboarding counts do not depend on the selected time range", () => {
  const now = Date.parse("2026-09-01T00:00:00Z");
  const rows = [
    { createdAt: "2026-01-01T00:00:00Z", onboarding: "incomplete" },
    { createdAt: "2026-03-01T00:00:00Z", onboarding: "complete" },
    { createdAt: "2026-08-28T00:00:00Z", onboarding: "in-progress" },
  ];
  const scoped = onboardingBreakdown(rows);
  assert.deepEqual(scoped, { inProgress: 1, complete: 1, incomplete: 1 });
  // Through the range filter the two settled repositories would disappear, and
  // the one left would report nothing outstanding.
  assert.deepEqual(onboardingBreakdown(filterByRange(rows, "week", now)), {
    inProgress: 1,
    complete: 0,
    incomplete: 0,
  });
});
