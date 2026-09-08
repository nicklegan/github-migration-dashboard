import { test } from "node:test";
import assert from "node:assert/strict";
import {
  timelinePlan,
  buildTimeline,
  maxOf,
  niceScale,
  groupValues,
  inGroup,
  stepLabel,
  HOUR_MS,
  DAY_MS,
  TARGET_POINTS,
} from "../src/timeline.js";

const NOW = Date.parse("2026-03-10T12:00:00Z");

function row(createdAt, extra = {}) {
  return { createdAt, state: "SUCCEEDED", organization: "acme", team: "Platform", ...extra };
}

const REPO_KEYS = ["succeeded", "failed"];
const repoCounts = (r) => ({
  succeeded: r.state === "SUCCEEDED" ? 1 : 0,
  failed: r.state === "FAILED" ? 1 : 0,
});

test("the bounded ranges get a fixed bucket width", () => {
  assert.equal(timelinePlan("day", [], NOW).step, HOUR_MS);
  assert.equal(timelinePlan("week", [], NOW).step, DAY_MS);
  assert.equal(timelinePlan("month", [], NOW).step, DAY_MS);
  // Daily over three months would be 90 points; weekly keeps it legible.
  assert.equal(timelinePlan("quarter", [], NOW).step, 7 * DAY_MS);
});

test("three months spans a quarter and stays under the point budget", () => {
  const plan = timelinePlan("quarter", [], NOW);
  const points = Math.ceil((plan.end - plan.start) / plan.step);

  assert.ok(points <= TARGET_POINTS, `${points} points must stay under ${TARGET_POINTS}`);
  assert.ok(plan.end - plan.start >= 90 * DAY_MS, "must cover at least 90 days");
  assert.equal(stepLabel(plan), "week");
});

// Buckets start on a clock boundary, so a "day" bucket is a day rather than the
// hours since the page happened to load.
test("bucket starts are floored to their unit", () => {
  const hourly = timelinePlan("day", [], Date.parse("2026-03-10T12:34:56Z"));
  assert.equal(new Date(hourly.start).toISOString(), "2026-03-09T12:00:00.000Z");

  const daily = timelinePlan("week", [], Date.parse("2026-03-10T12:34:56Z"));
  assert.equal(new Date(daily.start).toISOString(), "2026-03-03T00:00:00.000Z");
});

// The open-ended range has no window to inherit, so it sizes itself off the data.
test("'all' widens its buckets as the span grows", () => {
  const twoDays = timelinePlan("all", [row("2026-03-01T00:00:00Z"), row("2026-03-03T00:00:00Z")], NOW);
  assert.equal(twoDays.step, HOUR_MS * 6);

  const twoMonths = timelinePlan("all", [row("2026-01-01T00:00:00Z"), row("2026-03-01T00:00:00Z")], NOW);
  assert.equal(twoMonths.step, 7 * DAY_MS);

  const fiveYears = timelinePlan("all", [row("2021-01-01T00:00:00Z"), row("2026-01-01T00:00:00Z")], NOW);
  assert.equal(fiveYears.step, 91 * DAY_MS);
});

test("'all' with nothing to plot has no plan", () => {
  assert.equal(timelinePlan("all", [], NOW), null);
  assert.equal(timelinePlan("all", [row("not a date")], NOW), null);
  assert.deepEqual(buildTimeline([], { plan: null, keys: REPO_KEYS, countsOf: repoCounts }), []);
});

test("cumulative lines carry their running total forward", () => {
  const rows = [
    row("2026-03-08T01:00:00Z"),
    row("2026-03-09T01:00:00Z", { state: "FAILED" }),
    row("2026-03-10T01:00:00Z"),
  ];
  const plan = timelinePlan("week", rows, NOW);
  const points = buildTimeline(rows, {
    plan,
    keys: REPO_KEYS,
    countsOf: repoCounts,
    cumulative: true,
  });

  assert.deepEqual(points.at(-1).succeeded, 2);
  assert.deepEqual(points.at(-1).failed, 1);
  // Monotonic: a running total never dips.
  for (let i = 1; i < points.length; i += 1) {
    assert.ok(points[i].succeeded >= points[i - 1].succeeded);
  }
});

