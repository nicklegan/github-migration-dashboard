import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recoveryCurve,
  recoveryPulse,
  lateRecoveries,
  medianDaysToOnboard,
  greenShareBy,
  medianDaysToGreen,
  onboardingStats,
  checkpointsFor,
  cohortTrend,
  pendingFrom,
  trimUnmeasured,
  onboardingPeriods,
  comparePeriods,
  latestChange,
} from "../src/recovery.js";

const NOW = Date.parse("2026-06-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function repo(daysAgo, { daysToGreen = null, daysToFirstGreen = null, ...rest } = {}) {
  return {
    state: "SUCCEEDED",
    removed: false,
    migratedAt: new Date(NOW - daysAgo * DAY).toISOString(),
    // A repository is only on the curve if it has something scored to date.
    workflows: { succeeded: 1, failing: 0, idle: 0, manual: 0, postOnboarding: 0 },
    daysToGreen,
    daysToFirstGreen,
    backOnlineAt:
      daysToGreen == null ? null : new Date(NOW - (daysAgo - daysToGreen) * DAY).toISOString(),
    ...rest,
  };
}

const many = (n, daysAgo, opts) => Array.from({ length: n }, () => repo(daysAgo, opts));

test("the curve climbs as repositories reach green", () => {
  const rows = [repo(60, { daysToGreen: 1 }), repo(60, { daysToGreen: 10 }), repo(60, { daysToGreen: 30 })];
  const { points } = recoveryCurve(rows, { windowDays: 60, nowMs: NOW, points: 60 });

  const at = (day) => points.find((p) => p.day >= day).allGreen;
  assert.equal(at(0), 0);
  assert.ok(Math.abs(at(1) - 1 / 3) < 0.02);
  assert.ok(Math.abs(at(10) - 2 / 3) < 0.02);
  assert.equal(at(30), 1);
});

test("a quoted day is on the curve exactly", () => {
  const rows = [repo(60, { daysToGreen: 1 }), repo(60, { daysToGreen: 7 }), repo(60, { daysToGreen: 30 })];
  const { points } = recoveryCurve(rows, { windowDays: 60, nowMs: NOW, points: 40, extraDays: [7, 30] });
  const day7 = points.find((p) => p.day === 7);
  assert.ok(day7, "day 7 is evaluated");
  assert.equal(day7.allGreen, greenShareBy(rows, 7, { nowMs: NOW, minAtRisk: 3 }).share);
  assert.ok(points.find((p) => p.day === 30));
  // The window day itself is a point, exactly, for awkward windows too.
  for (const windowDays of [60, 75, 45, 90]) {
    const old = [repo(200, { daysToGreen: 1 }), repo(200, { daysToGreen: 7 }), repo(200, { daysToGreen: 30 })];
    const curve = recoveryCurve(old, { windowDays, nowMs: NOW, points: 40 }).points;
    assert.equal(curve.at(-1).day, windowDays);
  }
  assert.deepEqual(points.map((p) => p.day), [...points.map((p) => p.day)].sort((a, b) => a - b));
});

// The single rule that keeps the chart honest: a repository migrated yesterday
// has not failed to recover in thirty days, it has not been asked yet.
test("a repository only counts towards a day it has actually reached", () => {
  const rows = [
    // Old enough to answer for the whole window.
    ...Array.from({ length: 5 }, () => repo(60, { daysToGreen: 40 })),
    // Migrated two days ago, still onboarding.
    ...Array.from({ length: 5 }, () => repo(2)),
  ];
  const { points } = recoveryCurve(rows, { windowDays: 60, nowMs: NOW, points: 60 });

  const day1 = points.find((p) => p.day >= 1);
  assert.equal(day1.atRisk, 10, "all ten have had a day");
  assert.equal(day1.allGreen, 0);

  const day40 = points.find((p) => p.day >= 40);
  assert.equal(day40.atRisk, 5, "the new ones are not counted against day 40");
  assert.equal(day40.allGreen, 1, "so the curve reads 100%, not 50%");
});

