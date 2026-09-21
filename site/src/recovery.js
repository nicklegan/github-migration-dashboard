// How migrated repositories come back to life across their onboarding window.
// Pure — no React, no recharts — so the censoring rules unit-test directly.
//
// Time here is measured from each repository's own migration, not from the
// calendar: day 3 means three days after that repository moved, whenever that
// was. Cohorts migrated months apart are therefore directly comparable, which
// is the whole point — it answers "are we getting faster?" rather than "what
// happened in March".

const DAY_MS = 24 * 60 * 60 * 1000;

// Below this many repositories still at risk, a percentage is one repository
// swinging it by tens of points. The curve stops rather than ending in a spike
// or a nose-dive that describes three repositories and reads like a collapse.
const MIN_AT_RISK = 5;

// A repository only counts towards day N once it has actually had N days to get
// there. Without this the newest migrations drag every curve down: a repository
// migrated yesterday is not a repository that failed to recover in thirty days,
// it is a repository that has not been asked yet.
//
// This is right-censoring, the standard treatment for a population still
// arriving. The curve stays honest at the left and thins out at the right, where
// it is drawn from the few cohorts old enough to have got there.
function recoveryCurve(rows, { windowDays, nowMs = Date.now(), points = 40 } = {}) {
  const population = rows.filter(eligible);
  // Repositories that are green but cannot be dated. They are left out, and
  // that exclusion is one-sided — a red repository needs no date to be counted
  // red — so while this is large the curve reads far too low. The caller uses it
  // to decide whether the curve is worth drawing at all.
  const undated = rows.filter((row) => row.greenUndated && datable(row)).length;
  if (population.length === 0 || !(windowDays > 0)) return { points: [], population: 0, undated };

  const elapsed = population.map((row) => (nowMs - Date.parse(row.migratedAt ?? row.createdAt)) / DAY_MS);
  const step = windowDays / Math.max(1, points);

  const series = [];
  for (let day = 0; day <= windowDays + 1e-9; day += step) {
    let atRisk = 0;
    let green = 0;
    let stirring = 0;
    for (let i = 0; i < population.length; i += 1) {
      if (elapsed[i] < day) continue;
      atRisk += 1;
      const row = population[i];
      const isGreen = row.daysToGreen != null && row.daysToGreen <= day;
      // Fully green counts as stirring whatever its first-success date says, so
      // a missing one cannot push a band negative and break the partition.
      if (isGreen) green += 1;
      if (isGreen || (row.daysToFirstGreen != null && row.daysToFirstGreen <= day)) stirring += 1;
    }
    // A day no repository has reached yet says nothing, and nor does one only a
    // handful have. A small cohort still gets drawn, just not past its own size.
    if (atRisk < Math.min(MIN_AT_RISK, population.length)) break;
    series.push({
      day: round(day),
      atRisk,
      // Repositories part-way there: something runs, but not everything. This is
      // the gap itself rather than a second running total, so it rises while
      // repositories are still arriving and falls as they finish — and a
      // plateau is a population that got stuck half-migrated.
      partlyGreen: (stirring - green) / atRisk,
      allGreen: green / atRisk,
      // Nothing has passed at all. Drawn rather than left as empty space: it is
      // the band with work behind it, and it is the one people act on.
      notRunning: (atRisk - stirring) / atRisk,
    });
  }

  return { points: series, population: population.length, undated };
}

// A migrated repository with something scored: the set the curve is drawn from,
// before dates are taken into account.
function datable(row) {
  if (row.state !== "SUCCEEDED" || row.removed) return false;
  if (!(row.migratedAt ?? row.createdAt)) return false;
  const counts = row.workflows;
  return (counts?.succeeded ?? 0) + (counts?.failing ?? 0) + (counts?.idle ?? 0) > 0;
}

// Only repositories that actually migrated and have a window to be measured
// against, and that the curve can place: a repository green from before dating
// began has no day to sit on, and one with nothing scored — only manual,
// reusable, or post-window workflows — never will have. The latter has no
// recovery to chart either way: there is nothing in it to run.
function eligible(row) {
  return datable(row) && !row.greenUndated;
}

// Arrivals against recoveries, in calendar time: repositories migrating per
// bucket, and repositories reaching fully green per bucket. When the recovery
// line tracks the arrival bars the programme is keeping up; when arrivals spike
// and recoveries stay flat, a backlog is forming.
//
// Takes the same plan the timeline charts use, so both share bucket edges.
function recoveryPulse(rows, plan) {
  if (!plan || !(plan.step > 0) || !(plan.end > plan.start)) return [];
  const count = Math.ceil((plan.end - plan.start) / plan.step);

  const series = Array.from({ length: count }, (_, i) => ({
    at: plan.start + i * plan.step,
    migrated: 0,
    backOnline: 0,
  }));

  const put = (at, key) => {
    const ms = Date.parse(at ?? "");
    if (!Number.isFinite(ms) || ms < plan.start || ms > plan.end) return;
    const index = Math.min(count - 1, Math.floor((ms - plan.start) / plan.step));
    series[index][key] += 1;
  };

  for (const row of rows) {
    if (!eligible(row)) continue;
    put(row.migratedAt ?? row.createdAt, "migrated");
    put(row.backOnlineAt, "backOnline");
  }

  return series;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

// Repositories that did come back, but only after their window had closed. They
// are the difference between the cards above the curve, which count what is
// green now, and the curve, which counts what was green in time. Worth naming:
// a recovery on day 90 of a 60-day window is a miss that fixed itself.
function lateRecoveries(rows, windowDays) {
  if (!(windowDays > 0)) return 0;
  return rows.filter((row) => eligible(row) && row.daysToGreen > windowDays).length;
}

// How long a group's repositories typically take to get every workflow green.
// The median rather than the mean: one repository that took eight months should
// not be able to move a team's number on its own.
//
// Only repositories that actually got there can be timed, which is a trap — a
// group where one repository of fifty recovered would post a flattering median
// off that single sample. Groups below `minSamples` recoveries are left out
// rather than plotted on a number that cannot bear the weight.
function medianDaysToOnboard(rows, { groupOf, keyName, minSamples = 5 } = {}) {
  const groups = new Map();
  for (const row of rows) {
    if (!eligible(row) || row.daysToGreen == null) continue;
    const key = groupOf(row);
    if (key == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row.daysToGreen);
  }

  const out = [];
  let dropped = 0;
  for (const [key, days] of groups) {
    if (days.length < minSamples) {
      dropped += 1;
      continue;
    }
    out.push({ [keyName]: key, days: round(median(days)), samples: days.length });
  }
  if (dropped > 0) {
    out.note = `${dropped} group${dropped === 1 ? "" : "s"} with fewer than ${minSamples} onboarded repositories ${dropped === 1 ? "is" : "are"} not shown: too few to time.`;
  }
  return out;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export { recoveryCurve, recoveryPulse, lateRecoveries, medianDaysToOnboard };
