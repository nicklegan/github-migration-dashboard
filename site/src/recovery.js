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
//
// `extraDays` are evaluated exactly as well as on the regular steps, so a
// figure quoted elsewhere — "16% by day 7" — sits on the line, not near it.
function recoveryCurve(rows, { windowDays, nowMs = Date.now(), points = 40, extraDays = [] } = {}) {
  const population = rows.filter(eligible);
  // Repositories that are green but cannot be dated. They are left out, and
  // that exclusion is one-sided — a red repository needs no date to be counted
  // red — so while this is large the curve reads far too low. The caller uses it
  // to decide whether the curve is worth drawing at all.
  const undated = rows.filter((row) => row.greenUndated && datable(row)).length;
  if (population.length === 0 || !(windowDays > 0)) return { points: [], population: 0, undated };

  const elapsed = population.map((row) => (nowMs - Date.parse(row.migratedAt ?? row.createdAt)) / DAY_MS);
  const step = windowDays / Math.max(1, points);

  const days = [];
  // Multiplied rather than accumulated, and ending on the window itself, so the
  // last point is the window day exactly: the chart marks it, and a step that
  // drifted to 59.9999 would leave the mark with nothing to sit on.
  const count = Math.max(1, points);
  for (let i = 0; i < count; i += 1) days.push(i * step);
  days.push(windowDays);
  for (const day of extraDays) if (day > 0 && day < windowDays) days.push(day);
  days.sort((a, b) => a - b);

  const series = [];
  for (const day of days) {
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

// Repositories that did come back, but only after their window had closed: the
// Late status. The curve stops at the window, so it never shows them; its
// footnote names them instead. A recovery on day 90 of a 60-day window is a
// miss that fixed itself.
function lateRecoveries(rows, windowDays) {
  if (!(windowDays > 0)) return 0;
  return rows.filter((row) => eligible(row) && row.daysToGreen > windowDays).length;
}

// How long a group's repositories typically take to get every workflow green,
// read the same way as the headline median (see medianDaysToGreen) so the bars
// and the summary can never tell different stories.
//
// Timing only the repositories that got there is a trap: a group where one of
// fifty recovered would post the best median on the chart. So a group is shown
// only when half of it is measurably green; the rest are counted in a note
// rather than plotted on a number that cannot bear the weight.
function medianDaysToOnboard(rows, { groupOf, keyName, nowMs = Date.now() } = {}) {
  const groups = new Map();
  for (const row of rows) {
    if (!eligible(row)) continue;
    const key = groupOf(row);
    if (key == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const out = [];
  let tooFew = 0;
  let notYet = 0;
  for (const [key, members] of groups) {
    const result = medianDaysToGreen(members, { nowMs });
    if (!result) tooFew += 1;
    else if (result.days == null) notYet += 1;
    else out.push({ [keyName]: key, days: result.days, samples: members.length });
  }

  const reasons = [];
  if (tooFew > 0) reasons.push(`${tooFew} with fewer than ${MIN_AT_RISK} repositories to measure`);
  if (notYet > 0) reasons.push(`${notYet} where fewer than half are fully green yet`);
  if (reasons.length > 0) {
    const hidden = tooFew + notYet;
    out.note = `${hidden} group${hidden === 1 ? "" : "s"} not shown: ${reasons.join(", ")}.`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trends: is onboarding getting faster?
//
// Everything below compares groups of repositories by *when they migrated* — a
// cohort — while still measuring each one on its own clock. The same censoring
// rule as the curve applies throughout: a repository counts towards "green by
// day N" only once it has had N days, so a cohort migrated last week is neither
// a failure nor a success at day 30, it is simply not in that figure yet.
// Without that rule every recent cohort would look worse than it is, and any
// improvement would be hidden by exactly the repositories it applies to.

function elapsedDays(row, nowMs) {
  return (nowMs - Date.parse(row.migratedAt ?? row.createdAt)) / DAY_MS;
}

// The share of repositories fully green by `day`, among those that have had
// `day` days to get there. Null when too few have: a percentage of three
// repositories is an anecdote.
//
// `minShare` additionally requires that share of the group to have had `day`
// days. Comparisons need it: a month measured on the five repositories from its
// first morning stands for that morning, not the month, and plotted beside full
// months it reads as a collapse.
function greenShareBy(rows, day, { nowMs = Date.now(), minAtRisk = MIN_AT_RISK, minShare = 0 } = {}) {
  let population = 0;
  let atRisk = 0;
  let green = 0;
  for (const row of rows) {
    if (!eligible(row)) continue;
    population += 1;
    if (elapsedDays(row, nowMs) < day) continue;
    atRisk += 1;
    if (row.daysToGreen != null && row.daysToGreen <= day) green += 1;
  }
  if (atRisk < minAtRisk || atRisk < minShare * population) return null;
  return { share: green / atRisk, atRisk, green };
}

// How much of a cohort or period must have reached a day before it is compared
// on that day.
const COMPARABLE_SHARE = 0.5;

// The day by which half the repositories were fully green, read off the same
// censored curve rather than taken over only the repositories that got there.
// The naive median rewards a cohort for being young: only its fastest members
// have finished, so it looks quick until the rest arrive.
//
// Returns `{ days }` when the curve crosses half, or `{ days: null, over }` when
// it has not by the furthest day enough repositories have reached — "longer
// than `over` days", which is itself the finding.
function medianDaysToGreen(rows, { nowMs = Date.now(), minAtRisk = MIN_AT_RISK } = {}) {
  const population = rows.filter(eligible);
  const n = population.length;
  if (n < minAtRisk) return null;

  const ascending = (a, b) => a - b;
  const elapsed = population.map((row) => elapsedDays(row, nowMs)).sort(ascending);
  // A repository goes green no later than now, so its green day never exceeds
  // its elapsed days; clamping keeps that true across a clock that drifted.
  const greens = population
    .map((row) => (row.daysToGreen != null ? [Math.min(row.daysToGreen, elapsedDays(row, nowMs)), elapsedDays(row, nowMs)] : null))
    .filter(Boolean);
  const greenDays = greens.map(([day]) => day).sort(ascending);
  const greenElapsed = greens.map(([, e]) => e).sort(ascending);

  // The share only changes where a repository goes green or drops out of the
  // at-risk set, so those are the only days worth evaluating — swept in order
  // with three pointers rather than recounted at every step.
  const days = [...new Set([0, ...greenDays, ...elapsed])].filter((d) => d >= 0).sort(ascending);
  let dropped = 0; // elapsed < day
  let reached = 0; // green day <= day
  let greenDropped = 0; // green, but elapsed < day
  let lastReached = 0;
  for (const day of days) {
    while (dropped < n && elapsed[dropped] < day) dropped += 1;
    while (reached < greenDays.length && greenDays[reached] <= day) reached += 1;
    while (greenDropped < greenElapsed.length && greenElapsed[greenDropped] < day) greenDropped += 1;
    const atRisk = n - dropped;
    if (atRisk < minAtRisk) break;
    lastReached = day;
    if ((reached - greenDropped) / atRisk >= 0.5) return { days: round(day), atRisk };

    // A repository is at risk on its own last day and gone just after it, so a
    // red one leaving can lift the share over half between two candidate days.
    // Checking only on them would report the next one, which can be weeks on.
    let after = dropped;
    let greenAfter = greenDropped;
    while (after < n && elapsed[after] <= day) after += 1;
    while (greenAfter < greenElapsed.length && greenElapsed[greenAfter] <= day) greenAfter += 1;
    const atRiskAfter = n - after;
    if (atRiskAfter < minAtRisk) break;
    if ((reached - greenAfter) / atRiskAfter >= 0.5) return { days: round(day), atRisk: atRiskAfter };
  }
  return { days: null, over: Math.floor(lastReached) };
}

// The headline figures for one group of repositories. `checkpoints` are the
// days the dashboard reports "green by day N" for; the window itself is always
// one of them, and is what "on time" means.
function onboardingStats(rows, { nowMs = Date.now(), windowDays, checkpoints = [], minShare = 0 } = {}) {
  const population = rows.filter(eligible);
  const by = {};
  for (const day of checkpoints) by[day] = greenShareBy(population, day, { nowMs, minShare });
  return {
    repositories: population.length,
    median: medianDaysToGreen(population, { nowMs }),
    by,
    onTime: windowDays > 0 ? greenShareBy(population, windowDays, { nowMs, minShare }) : null,
  };
}

// The "green by day N" checkpoints worth reporting for a window: a first week,
// a first month, and the window itself, without repeating it or passing it.
function checkpointsFor(windowDays) {
  return [7, 30].filter((day) => windowDays > 0 && day < windowDays);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Calendar buckets in UTC, so a cohort is the same set of repositories for
// everyone who opens the dashboard. Weeks start on Monday.
function bucketStart(ms, granularity) {
  const d = new Date(ms);
  if (granularity === "week") {
    const offset = (d.getUTCDay() + 6) % 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset);
  }
  if (granularity === "quarter") {
    return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1);
  }
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function nextBucket(start, granularity) {
  const d = new Date(start);
  if (granularity === "week") return start + 7 * DAY_MS;
  const months = granularity === "quarter" ? 3 : 1;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1);
}

function bucketLabel(start, granularity) {
  const d = new Date(start);
  const year = d.getUTCFullYear();
  if (granularity === "week") return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${year}`;
  if (granularity === "quarter") return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${year}`;
  return `${MONTHS[d.getUTCMonth()]} ${year}`;
}

function migratedMs(row) {
  return Date.parse(row.migratedAt ?? row.createdAt ?? "");
}

// One point per migration cohort, from the first cohort to the last with no
// gaps, so the x-axis is calendar time and a quiet month reads as one. Each
// point carries the same figures as the comparison table, censored the same way.
function cohortTrend(rows, { granularity = "month", nowMs = Date.now(), windowDays } = {}) {
  const population = rows.filter(eligible);
  if (population.length === 0) return { points: [] };

  const groups = new Map();
  let first = Infinity;
  let last = -Infinity;
  for (const row of population) {
    const at = migratedMs(row);
    if (!Number.isFinite(at)) continue;
    const start = bucketStart(at, granularity);
    if (!groups.has(start)) groups.set(start, []);
    groups.get(start).push(row);
    if (start < first) first = start;
    if (start > last) last = start;
  }
  if (!Number.isFinite(first)) return { points: [] };

  const checkpoints = checkpointsFor(windowDays);
  const points = [];
  for (let start = first; start <= last; start = nextBucket(start, granularity)) {
    const cohort = groups.get(start) ?? [];
    const stats = onboardingStats(cohort, { nowMs, windowDays, checkpoints, minShare: COMPARABLE_SHARE });
    const point = {
      at: start,
      label: bucketLabel(start, granularity),
      repositories: cohort.length,
      median: stats.median?.days ?? null,
      medianOver: stats.median && stats.median.days == null ? stats.median.over : null,
      onTime: stats.onTime?.share ?? null,
      onTimeAtRisk: stats.onTime?.atRisk ?? 0,
    };
    for (const day of checkpoints) {
      point[`by${day}`] = stats.by[day]?.share ?? null;
      point[`by${day}AtRisk`] = stats.by[day]?.atRisk ?? 0;
    }
    points.push(point);
  }

  return { points, checkpoints };
}

// The newest groups have often had no time to reach even the shortest
// checkpoint, so they carry no value on any line. Drawn, they are an empty
// column at the edge that says nothing; dropping them gives the groups that
// can be read the room. Groups with no value further left are kept, since a gap
// there is a small or slow group, not one that is too new.
function trimUnmeasured(points, keys) {
  let end = points.length;
  while (end > 0 && keys.every((key) => points[end - 1][key] == null)) end -= 1;
  return end === points.length ? points : points.slice(0, end);
}

// Where the cohorts too young to measure begin: the first cohort after the last
// one with a value for `key`. Everything from there to today is still being
// decided, which the chart shades rather than leaving as unexplained blank
// space. Null when the newest cohort already has a value.
function pendingFrom(points, key) {
  let last = -1;
  for (let i = 0; i < points.length; i += 1) if (points[i][key] != null) last = i;
  return last < points.length - 1 ? points[last + 1] : null;
}

const shortDate = (ms) => {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
};

// Most periods a comparison shows side by side before the oldest are folded
// into one "Earlier" column: enough for weeks to show a run, few enough that the
// table still reads as "then versus now".
const MAX_PERIODS = 6;

const LONG_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// How a period reads inside a sentence. Months are spelled out there, where
// "in July 2026" reads better than the table's "Jul 2026".
function periodPhrase(start, granularity) {
  if (granularity === "week") return `in the week of ${bucketLabel(start, granularity)}`;
  if (granularity === "month") {
    const d = new Date(start);
    return `in ${LONG_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
  return `in ${bucketLabel(start, granularity)}`;
}

// The periods to compare, one per week, month, or quarter of migration that has
// any repositories in it. Without a granularity, calendar quarters, or months
// for an estate too young to have two quarters.
function onboardingPeriods(rows, { granularity } = {}) {
  const population = rows.filter((row) => eligible(row) && Number.isFinite(migratedMs(row)));
  if (population.length === 0) return [];

  for (const unit of granularity ? [granularity] : ["quarter", "month"]) {
    const starts = [...new Set(population.map((row) => bucketStart(migratedMs(row), unit)))].sort((a, b) => a - b);
    if (!granularity && starts.length < 2 && unit !== "month") continue;
    const periods = starts.map((start) => ({
      key: String(start),
      label: bucketLabel(start, unit),
      phrase: periodPhrase(start, unit),
      from: start,
      to: nextBucket(start, unit),
    }));
    return withRows(periods, population).filter((p) => p.rows.length > 0);
  }
  return [];
}

function withRows(periods, population) {
  return periods.map((period) => {
    const rows = population.filter((row) => {
      const at = migratedMs(row);
      return at >= period.from && at < period.to;
    });
    return { ...period, rows, range: rangeOf(rows) };
  });
}

function rangeOf(rows) {
  let first = Infinity;
  let last = -Infinity;
  for (const row of rows) {
    const at = migratedMs(row);
    if (at < first) first = at;
    if (at > last) last = at;
  }
  if (!rows.length) return "";
  // The year once when both ends share it: a week of columns is narrow enough
  // to fit the card that way.
  const sameYear = new Date(first).getUTCFullYear() === new Date(last).getUTCFullYear();
  return `${sameYear ? shortDate(first).replace(/, \d{4}$/, "") : shortDate(first)} – ${shortDate(last)}`;
}

// Whether a period has any figure to compare yet. A median floor ("more than
// N days") does not count: on its own it only says the period is young.
function hasFigure(period) {
  return (
    period.median?.days != null ||
    period.onTime != null ||
    Object.values(period.by ?? {}).some((value) => value != null)
  );
}

// Each period's figures, for the comparison table and the summary.
//
// The newest periods with nothing measured yet are dropped, as on the trend
// chart. Only then are the oldest folded into "Earlier": folding first would
// keep the newest, mostly empty, columns and fold away the ones with figures.
function comparePeriods(rows, { granularity, nowMs = Date.now(), windowDays, maxPeriods = MAX_PERIODS } = {}) {
  const checkpoints = checkpointsFor(windowDays);
  const statsOf = (periodRows) =>
    onboardingStats(periodRows, { nowMs, windowDays, checkpoints, minShare: COMPARABLE_SHARE });

  let periods = onboardingPeriods(rows, { granularity }).map((period) => ({ ...period, ...statsOf(period.rows) }));
  let end = periods.length;
  while (end > 0 && !hasFigure(periods[end - 1])) end -= 1;
  periods = periods.slice(0, end);

  if (periods.length > maxPeriods) {
    const folded = periods.slice(0, periods.length - (maxPeriods - 1));
    const earlierRows = folded.flatMap((period) => period.rows);
    periods = [
      {
        key: "earlier",
        label: "Earlier",
        phrase: "earlier",
        from: -Infinity,
        to: periods[folded.length].from,
        rows: earlierRows,
        range: rangeOf(earlierRows),
        ...statsOf(earlierRows),
      },
      ...periods.slice(folded.length),
    ];
  }
  return periods.map(({ rows: _rows, ...period }) => period);
}

// The latest period with a figure for `pick`, against the one before it that
// also has one, so a tile can say which way things are moving. Null when fewer
// than two periods can be measured. The phrases slot into a sentence: "61 days
// in Q2 2026".
function latestChange(periods, pick) {
  const measured = periods.filter((p) => pick(p) != null);
  if (measured.length < 2) return null;
  const current = measured.at(-1);
  const previous = measured.at(-2);
  return {
    current: pick(current),
    previous: pick(previous),
    currentPhrase: current.phrase ?? current.label,
    previousPhrase: previous.phrase ?? previous.label,
  };
}

export {
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
};