test("the curve stops where no repository has reached yet", () => {
  const { points } = recoveryCurve([repo(5, { daysToGreen: 1 })], {
    windowDays: 60,
    nowMs: NOW,
    points: 60,
  });

  assert.ok(points.length > 0);
  assert.ok(points.at(-1).day <= 5, "nothing is drawn beyond the oldest migration");
});

// At the right-hand edge of a young cohort the at-risk set shrinks to a handful,
// and one repository swings the percentage by tens of points — a nose-dive that
// describes three repositories and reads like a collapse.
test("the curve stops before its at-risk set gets too small to mean anything", () => {
  const rows = [
    ...Array.from({ length: 20 }, () => repo(30, { daysToGreen: 2 })),
    // Two stragglers migrated long ago and never recovered: on their own they
    // would drag the tail from 100% to 0%.
    repo(59),
    repo(58),
  ];

  const { points } = recoveryCurve(rows, { windowDays: 60, nowMs: NOW, points: 60 });

  assert.ok(points.at(-1).day <= 30, "it ends with the bulk, not with the stragglers");
  assert.equal(points.at(-1).allGreen > 0.5, true, "and does not end on a nose-dive");
});

// The part-way line is the gap itself, not a second running total: a repository
// enters it when something first passes and leaves it when everything has. A
// healthy programme shows it fall as the green line rises.
test("the part-way line rises as repositories start and falls as they finish", () => {
  const rows = [repo(120, { daysToFirstGreen: 2, daysToGreen: 20 })];
  const { points } = recoveryCurve(rows, { windowDays: 60, nowMs: NOW, points: 60 });

  const at = (day) => points.find((p) => p.day >= day);

  assert.equal(at(1).partlyGreen, 0, "nothing has run yet");
  assert.equal(at(5).partlyGreen, 1, "running, but not everything");
  assert.equal(at(5).allGreen, 0);
  assert.equal(at(30).partlyGreen, 0, "it left the gap by finishing");
  assert.equal(at(30).allGreen, 1);
});

// A repository that never finishes stays in the gap, which is what makes a
// plateau at the right-hand edge readable as a stuck population.
test("a repository that never finishes stays in the gap", () => {
  const rows = [repo(120, { daysToFirstGreen: 1 })];
  const { points } = recoveryCurve(rows, { windowDays: 60, nowMs: NOW, points: 60 });

  assert.equal(points.at(-1).partlyGreen, 1);
  assert.equal(points.at(-1).allGreen, 0);
});

test("failed and removed repositories are not part of the population", () => {
  const rows = [
    repo(60, { daysToGreen: 1 }),
    repo(60, { state: "FAILED" }),
    repo(60, { removed: true, daysToGreen: 1 }),
  ];
  const { population } = recoveryCurve(rows, { windowDays: 60, nowMs: NOW });

  assert.equal(population, 1);
});

// Leaving out repositories that cannot be dated removes successes without
// removing failures — a red repository needs no date to count as red. While
// that exclusion is large the curve reads far too low, so the caller is told
// how much of the population it is.
test("the undated share is reported, so the chart can refuse to draw", () => {
  const rows = [
    repo(60, { daysToGreen: 5 }),
    repo(60, { greenUndated: true }),
    repo(60, { greenUndated: true }),
    // Neither datable nor undated: nothing scored, so it is out either way.
    repo(60, { workflows: { succeeded: 0, failing: 0, idle: 0, manual: 2 } }),
  ];

  const { population, undated } = recoveryCurve(rows, { windowDays: 60, nowMs: NOW });

  assert.equal(population, 1);
  assert.equal(undated, 2);
});

test("a repository green from before dating is left out, not counted as red", () => {
  const rows = [repo(60, { daysToGreen: 5 }), repo(60, { greenUndated: true })];
  const { points, population } = recoveryCurve(rows, { windowDays: 60, nowMs: NOW, points: 60 });

  assert.equal(population, 1);
  assert.equal(points.find((p) => p.day >= 10).allGreen, 1, "not 50%");
});

