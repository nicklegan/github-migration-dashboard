// Time-series shaping for the progress charts. Pure — no React, no recharts —
// so the bucketing and scaling rules unit-test directly.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// How many points a timeline aims for. Enough to show shape, few enough that
// every label stays legible at full width.
const TARGET_POINTS = 40;

// Candidate bucket widths, finest first. An open-ended range picks the finest
// one that keeps the point count under TARGET_POINTS.
const STEPS = [
  { step: HOUR_MS, unit: "hour" },
  { step: 6 * HOUR_MS, unit: "hour" },
  { step: DAY_MS, unit: "day" },
  { step: 7 * DAY_MS, unit: "day" },
  { step: 28 * DAY_MS, unit: "day" },
  { step: 91 * DAY_MS, unit: "day" },
  { step: 365 * DAY_MS, unit: "day" },
];

// The bounded ranges the time filter offers map to a fixed bucket width, so the
// x-axis reads the same every time you select them. Three months goes weekly:
// daily would be 90 points, well past what stays legible.
const RANGE_PLANS = {
  day: { span: DAY_MS, step: HOUR_MS, unit: "hour" },
  week: { span: 7 * DAY_MS, step: DAY_MS, unit: "day" },
  month: { span: 30 * DAY_MS, step: DAY_MS, unit: "day" },
  quarter: { span: 90 * DAY_MS, step: 7 * DAY_MS, unit: "day" },
};

// Buckets start on a clock boundary rather than at an arbitrary offset from
// "now", so a day bucket is a day and not the 14 hours since the page loaded.
function floorTo(at, unit) {
  const d = new Date(at);
  if (unit === "hour") d.setUTCMinutes(0, 0, 0);
  else d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function extentOf(rows) {
  let first = Infinity;
  let last = -Infinity;
  for (const row of rows) {
    const at = Date.parse(row.createdAt);
    if (!Number.isFinite(at)) continue;
    if (at < first) first = at;
    if (at > last) last = at;
  }
  return Number.isFinite(first) ? { first, last } : null;
}

// Decides the window and bucket width for a timeline. Returns null when there
// is nothing to plot. `all` spans the data itself, so a two-week estate gets
// daily buckets and a three-year one gets quarterly, without a setting.
function timelinePlan(range, rows, nowMs = Date.now()) {
  const fixed = RANGE_PLANS[range];
  if (fixed) {
    return {
      start: floorTo(nowMs - fixed.span, fixed.unit),
      end: nowMs,
      step: fixed.step,
      unit: fixed.unit,
    };
  }

  const extent = extentOf(rows);
  if (!extent) return null;

  const span = Math.max(extent.last - extent.first, HOUR_MS);
  const chosen = STEPS.find(({ step }) => span / step <= TARGET_POINTS) ?? STEPS.at(-1);
  const start = floorTo(extent.first, chosen.unit);
  return { start, end: extent.last + chosen.step, step: chosen.step, unit: chosen.unit };
}

// Rolls rows into the plan's buckets. `countsOf` returns what one row
// contributes to each key, so the same builder serves repositories (one per row)
// and workflows (a workflow tally per row). Returning null skips the row, which
// is how a repository with no workflow data stays out of the workflow chart.
function buildTimeline(rows, { plan, keys, countsOf, cumulative = true }) {
  if (!plan) return [];

  const points = [];
  for (let at = plan.start; at < plan.end; at += plan.step) {
    const point = { at };
    for (const key of keys) point[key] = 0;
    points.push(point);
  }
  if (points.length === 0) return [];

  for (const row of rows) {
    const at = Date.parse(row.createdAt);
    if (!Number.isFinite(at)) continue;
    const index = Math.floor((at - plan.start) / plan.step);
    if (index < 0) continue;
    const counts = countsOf(row);
    if (!counts) continue;
    const point = points[Math.min(index, points.length - 1)];
    for (const key of keys) point[key] += counts[key] ?? 0;
  }

  if (cumulative) {
    const running = {};
    for (const key of keys) running[key] = 0;
    for (const point of points) {
      for (const key of keys) {
        running[key] += point[key];
        point[key] = running[key];
      }
    }
  }

  return points;
}

function maxOf(points, keys) {
  let max = 0;
  for (const point of points) {
    for (const key of keys) {
      if (point[key] > max) max = point[key];
    }
  }
  return max;
}

// A y-axis that ends on a round number and divides into round ticks, so the
// scale follows the data instead of the data being squashed into a fixed axis.
function niceScale(max, targetTicks = 4) {
  if (!Number.isFinite(max) || max <= 0) return { max: 1, ticks: [0, 1] };

  const rough = max / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const step =
    (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;

  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let value = 0; value <= top + step / 2; value += step) ticks.push(Math.round(value));
  return { max: top, ticks };
}

function groupOf(row, dimension) {
  if (dimension === "team") return row.team || "Unassigned";
  if (dimension === "org") return row.organization || "Unknown";
  return null;
}

function groupValues(rows, dimension) {
  if (dimension === "all") return [];
  const seen = new Set();
  for (const row of rows) seen.add(groupOf(row, dimension));
  return [...seen].sort((a, b) => a.localeCompare(b));
}

function inGroup(row, dimension, value) {
  if (dimension === "all" || value == null) return true;
  return groupOf(row, dimension) === value;
}

// What one bucket covers, for the per-bucket toggle's label.
function stepLabel(plan) {
  if (!plan) return "period";
  if (plan.step === HOUR_MS) return "hour";
  if (plan.step === 6 * HOUR_MS) return "6 hours";
  if (plan.step === DAY_MS) return "day";
  if (plan.step === 7 * DAY_MS) return "week";
  return "period";
}

function formatBucket(at, plan) {
  const d = new Date(at);
  if (plan?.unit === "hour") {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  // Past a month per bucket the day is noise, and a bare "5 Jan" repeated across
  // years would be ambiguous.
  if (plan && plan.step >= 28 * DAY_MS) {
    return d.toLocaleDateString([], { month: "short", year: "numeric" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export {
  timelinePlan,
  buildTimeline,
  maxOf,
  niceScale,
  groupOf,
  groupValues,
  inGroup,
  stepLabel,
  formatBucket,
  HOUR_MS,
  DAY_MS,
  TARGET_POINTS,
};
