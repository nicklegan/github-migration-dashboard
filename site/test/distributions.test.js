import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attemptBreakdown,
  warningBreakdown,
  durationBreakdown,
  platformBreakdown,
  onboardingTeamBreakdown,
  onboardingOrgBreakdown,
  onboardingPlatformBreakdown,
  sizeDurationSeries,
  attemptBucketOf,
  warningBucketOf,
  durationBucketOf,
  onboardingLabelOf,
  platformLabelOf,
} from "../src/distributions.js";

const row = (over = {}) => ({
  id: "org-a/api",
  organization: "org-a",
  repository: "api",
  state: "SUCCEEDED",
  attemptCount: 1,
  warningsCount: 0,
  sourceType: "GitLab Source",
  sourceUrl: "https://gitlab.dev/gl/api",
  ...over,
});

test("a row falls in the bucket its value lands in", () => {
  assert.equal(attemptBucketOf({ attemptCount: 1 }), "1");
  assert.equal(attemptBucketOf({ attemptCount: 4 }), "4–9");
  assert.equal(attemptBucketOf({ attemptCount: 35 }), "10 or more");
  // A row that predates the count was migrated once.
  assert.equal(attemptBucketOf({}), "1");

  assert.equal(warningBucketOf({ warningsCount: 0 }), "None");
  assert.equal(warningBucketOf({ warningsCount: 12 }), "11–50");
  assert.equal(warningBucketOf({ warningsCount: 1338 }), "Over 200");
  assert.equal(warningBucketOf({}), "None");

  assert.equal(durationBucketOf({ durationMinutes: 1 }), "Under 2 min");
  assert.equal(durationBucketOf({ durationMinutes: 45 }), "16–60 min");
  assert.equal(durationBucketOf({ durationMinutes: 90 }), "Over an hour");
});

// A duration is only known where the audit log recorded it; inventing a bucket
// would put those rows in the chart as if they had been instant.
test("a repository with no recorded duration is in no duration bucket", () => {
  assert.equal(durationBucketOf({ durationMinutes: null }), null);
  assert.equal(durationBucketOf({}), null);
  const buckets = durationBreakdown([row({ durationMinutes: 3 }), row({ durationMinutes: null })]);
  assert.deepEqual(buckets, [{ duration: "2–5 min", repositories: 1 }]);
});

// A distribution read largest-first is not a distribution.
test("buckets keep their own order, and empty ones are dropped", () => {
  const rows = [
    row({ attemptCount: 1 }),
    row({ attemptCount: 1 }),
    row({ attemptCount: 35, state: "SUCCEEDED" }),
    row({ attemptCount: 4, state: "FAILED" }),
  ];
  assert.deepEqual(
    attemptBreakdown(rows).map((b) => b.attempts),
    ["1", "4–9", "10 or more"],
  );
});

test("an attempt bucket splits by how those repositories ended", () => {
  const [first] = attemptBreakdown([
    row({ attemptCount: 2, state: "SUCCEEDED" }),
    row({ attemptCount: 2, state: "FAILED" }),
    row({ attemptCount: 2, state: "IN_PROGRESS" }),
  ]);
  assert.deepEqual(first, { attempts: "2", succeeded: 1, failed: 1, other: 1 });
});

test("warnings count repositories, not warnings", () => {
  const buckets = warningBreakdown([
    row({ warningsCount: 0 }),
    row({ warningsCount: 5 }),
    row({ warningsCount: 7 }),
  ]);
  assert.deepEqual(buckets, [
    { warnings: "None", repositories: 1 },
    { warnings: "1–10", repositories: 2 },
  ]);
});