// Only manual, reusable, or post-window workflows means nothing to score, and so
// no first success that could ever date it. Left in, such a repository sits at
// zero for good — and on a real estate they are the majority, which pins the
// whole curve to the floor.
test("a repository with nothing scored is not on the curve at all", () => {
  const nothing = { succeeded: 0, failing: 0, idle: 0, manual: 3, postOnboarding: 1 };
  const rows = [
    repo(60, { daysToGreen: 5 }),
    repo(60, { workflows: nothing }),
    repo(60, { workflows: nothing }),
    repo(60, { workflows: null }),
  ];

  const { points, population } = recoveryCurve(rows, { windowDays: 60, nowMs: NOW, points: 60 });

  assert.equal(population, 1, "only the repository that could recover");
  assert.equal(points.find((p) => p.day >= 10).allGreen, 1, "not 25%");
});

// Whatever is not green or part-way is a repository with workflows and no
// success to show for them. The three bands are a partition, so they have to
// come to one: a gap would be a repository counted nowhere.
test("the three bands account for every repository at every day", () => {
  const rows = [
    repo(60, { daysToGreen: 5, daysToFirstGreen: 2 }),
    repo(60, { daysToFirstGreen: 3 }),
    repo(60, { workflows: { succeeded: 0, failing: 2, idle: 0 } }),
    repo(60, { daysToGreen: 40, daysToFirstGreen: 12 }),
  ];

  const { points } = recoveryCurve(rows, { windowDays: 60, nowMs: NOW, points: 60 });

  for (const p of points) {
    const total = p.allGreen + p.partlyGreen + p.notRunning;
    assert.ok(Math.abs(total - 1) < 1e-9, `day ${p.day} came to ${total}`);
    assert.ok(p.partlyGreen >= 0 && p.notRunning >= 0, `day ${p.day} went negative`);
  }

  const at = points.find((p) => p.day >= 45);
  assert.equal(at.allGreen, 0.5);
  assert.equal(at.notRunning, 0.25, "only the one whose workflows never passed");
});

// A repository recorded as fully green without a first-success date would make
// the part-way band negative, and the stack would draw below the axis.
test("a green repository counts as started even with no first-success date", () => {
  const rows = [repo(60, { daysToGreen: 5 }), repo(60, { daysToGreen: 8 })];

  const { points } = recoveryCurve(rows, { windowDays: 60, nowMs: NOW, points: 60 });
  const at = points.find((p) => p.day >= 10);

  assert.equal(at.partlyGreen, 0);
  assert.equal(at.notRunning, 0);
});

// The cards above the curve count what is green now; the curve counts what was
// green in time. These are the repositories in between, and naming them is what
// stops the two numbers from looking like a contradiction.
test("recoveries after the window closed are counted separately", () => {
  const rows = [
    repo(120, { daysToGreen: 10 }),
    repo(120, { daysToGreen: 75 }),
    repo(120, { daysToGreen: 61 }),
    repo(120),
  ];

  assert.equal(lateRecoveries(rows, 60), 2);
  assert.equal(lateRecoveries(rows, 0), 0, "no window, nothing is late");
});

test("the pulse counts arrivals and recoveries per bucket", () => {
  const rows = [repo(30, { daysToGreen: 10 }), repo(30), repo(5, { daysToGreen: 1 })];
  const series = recoveryPulse(rows, { start: NOW - 40 * DAY, end: NOW, step: DAY });

  assert.equal(
    series.reduce((sum, b) => sum + b.migrated, 0),
    3,
  );
  assert.equal(
    series.reduce((sum, b) => sum + b.backOnline, 0),
    2,
  );
});

// The median, not the mean: one repository that took eight months should not be
// able to move a whole team's number on its own.
test("a group is timed by its median, which one outlier cannot move", () => {
  const rows = [
    ...[1, 2, 3, 4, 300].map((days) => repo(400, { team: "Payments", daysToGreen: days })),
    ...[10, 10, 10, 10, 10].map((days) => repo(400, { team: "Mobile", daysToGreen: days })),
  ];

  const byTeam = medianDaysToOnboard(rows, { groupOf: (r) => r.team, keyName: "team", nowMs: NOW });

  assert.deepEqual(byTeam.find((g) => g.team === "Payments"), {
    team: "Payments",
    days: 3,
    samples: 5,
  });
  assert.equal(byTeam.find((g) => g.team === "Mobile").days, 10);
});

