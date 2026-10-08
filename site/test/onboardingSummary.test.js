import { test } from "node:test";
import assert from "node:assert/strict";
import { onboardingSummary, summaryText } from "../src/onboardingSummary.js";

const status = {
  inProgress: 237,
  complete: 202,
  onTimeSettled: 96,
  late: 37,
  incomplete: 72,
  noWorkflows: 6,
  settled: 205,
};
const overall = { median: { days: 68.5 }, by: { 7: { share: 0.161 }, 30: { share: 0.3 } } };
const period = (key, label, median, early) => ({
  key,
  label,
  phrase: `in ${label}`,
  median: median == null ? null : { days: median },
  by: { 7: early == null ? null : { share: early }, 30: null },
});

const text = (input) => summaryText(onboardingSummary({ windowDays: 60, ...input }));

test("the closed windows are told as shares that add up, and the open ones apart", () => {
  const out = text({ status, overall, periods: [] });
  assert.match(
    out,
    /^Of the 205 repositories whose 60-day window has closed, 47% had every workflow green in time, 18% got there late, and 35% still have a workflow failing or never run\. /,
  );
  // 237 still onboarding plus the 106 already green inside an open window.
  assert.match(out, /Another 343 are still inside their window, 106 of them already fully green\./);
});

test("the speed is set against the window", () => {
  assert.match(text({ status, overall }), /16% are fully green within a week, and half take 69 days — longer than the 60-day window\./);
  const quick = { median: { days: 12 }, by: { 7: { share: 0.4 } } };
  assert.match(text({ status, overall: quick }), /half take 12 days — inside the 60-day window\./);
});

test("a median not reached yet says so instead of inventing one", () => {
  const out = text({ status, overall: { median: { days: null, over: 41 }, by: {} } });
  assert.match(out, /Fewer than half are fully green after 41 days\./);
});

test("two comparisons pointing different ways are joined with but", () => {
  const periods = [period("q2", "Q2 2026", 70.2, 0.18), period("q3", "Q3 2026", 62.7, 0.16)];
  assert.match(
    text({ status, overall, periods }),
    /Compared with repositories migrated in Q2 2026, those migrated in Q3 2026 became fully green faster \(median 63 vs 70 days\), but were less often fully green within a week \(16% vs 18%\)\./,
  );
});

test("two comparisons pointing the same way are joined with and", () => {
  const periods = [period("q2", "Q2 2026", 70, 0.1), period("q3", "Q3 2026", 40, 0.3)];
  assert.match(text({ status, overall, periods }), /became fully green faster \(median 40 vs 70 days\), and were more often fully green within a week/);
});

test("a difference within noise is called level, not a trend", () => {
  const periods = [period("q2", "Q2 2026", 50.4, 0.201), period("q3", "Q3 2026", 50, 0.205)];
  const out = text({ status, overall, periods });
  assert.match(out, /took about as long to become fully green/);
  assert.match(out, /were about as often fully green within a week/);
});

test("each figure compares the latest two periods that have it", () => {
  // Q4 is too new for a median but already has a first week.
  const periods = [
    period("q2", "Q2 2026", 70, 0.18),
    period("q3", "Q3 2026", 63, 0.16),
    period("q4", "Q4 2026", null, 0.3),
  ];
  const out = text({ status, overall, periods });
  assert.match(out, /Compared with repositories migrated in Q2 2026, those migrated in Q3 2026 became fully green faster/);
  assert.match(
    out,
    /Compared with repositories migrated in Q3 2026, those migrated in Q4 2026 were more often fully green within a week \(30% vs 16%\)\./,
  );
});

test("with nothing to compare it says it is too early", () => {
  assert.match(
    text({ status, overall, periods: [period("q3", "Q3 2026", 63, 0.16)] }),
    /Too few repositories have been migrated long enough ago to compare periods yet\./,
  );
});

test("before any window has closed it leads with what is still open", () => {
  const fresh = { inProgress: 40, complete: 12, onTimeSettled: 0, late: 0, incomplete: 0, settled: 0 };
  const out = text({ status: fresh, overall: { median: null, by: {} } });
  assert.match(out, /^No repository's 60-day window has closed yet\. 52 are still inside their window, 12 of them already fully green\./);
});

test("no window, no summary", () => {
  assert.deepEqual(onboardingSummary({ status, overall, windowDays: 0 }), []);
});