test("per-bucket lines report each bucket on its own", () => {
  const rows = [
    row("2026-03-08T01:00:00Z"),
    row("2026-03-08T05:00:00Z"),
    row("2026-03-10T01:00:00Z"),
  ];
  const plan = timelinePlan("week", rows, NOW);
  const points = buildTimeline(rows, {
    plan,
    keys: REPO_KEYS,
    countsOf: repoCounts,
    cumulative: false,
  });

  const totals = points.map((p) => p.succeeded);
  assert.deepEqual(
    totals.filter((n) => n > 0),
    [2, 1],
  );
  assert.equal(
    totals.reduce((sum, n) => sum + n, 0),
    3,
  );
});

// A row older than the window belongs to no bucket; silently folding it into the
// first one would invent a spike that never happened.
test("rows before the window are dropped, not folded into bucket zero", () => {
  const rows = [row("2020-01-01T00:00:00Z"), row("2026-03-10T01:00:00Z")];
  const plan = timelinePlan("week", rows, NOW);
  const points = buildTimeline(rows, { plan, keys: REPO_KEYS, countsOf: repoCounts });

  assert.equal(points[0].succeeded, 0);
  assert.equal(points.at(-1).succeeded, 1);
});

test("a row the counter declines contributes nothing", () => {
  const rows = [row("2026-03-09T01:00:00Z"), row("2026-03-09T02:00:00Z")];
  const plan = timelinePlan("week", rows, NOW);
  const points = buildTimeline(rows, {
    plan,
    keys: ["succeeded"],
    countsOf: (r) => (r.createdAt.endsWith("02:00:00Z") ? null : { succeeded: 1 }),
  });

  assert.equal(points.at(-1).succeeded, 1);
});

test("the y-axis ends on a round number with round ticks", () => {
  assert.deepEqual(niceScale(0), { max: 1, ticks: [0, 1] });
  assert.deepEqual(niceScale(4), { max: 4, ticks: [0, 1, 2, 3, 4] });
  assert.deepEqual(niceScale(37), { max: 40, ticks: [0, 10, 20, 30, 40] });
  assert.deepEqual(niceScale(1234).max, 1500);

  for (const max of [3, 17, 99, 512, 8123]) {
    const scale = niceScale(max);
    assert.ok(scale.max >= max, `${scale.max} must cover ${max}`);
    assert.equal(scale.ticks[0], 0);
    assert.equal(scale.ticks.at(-1), scale.max);
  }
});

test("maxOf spans every series", () => {
  const points = [
    { succeeded: 1, failed: 9 },
    { succeeded: 4, failed: 2 },
  ];
  assert.equal(maxOf(points, REPO_KEYS), 9);
  assert.equal(maxOf(points, ["succeeded"]), 4);
  assert.equal(maxOf([], REPO_KEYS), 0);
});

test("group options are deduplicated, sorted, and given a fallback", () => {
  const rows = [
    row("2026-03-09T01:00:00Z", { organization: "zeta", team: null }),
    row("2026-03-09T01:00:00Z", { organization: "acme", team: "Platform" }),
    row("2026-03-09T01:00:00Z", { organization: "acme", team: "Platform" }),
  ];

  assert.deepEqual(groupValues(rows, "org"), ["acme", "zeta"]);
  assert.deepEqual(groupValues(rows, "team"), ["Platform", "Unassigned"]);
  assert.deepEqual(groupValues(rows, "all"), []);
});

test("'all' keeps every row, a group keeps only its own", () => {
  const acme = row("2026-03-09T01:00:00Z", { organization: "acme" });
  const zeta = row("2026-03-09T01:00:00Z", { organization: "zeta" });

  assert.equal(inGroup(zeta, "all", null), true);
  assert.equal(inGroup(zeta, "org", null), true);
  assert.equal(inGroup(acme, "org", "acme"), true);
  assert.equal(inGroup(zeta, "org", "acme"), false);
});

test("the per-bucket toggle names the bucket it plots", () => {
  assert.equal(stepLabel(timelinePlan("day", [], NOW)), "hour");
  assert.equal(stepLabel(timelinePlan("week", [], NOW)), "day");
  assert.equal(stepLabel(null), "period");
});