// Only repositories that got there can be timed, so a group where one of fifty
// recovered would otherwise post the best median on the chart.
test("a group with too few recoveries is left out, not flattered", () => {
  const rows = [
    ...Array.from({ length: 5 }, () => repo(400, { team: "Honest", daysToGreen: 20 })),
    repo(400, { team: "Lucky", daysToGreen: 1 }),
    ...Array.from({ length: 49 }, () => repo(400, { team: "Lucky" })),
  ];

  const byTeam = medianDaysToOnboard(rows, { groupOf: (r) => r.team, keyName: "team", nowMs: NOW });

  assert.deepEqual(
    byTeam.map((g) => g.team),
    ["Honest"],
  );
  assert.equal(byTeam.note, "1 group not shown: 1 where fewer than half are fully green yet.");
});

// The bars and the headline tile answer the same question, so they must agree:
// the slow repositories that never got there count against a group's median.
test("a group's median counts the repositories still red, like the headline", () => {
  const rows = [
    ...many(2, 100, { team: "Slow", daysToGreen: 2 }),
    ...many(2, 100, { team: "Slow", daysToGreen: 40 }),
    ...many(2, 100, { team: "Slow" }),
  ];
  const [slow] = medianDaysToOnboard(rows, { groupOf: (r) => r.team, keyName: "team", nowMs: NOW });
  // The naive median of the four that got there would be 21; half the group
  // was green only on day 40.
  assert.equal(slow.days, 40);
  assert.equal(slow.days, medianDaysToGreen(rows, { nowMs: NOW }).days);
});

test("a group too small to measure is noted, not plotted", () => {
  const rows = [...many(5, 100, { team: "Big", daysToGreen: 3 }), ...many(2, 100, { team: "Tiny", daysToGreen: 1 })];
  const byTeam = medianDaysToOnboard(rows, { groupOf: (r) => r.team, keyName: "team", nowMs: NOW });
  assert.deepEqual(byTeam.map((g) => g.team), ["Big"]);
  assert.equal(byTeam.note, "1 group not shown: 1 with fewer than 5 repositories to measure.");
});

// --- Trends -----------------------------------------------------------------


test("green by day N counts only repositories that have had N days", () => {
  const rows = [
    ...many(4, 40, { daysToGreen: 3 }),
    ...many(4, 40, { daysToGreen: 20 }),
    // Two days old and red: not a failure at day 7, just not there yet.
    ...many(10, 2),
  ];
  const by7 = greenShareBy(rows, 7, { nowMs: NOW });
  assert.equal(by7.atRisk, 8);
  assert.equal(by7.share, 0.5);
  assert.equal(greenShareBy(rows, 30, { nowMs: NOW }).share, 1);
});

test("a comparison waits until half the group has reached the day", () => {
  // Five of twenty have had a week: enough to count, too few to stand for the group.
  const rows = [...many(5, 8), ...many(15, 2)];
  assert.equal(greenShareBy(rows, 7, { nowMs: NOW }).atRisk, 5);
  assert.equal(greenShareBy(rows, 7, { nowMs: NOW, minShare: 0.5 }), null);
  assert.equal(greenShareBy([...many(10, 8), ...many(10, 2)], 7, { nowMs: NOW, minShare: 0.5 }).atRisk, 10);
});

test("a cohort is not plotted on the sliver of it that has had the days", () => {
  const at = (iso, opts) => ({ ...repo(0, opts), migratedAt: iso });
  // A month whose first five repositories are a week old and the rest a day.
  const rows = [
    ...Array.from({ length: 5 }, () => at("2026-05-24T00:00:00Z")),
    ...Array.from({ length: 30 }, () => at("2026-05-31T00:00:00Z")),
  ];
  const { points } = cohortTrend(rows, { granularity: "month", nowMs: NOW, windowDays: 60 });
  assert.equal(points[0].by7, null);
});

test("green by day N is withheld until enough repositories have reached it", () => {
  assert.equal(greenShareBy(many(4, 40, { daysToGreen: 1 }), 7, { nowMs: NOW }), null);
});

