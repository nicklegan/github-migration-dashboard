import { test } from "node:test";
import assert from "node:assert/strict";
import { recoveryCurve, recoveryPulse, lateRecoveries, medianDaysToOnboard } from "../src/recovery.js";

const NOW = Date.parse("2026-06-01T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function repo(daysAgo, { daysToGreen = null, daysToFirstGreen = null, ...rest } = {}) {
  return {
    state: "SUCCEEDED",
    removed: false,
    migratedAt: new Date(NOW - daysAgo * DAY).toISOString(),
    daysToGreen,
    daysToFirstGreen,
    backOnlineAt:
      daysToGreen == null ? null : new Date(NOW - (daysAgo - daysToGreen) * DAY).toISOString(),
    ...rest,
  };
}

test("the curve climbs as repositories reach green", () => {
  const rows = [repo(60, { daysToGreen: 1 }), repo(60, { daysToGreen: 10 }), repo(60, { daysToGreen: 30 })];
  const { points } = recoveryCurve(rows, { windowDays: 60, nowMs: NOW, points: 60 });

  const at = (day) => points.find((p) => p.day >= day).allGreen;
  assert.equal(at(0), 0);
  assert.ok(Math.abs(at(1) - 1 / 3) < 0.02);
  assert.ok(Math.abs(at(10) - 2 / 3) < 0.02);
  assert.equal(at(30), 1);
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

// A repository already green before the action started dating recoveries has no
// day to be plotted on. Counting it as never recovered would understate every
// cohort it appears in, so it is left out until a re-list dates it.
test("a repository green from before dating is left out, not counted as red", () => {
  const rows = [repo(60, { daysToGreen: 5 }), repo(60, { greenUndated: true })];
  const { points, population } = recoveryCurve(rows, { windowDays: 60, nowMs: NOW, points: 60 });

  assert.equal(population, 1);
  assert.equal(points.find((p) => p.day >= 10).allGreen, 1, "not 50%");
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

  const byTeam = medianDaysToOnboard(rows, { groupOf: (r) => r.team, keyName: "team" });

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

  const byTeam = medianDaysToOnboard(rows, { groupOf: (r) => r.team, keyName: "team" });

  assert.deepEqual(
    byTeam.map((g) => g.team),
    ["Honest"],
  );
  assert.match(byTeam.note, /1 group with fewer than 5 onboarded repositories is not shown/);
});
