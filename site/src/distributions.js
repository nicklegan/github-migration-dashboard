// Distribution breakdowns: the shape of the estate rather than its totals.
//
// An average hides its tail — "3 minutes" and "12 warnings" say nothing about
// the repository that took 45 minutes or lost 1338 items — and a success count
// says nothing about how many attempts it took to get there. These group the
// rows into ordered buckets so the tail is a row of its own.
//
// Pure functions, no React, so they unit-test directly. Each bucket dimension
// exposes the same pair: the buckets, and the label a row falls in, which is
// what the cross-filter matches on.

import { platformOf } from "./sourcePlatform.js";

const UNKNOWN = "Unknown";

// Inclusive integer ranges. Durations and warnings arrive rounded, so no
// bucket needs a fractional edge.
const ATTEMPT_BUCKETS = [
  { label: "1", min: 1, max: 1 },
  { label: "2", min: 2, max: 2 },
  { label: "3", min: 3, max: 3 },
  { label: "4–9", min: 4, max: 9 },
  { label: "10 or more", min: 10, max: Infinity },
];

const WARNING_BUCKETS = [
  { label: "None", min: 0, max: 0 },
  { label: "1–10", min: 1, max: 10 },
  { label: "11–50", min: 11, max: 50 },
  { label: "51–200", min: 51, max: 200 },
  { label: "Over 200", min: 201, max: Infinity },
];

const DURATION_BUCKETS = [
  { label: "Under 2 min", min: 0, max: 1 },
  { label: "2–5 min", min: 2, max: 5 },
  { label: "6–15 min", min: 6, max: 15 },
  { label: "16–60 min", min: 16, max: 60 },
  { label: "Over an hour", min: 61, max: Infinity },
];

const ONBOARDING_LABELS = {
  "in-progress": "Onboarding",
  complete: "Onboarded",
  incomplete: "Incomplete",
};

function bucketLabel(value, buckets) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return buckets.find((b) => value >= b.min && value <= b.max)?.label ?? null;
}

// A row with no recorded attempt count was migrated once.
const attemptBucketOf = (row) => bucketLabel(row?.attemptCount ?? 1, ATTEMPT_BUCKETS);
const warningBucketOf = (row) => bucketLabel(row?.warningsCount ?? 0, WARNING_BUCKETS);
// Null where the duration was never recorded, which drops the row from the
// chart rather than inventing a bucket for it.
const durationBucketOf = (row) => bucketLabel(row?.durationMinutes, DURATION_BUCKETS);
const onboardingLabelOf = (row) => ONBOARDING_LABELS[row?.onboarding] ?? null;
const platformLabelOf = (row) => platformOf(row) ?? UNKNOWN;

// Counts rows into their bucket, keeping the buckets' own order — a
// distribution read out of order is not a distribution. Buckets nothing fell
// into are dropped, so a card carries only rows that stand for something.
function bucketBreakdown(migrations, buckets, keyName, labelOf, countsOf) {
  const totals = new Map(buckets.map((b) => [b.label, null]));
  for (const row of migrations) {
    const label = labelOf(row);
    if (label == null || !totals.has(label)) continue;
    const counts = countsOf(row);
    const entry = totals.get(label) ?? { [keyName]: label };
    for (const [key, value] of Object.entries(counts)) entry[key] = (entry[key] ?? 0) + value;
    totals.set(label, entry);
  }
  return buckets.map((b) => totals.get(b.label)).filter(Boolean);
}

// Repositories by final state, so a bucket says both how many landed there and
// whether they got there in the end.
function stateCounts(row) {
  return {
    succeeded: row.state === "SUCCEEDED" ? 1 : 0,
    failed: row.state === "FAILED" ? 1 : 0,
    other: row.state !== "SUCCEEDED" && row.state !== "FAILED" ? 1 : 0,
  };
}

const repositoryCount = () => ({ repositories: 1 });

function attemptBreakdown(migrations) {
  return bucketBreakdown(migrations, ATTEMPT_BUCKETS, "attempts", attemptBucketOf, stateCounts);
}

function warningBreakdown(migrations) {
  return bucketBreakdown(migrations, WARNING_BUCKETS, "warnings", warningBucketOf, repositoryCount);
}

function durationBreakdown(migrations) {
  return bucketBreakdown(migrations, DURATION_BUCKETS, "duration", durationBucketOf, repositoryCount);
}

// Grouping that keeps its own order is only right for buckets; named
// categories (platforms, teams) are ranked by size like every other breakdown.
function rankedBreakdown(migrations, keyName, labelOf, countsOf) {
  const groups = new Map();
  for (const row of migrations) {
    const label = labelOf(row);
    if (label == null) continue;
    const entry = groups.get(label) ?? { [keyName]: label };
    for (const [key, value] of Object.entries(countsOf(row))) entry[key] = (entry[key] ?? 0) + value;
    groups.set(label, entry);
  }
  return [...groups.values()].sort((a, b) => totalOf(b, keyName) - totalOf(a, keyName));
}

function totalOf(entry, keyName) {
  let total = 0;
  for (const [key, value] of Object.entries(entry)) {
    if (key !== keyName && typeof value === "number") total += value;
  }
  return total;
}

function platformBreakdown(migrations) {
  return rankedBreakdown(migrations, "sourcePlatform", platformLabelOf, stateCounts);
}

// One row per team (or organization) split by how far its repositories are
// through their onboarding window — the laggards, named.
function onboardingGroupBreakdown(migrations, keyName, keyOf) {
  return rankedBreakdown(
    migrations.filter((row) => onboardingLabelOf(row) != null),
    keyName,
    keyOf,
    (row) => ({
      inProgress: row.onboarding === "in-progress" ? 1 : 0,
      complete: row.onboarding === "complete" ? 1 : 0,
      incomplete: row.onboarding === "incomplete" ? 1 : 0,
    }),
  );
}

function onboardingTeamBreakdown(migrations) {
  return onboardingGroupBreakdown(migrations, "team", (row) => row.team || "Unassigned");
}

function onboardingOrgBreakdown(migrations) {
  return onboardingGroupBreakdown(migrations, "org", (row) => row.organization || UNKNOWN);
}

// Whether a source system's repositories come back to life inside the window.
// The nearest thing to "how long until the workflows are right" that the stored
// data supports — no first-success timestamp is recorded per workflow.
function onboardingPlatformBreakdown(migrations) {
  return onboardingGroupBreakdown(migrations, "sourcePlatform", platformLabelOf);
}

// Points for the size-against-duration plot, grouped into one series per source
// platform. Only repositories with both numbers are plottable, and a size of
// zero cannot sit on a logarithmic axis, so the caller is told how many of the
// rows made it.
function sizeDurationSeries(migrations) {
  const series = new Map();
  let plotted = 0;
  for (const row of migrations) {
    const size = row.repoSizeMB;
    const minutes = row.durationMinutes;
    if (typeof size !== "number" || size <= 0) continue;
    if (typeof minutes !== "number" || minutes <= 0) continue;
    const platform = platformLabelOf(row);
    if (!series.has(platform)) series.set(platform, { platform, points: [] });
    series.get(platform).points.push({
      id: row.id,
      organization: row.organization,
      repository: row.repository,
      sizeMB: size,
      minutes,
    });
    plotted += 1;
  }
  const groups = [...series.values()].sort((a, b) => b.points.length - a.points.length);
  return { series: groups, plotted, total: migrations.length };
}

export {
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
  ATTEMPT_BUCKETS,
  WARNING_BUCKETS,
  DURATION_BUCKETS,
  ONBOARDING_LABELS,
};