test("the median is read off the censored curve, not just the repositories that got there", () => {
  // Five old repositories took 20 days; five new ones went green on day 1 but
  // five more new ones are still red. The naive median of the eight that got
  // there would flatter it; the curve does not.
  const rows = [
    ...many(5, 60, { daysToGreen: 20 }),
    ...many(5, 10, { daysToGreen: 1 }),
    ...many(5, 10),
  ];
  const result = medianDaysToGreen(rows, { nowMs: NOW });
  // Day 1: 5 of 15 green. Past day 10 only the old five remain, none green
  // until day 20, where all of them are.
  assert.equal(result.days, 20);
});

test("a median not reached says how far it has been measured", () => {
  const rows = [...many(5, 30, { daysToGreen: 25 }), ...many(10, 30)];
  const result = medianDaysToGreen(rows, { nowMs: NOW });
  assert.equal(result.days, null);
  assert.equal(result.over, 30);
});

test("the median is reached the moment a red repository drops out, not at the next event", () => {
  // From day 10 the five young red repositories have left, and three of the
  // five old ones are green: 60%. The median is day 10, not day 100.
  const rows = [...many(5, 10), ...many(3, 100, { daysToGreen: 2 }), ...many(2, 100)];
  assert.equal(greenShareBy(rows, 11, { nowMs: NOW }).share, 0.6);
  assert.equal(medianDaysToGreen(rows, { nowMs: NOW }).days, 10);
});

// Recounts the share from scratch on each side of every day it can change —
// on the day and just after it — which is slow but plainly right.
function naiveMedian(rows) {
  const pop = rows.map((r) => ({ e: (NOW - Date.parse(r.migratedAt)) / DAY, g: r.daysToGreen }));
  const days = [...new Set([0, ...pop.flatMap((r) => (r.g != null ? [r.g, r.e] : [r.e]))])].sort((a, b) => a - b);
  for (const d of days) {
    for (const atRisk of [(r) => r.e >= d, (r) => r.e > d]) {
      const risk = pop.filter(atRisk);
      if (risk.length < 5) return null;
      if (risk.filter((r) => r.g != null && r.g <= d).length / risk.length >= 0.5) return Math.round(d * 100) / 100;
    }
  }
  return null;
}

test("the swept median agrees with recounting at every day", () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let trial = 0; trial < 400; trial += 1) {
    const size = 5 + Math.floor(rand() * 40);
    // Batches, as real migrations arrive: a few distinct ages shared by many.
    const ages = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => rand() * 120);
    const rows = Array.from({ length: size }, () => {
      const age = ages[Math.floor(rand() * ages.length)];
      const green = rand() < 0.5 ? rand() * age : null;
      return repo(age, { daysToGreen: green });
    });
    assert.equal(medianDaysToGreen(rows, { nowMs: NOW })?.days ?? null, naiveMedian(rows), `trial ${trial}`);
  }
});

test("checkpoints are a first week and month, short of the window", () => {
  assert.deepEqual(checkpointsFor(60), [7, 30]);
  assert.deepEqual(checkpointsFor(30), [7]);
  assert.deepEqual(checkpointsFor(7), []);
  assert.deepEqual(checkpointsFor(0), []);
});

test("onboarding stats leave out repositories with nothing to run", () => {
  const rows = [
    ...many(5, 90, { daysToGreen: 2 }),
    repo(90, { workflows: { succeeded: 0, failing: 0, idle: 0, manual: 1, postOnboarding: 0 } }),
  ];
  const stats = onboardingStats(rows, { nowMs: NOW, windowDays: 60, checkpoints: [7, 30] });
  assert.equal(stats.repositories, 5);
  assert.equal(stats.by[7].share, 1);
  assert.equal(stats.onTime.share, 1);
  assert.equal(stats.median.days, 2);
});