// Named categories are ranked like every other breakdown; only buckets keep
// their given order.
test("platforms are ranked by size and split by state", () => {
  const rows = [
    row({ sourceType: "GitLab Source", sourceUrl: "https://gitlab.dev/a/b" }),
    row({ sourceType: "GitLab Source", sourceUrl: "https://gitlab.dev/a/c", state: "FAILED" }),
    row({ sourceType: "GHEC Source", sourceUrl: "https://github.com/o/r" }),
  ];
  assert.deepEqual(platformBreakdown(rows), [
    { sourcePlatform: "GitLab", succeeded: 1, failed: 1, other: 0 },
    { sourcePlatform: "GHEC", succeeded: 1, failed: 0, other: 0 },
  ]);
});

test("a source no platform could be read from is grouped as Unknown", () => {
  assert.equal(platformLabelOf(row({ sourceType: "team/project", sourceUrl: "https://x.dev/a/b" })), "Unknown");
});

test("onboarding is grouped by team and by organization, laggards included", () => {
  const rows = [
    row({ team: "Payments", onboarding: "complete" }),
    row({ team: "Payments", onboarding: "incomplete" }),
    row({ team: null, organization: "org-b", onboarding: "in-progress" }),
    // A repository the window does not apply to counts nowhere.
    row({ team: "Payments", onboarding: null }),
  ];
  assert.deepEqual(onboardingTeamBreakdown(rows), [
    { team: "Payments", inProgress: 0, complete: 1, incomplete: 1 },
    { team: "Unassigned", inProgress: 1, complete: 0, incomplete: 0 },
  ]);
  assert.deepEqual(onboardingOrgBreakdown(rows).map((o) => o.org), ["org-a", "org-b"]);
  assert.equal(onboardingLabelOf({ onboarding: "in-progress" }), "Onboarding");
  assert.equal(onboardingLabelOf({ onboarding: null }), null);
});

// The size axis is logarithmic, so a zero-byte repository has no place on it;
// neither has one whose duration was never recorded.
test("the scatter plots only repositories with both a size and a duration", () => {
  const { series, plotted, total } = sizeDurationSeries([
    row({ repoSizeMB: 12, durationMinutes: 3 }),
    row({ repoSizeMB: 400, durationMinutes: 9 }),
    row({ repoSizeMB: 0, durationMinutes: 2 }),
    row({ repoSizeMB: 5, durationMinutes: null }),
    row({ repoSizeMB: 8, durationMinutes: 4, sourceType: "GHEC Source", sourceUrl: "https://github.com/o/r" }),
  ]);
  assert.equal(plotted, 3);
  assert.equal(total, 5);
  assert.deepEqual(series.map((s) => [s.platform, s.points.length]), [
    ["GitLab", 2],
    ["GHEC", 1],
  ]);
  assert.deepEqual(series[1].points[0], {
    id: "org-a/api",
    organization: "org-a",
    repository: "api",
    sizeMB: 8,
    minutes: 4,
  });
});

// Whether a source system's repositories come back to life inside the window is
// the nearest thing the stored data has to how long they take to get right.
test("onboarding is grouped by source platform too", () => {
  const gitlab = (over) => row({ sourceType: "GitLab Source", sourceUrl: "https://gitlab.dev/a/b", ...over });
  const ado = (over) => row({ sourceType: "Azure DevOps Source", sourceUrl: "https://dev.azure.com/o/p/_git/r", ...over });
  const breakdown = onboardingPlatformBreakdown([
    gitlab({ onboarding: "complete" }),
    gitlab({ onboarding: "complete" }),
    gitlab({ onboarding: "incomplete" }),
    ado({ onboarding: "incomplete" }),
    ado({ onboarding: "in-progress" }),
  ]);
  assert.deepEqual(breakdown, [
    { sourcePlatform: "GitLab", inProgress: 0, complete: 2, incomplete: 1 },
    { sourcePlatform: "Azure DevOps", inProgress: 1, complete: 0, incomplete: 1 },
  ]);
});

test("an empty selection produces empty breakdowns, not placeholder rows", () => {
  assert.deepEqual(attemptBreakdown([]), []);
  assert.deepEqual(warningBreakdown([]), []);
  assert.deepEqual(platformBreakdown([]), []);
  assert.deepEqual(sizeDurationSeries([]).series, []);
});