test("cohorts run in calendar order with no gaps, measured on their own clocks", () => {
  const at = (iso, opts) => ({ ...repo(0, opts), migratedAt: iso });
  const rows = [
    ...Array.from({ length: 5 }, () => at("2026-01-10T00:00:00Z", { daysToGreen: 20 })),
    ...Array.from({ length: 5 }, () => at("2026-03-10T00:00:00Z", { daysToGreen: 4 })),
  ];
  const { points } = cohortTrend(rows, { granularity: "month", nowMs: NOW, windowDays: 60 });
  assert.deepEqual(points.map((p) => p.label), ["Jan 2026", "Feb 2026", "Mar 2026"]);
  assert.deepEqual(points.map((p) => p.median), [20, null, 4]);
  assert.deepEqual(points.map((p) => p.repositories), [5, 0, 5]);
  assert.equal(points[0].by7, 0);
  assert.equal(points[2].by7, 1);
  assert.equal(points[2].onTime, 1);
});

test("the cohorts still being decided start after the last measured one", () => {
  const points = [
    { label: "a", median: 20 },
    { label: "b", median: null },
    { label: "c", median: 12 },
    { label: "d", median: null },
    { label: "e", median: null },
  ];
  // A gap mid-way is a small cohort, not the young end of the chart.
  assert.equal(pendingFrom(points, "median").label, "d");
  assert.equal(pendingFrom(points.slice(0, 3), "median"), null);
  assert.equal(pendingFrom([{ label: "a", median: null }], "median").label, "a");
  assert.equal(pendingFrom([], "median"), null);
});

test("the newest groups with nothing measured yet are dropped, earlier gaps kept", () => {
  const points = [
    { label: "a", by7: 0.2, onTime: 0.5 },
    { label: "b", by7: null, onTime: null },
    { label: "c", by7: 0.1, onTime: null },
    { label: "d", by7: null, onTime: null },
    { label: "e", by7: null, onTime: null },
  ];
  assert.deepEqual(trimUnmeasured(points, ["by7", "onTime"]).map((p) => p.label), ["a", "b", "c"]);
  assert.equal(trimUnmeasured(points.slice(0, 1), ["by7"]).length, 1);
  assert.deepEqual(trimUnmeasured([{ label: "x", by7: null }], ["by7"]), []);
});

test("weeks start on Monday", () => {
  // 2026-03-15 is a Sunday; its week began Monday 9 March.
  const rows = [{ ...repo(0, { daysToGreen: 1 }), migratedAt: "2026-03-15T12:00:00Z" }];
  const { points } = cohortTrend(rows, { granularity: "week", nowMs: NOW, windowDays: 60 });
  assert.equal(points[0].label, "Mar 9, 2026");
});

test("without a granularity the periods are quarters", () => {
  const at = (iso) => ({ ...repo(0), migratedAt: iso });
  const rows = ["2025-02-01", "2025-05-01", "2025-08-01", "2025-11-01", "2026-02-01"].map((d) => at(`${d}T00:00:00Z`));
  assert.deepEqual(
    onboardingPeriods(rows).map((p) => p.label),
    ["Q1 2025", "Q2 2025", "Q3 2025", "Q4 2025", "Q1 2026"],
  );
});

test("periods follow the granularity asked for, phrased for a sentence", () => {
  const at = (iso) => ({ ...repo(0), migratedAt: iso });
  const rows = [at("2026-03-10T00:00:00Z"), at("2026-03-18T00:00:00Z"), at("2026-04-02T00:00:00Z")];
  const weeks = onboardingPeriods(rows, { granularity: "week" });
  assert.deepEqual(weeks.map((p) => p.label), ["Mar 9, 2026", "Mar 16, 2026", "Mar 30, 2026"]);
  assert.equal(weeks[0].phrase, "in the week of Mar 9, 2026");
  assert.deepEqual(onboardingPeriods(rows, { granularity: "month" }).map((p) => p.label), ["Mar 2026", "Apr 2026"]);
  assert.equal(onboardingPeriods(rows, { granularity: "month" })[0].phrase, "in March 2026");
  // Asked for quarters, one quarter is what it gets, rather than months.
  assert.deepEqual(onboardingPeriods(rows, { granularity: "quarter" }).map((p) => p.label), ["Q1 2026", "Q2 2026"]);
});

test("a period's range names the year once, unless it spans two", () => {
  const at = (iso) => ({ ...repo(0), migratedAt: iso });
  const [week] = onboardingPeriods([at("2025-12-29T09:00:00Z"), at("2026-01-02T09:00:00Z")], { granularity: "week" });
  assert.equal(week.range, "Dec 29, 2025 – Jan 2, 2026");
  const [month] = onboardingPeriods([at("2026-03-02T09:00:00Z"), at("2026-03-30T09:00:00Z")], { granularity: "month" });
  assert.equal(month.range, "Mar 2 – Mar 30, 2026");
});

test("the oldest periods fold into Earlier, measured as one", () => {
  const at = (iso, opts) => ({ ...repo(0, opts), migratedAt: iso });
  const quarter = (iso, daysToGreen) => Array.from({ length: 5 }, () => at(iso, { daysToGreen }));
  const rows = [
    ...quarter("2025-02-01T00:00:00Z", 10),
    ...quarter("2025-05-01T00:00:00Z", 30),
    ...quarter("2025-08-01T00:00:00Z", 5),
    ...quarter("2025-11-01T00:00:00Z", 5),
    ...quarter("2026-02-01T00:00:00Z", 5),
  ];
  const periods = comparePeriods(rows, { nowMs: NOW, windowDays: 60, maxPeriods: 4 });
  assert.deepEqual(periods.map((p) => p.label), ["Earlier", "Q3 2025", "Q4 2025", "Q1 2026"]);
  // The two folded quarters are one population of ten, so its median is
  // theirs together, not either quarter's.
  assert.equal(periods[0].repositories, 10);
  assert.equal(periods[0].median.days, 10);
  assert.equal(periods[0].range, "Feb 1 – May 1, 2025");
});

test("the newest periods with nothing measured are dropped before folding", () => {
  const at = (iso, opts) => ({ ...repo(0, opts), migratedAt: iso });
  const week = (iso, opts) => Array.from({ length: 5 }, () => at(iso, opts));
  const rows = [
    ...week("2026-04-06T00:00:00Z", { daysToGreen: 2 }),
    ...week("2026-04-13T00:00:00Z", { daysToGreen: 2 }),
    ...week("2026-04-20T00:00:00Z", { daysToGreen: 2 }),
    // Days old: nothing to measure yet. Folding first would have kept these
    // and folded the three above away.
    ...week("2026-05-28T00:00:00Z"),
    ...week("2026-05-30T00:00:00Z"),
  ];
  const periods = comparePeriods(rows, { granularity: "week", nowMs: NOW, windowDays: 60, maxPeriods: 2 });
  assert.deepEqual(periods.map((p) => p.label), ["Earlier", "Apr 20, 2026"]);
  assert.equal(periods[0].repositories, 10);
});

test("an estate inside one quarter is compared month by month", () => {
  const at = (iso) => ({ ...repo(0), migratedAt: iso });
  const periods = onboardingPeriods([at("2026-04-02T00:00:00Z"), at("2026-05-02T00:00:00Z")]);
  assert.deepEqual(periods.map((p) => p.label), ["Apr 2026", "May 2026"]);
});

test("the latest change skips periods that cannot be measured yet", () => {
  const at = (iso, opts) => ({ ...repo(0, opts), migratedAt: iso });
  const rows = [
    ...Array.from({ length: 5 }, () => at("2025-11-15T00:00:00Z", { daysToGreen: 20 })),
    ...Array.from({ length: 5 }, () => at("2026-02-15T00:00:00Z", { daysToGreen: 5 })),
    // A day old: too new to have a median.
    ...Array.from({ length: 3 }, () => at("2026-05-31T00:00:00Z")),
  ];
  const periods = comparePeriods(rows, { nowMs: NOW, windowDays: 60 });
  // Q2 2026 has nothing to measure yet, so it is not a column at all.
  assert.deepEqual(periods.map((p) => p.label), ["Q4 2025", "Q1 2026"]);
  assert.deepEqual(latestChange(periods, (p) => p.median?.days), {
    current: 5,
    previous: 20,
    currentPhrase: "in Q1 2026",
    previousPhrase: "in Q4 2025",
  });
});
