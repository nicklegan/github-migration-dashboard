import { workflowCounts, inOnboarding, onboardingClosesAt } from "./apply.js";
import { bucketOf } from "./store.js";
import { ONGOING_STATES } from "./states.js";

// Builds what the dashboard reads. Rows stay light enough to hold every
// repository in memory for cross-filtering; the heavy parts of a repository
// (its migration attempts and its workflow list) move to detail buckets the
// browser only fetches when a row is expanded.


// Identifies the origin a migration pulled from, so a retry into a differently
// named target can be recognised as the same work. Placeholder URLs carry no
// path and must not correlate unrelated repositories.
function sourceKey(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\.git$/i, "").replace(/\/+$/, "");
    if (!path || path === "/") return null;
    return `${parsed.host}${path}`.toLowerCase();
  } catch {
    return null;
  }
}

// A failed migration whose source was later migrated successfully elsewhere is
// superseded: the work landed, just under a different repository name. It stays
// listed, but stops counting as an outstanding failure.
function markSuperseded(rows) {
  const succeededBySource = new Map();
  for (const row of rows) {
    if (row.state !== "SUCCEEDED") continue;
    const key = sourceKey(row.sourceUrl);
    if (!key) continue;
    const best = succeededBySource.get(key);
    if (!best || row.createdAt > best.createdAt) succeededBySource.set(key, row);
  }

  for (const row of rows) {
    if (row.state !== "FAILED") continue;
    const key = sourceKey(row.sourceUrl);
    if (!key) continue;
    const winner = succeededBySource.get(key);
    if (!winner || winner.id === row.id || winner.createdAt < row.createdAt) continue;
    row.state = "SUPERSEDED";
    row.supersededBy = winner.id;
  }

  return rows;
}

// A repository counts as migrated when any attempt succeeded, regardless of how
// many failed before it; otherwise an in-flight attempt outranks a failed one.
function summaryState(attempts) {
  if (attempts.some((a) => a.state === "SUCCEEDED")) return "SUCCEEDED";
  const ongoing = attempts.find((a) => ONGOING_STATES.has(a.state));
  return ongoing ? ongoing.state : attempts[0].state;
}

function byCreatedAtDesc(a, b) {
  return (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
}

// The migration that started the clock: the first attempt that landed. With no
// success there is nothing to onboard, so the latest attempt anchors instead so
// the repository still settles rather than being re-listed forever.
function migratedAtOf(attempts) {
  const succeeded = attempts.filter((a) => a.state === "SUCCEEDED");
  if (succeeded.length > 0) {
    return succeeded.reduce((first, a) => (a.createdAt < first ? a.createdAt : first), succeeded[0].createdAt);
  }
  return attempts.reduce((last, a) => (a.createdAt > last ? a.createdAt : last), attempts[0].createdAt);
}

// Where a repository stands against its window. Closing the window does not
// declare success — a workflow still red or never run when the window closes is
// exactly the thing worth surfacing.
function onboardingStatus(state, closesAt, counts, now) {
  if (state !== "SUCCEEDED" || !counts || closesAt === Infinity) return null;
  if (now < closesAt) return "in-progress";
  return counts.failing > 0 || counts.idle > 0 ? "incomplete" : "complete";
}

// Joins the migration event log to current repository state. Returns the light
// rows plus a detail map keyed by bucket, ready to be written as separate files.
//
// An absent repository means two different things depending on how its
// migration ended, and conflating them hides failures:
//
//   SUCCEEDED + absent — it was created, then removed. The migration happened,
//     but the repository is not part of the estate, so it is flagged `removed`
//     and left out of the counted set.
//   FAILED + absent — it was never created. That *is* the failure, so the row
//     counts and is not labelled as a deletion.
function buildRows(migrations, repos, { windowMs = Infinity, now = Date.now(), detailBuckets } = {}) {
  const grouped = new Map();
  for (const row of migrations) {
    const key = `${row.org}/${row.repository}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  const rows = [];
  const detail = new Map();

  for (const [key, unsorted] of grouped) {
    const record = repos[key] ?? null;
    const deletedAt = record?.deletedAt ?? null;

    const attempts = [...unsorted].sort(byCreatedAtDesc);
    const representative = attempts.find((a) => a.state === "SUCCEEDED") ?? attempts[0];
    const bucket = bucketOf(key, detailBuckets);
    const migratedAt = migratedAtOf(attempts);
    const closesAt = onboardingClosesAt(migratedAt, windowMs);

    const workflowList = deletedAt
      ? []
      : Object.entries(record?.workflows ?? {})
          .filter(([, w]) => !w.reusable)
          .map(([wkey, w]) => ({
            id: `${key}:${wkey}`,
            name: w.name,
            state: w.state ?? null,
            status: w.status,
            url: w.url ?? null,
            manual: w.manual ?? false,
            firstSeenAt: w.firstSeenAt ?? null,
            onboarding: inOnboarding(w, closesAt),
          }));

    const state = summaryState(attempts);
    const counts = record && !deletedAt ? workflowCounts(record, closesAt) : null;
    const removed = Boolean(deletedAt) && state === "SUCCEEDED";
    // Whether the repository is there to be visited. A live migration that was
    // aborted or expired can still leave the repository on the target, so the
    // migration's own state is not proof either way — an attribute lookup that
    // resolved is. A success with no lookup yet is presumed present rather than
    // losing its link to a phase that has not run.
    const exists = !deletedAt && (Boolean(record?.observedAliveAt) || state === "SUCCEEDED");

    rows.push({
      id: key,
      d: bucket,
      organization: representative.org,
      repository: representative.repository,
      state,
      createdAt: representative.createdAt,
      migratedAt,
      durationMinutes: representative.durationMinutes ?? null,
      sourceUrl: representative.sourceUrl ?? null,
      sourceType: representative.sourceType ?? null,
      // The warnings of the attempt that produced the repository, like its state
      // and duration. Summing across attempts would multiply the same warnings
      // by however many times a migration was retried.
      warningsCount: representative.warningsCount ?? 0,
      team: record?.team ?? null,
      repoSizeMB: record?.repoSizeMB ?? null,
      // A failed migration never created the repository, so calling it deleted
      // would misreport the failure.
      deletedAt: removed ? deletedAt : null,
      removed,
      exists,
      attemptCount: attempts.length,
      // A repository with a single workflow has nothing to fold, so that one
      // travels on the row and the table shows it inline rather than behind a
      // toggle that opens one line. Rows stay light: this is bounded at one
      // small object, and only for repositories that have exactly one.
      workflow: workflowList.length === 1 ? workflowList[0] : null,
      workflows: counts,
      onboarding: onboardingStatus(state, closesAt, counts, now),
    });

    if (!detail.has(bucket)) detail.set(bucket, {});
    detail.get(bucket)[key] = {
      attempts: attempts.map((a) => ({
        id: a.id,
        state: a.state,
        createdAt: a.createdAt,
        durationMinutes: a.durationMinutes ?? null,
        warningsCount: a.warningsCount ?? 0,
        repoSizeMB: record?.repoSizeMB ?? null,
        sourceUrl: a.sourceUrl ?? null,
        sourceType: a.sourceType ?? null,
        team: record?.team ?? null,
      })),
      workflows: workflowList,
    };
  }

  rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return { rows: markSuperseded(rows), detail };
}

function average(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// Aggregates the dashboard charts on, computed once here rather than in the
// browser so the client never has to load every row to draw a chart.
//
// Repositories removed after a successful migration are left out: the charts
// describe the estate as it stands, and counting a repository that no longer
// exists would overstate it. They stay in the row payload so the dashboard can
// reveal them on demand.
function buildSummary(allRows, organizations) {
  const rows = allRows.filter((row) => !row.removed);
  const removed = allRows.length - rows.length;
  const kpis = { total: rows.length, succeeded: 0, failed: 0, ongoing: 0, withWarnings: 0 };
  const durations = [];
  const sizes = [];
  const warnings = [];
  const byState = new Map();
  const byTeam = new Map();
  const byOrg = new Map();
  const workflows = { succeeded: 0, failing: 0, idle: 0, failingRepos: 0, manual: 0, postOnboarding: 0 };
  const onboarding = { inProgress: 0, complete: 0, incomplete: 0 };

  for (const row of rows) {
    if (row.state === "SUCCEEDED") kpis.succeeded += 1;
    else if (row.state === "FAILED") kpis.failed += 1;
    if (ONGOING_STATES.has(row.state)) kpis.ongoing += 1;
    if ((row.warningsCount ?? 0) > 0) kpis.withWarnings += 1;

    if (row.onboarding === "in-progress") onboarding.inProgress += 1;
    else if (row.onboarding === "complete") onboarding.complete += 1;
    else if (row.onboarding === "incomplete") onboarding.incomplete += 1;

    warnings.push(row.warningsCount ?? 0);
    if (typeof row.durationMinutes === "number") durations.push(row.durationMinutes);
    if (typeof row.repoSizeMB === "number") sizes.push(row.repoSizeMB);

    byState.set(row.state, (byState.get(row.state) ?? 0) + 1);
    tally(byTeam, row.team || "Unassigned", row);
    tally(byOrg, row.organization || "Unknown", row);

    if (row.workflows) {
      workflows.succeeded += row.workflows.succeeded;
      workflows.failing += row.workflows.failing;
      workflows.idle += row.workflows.idle;
      workflows.manual += row.workflows.manual ?? 0;
      workflows.postOnboarding += row.workflows.postOnboarding ?? 0;
      if (row.workflows.failing > 0) workflows.failingRepos += 1;
    }
  }

  const completed = kpis.succeeded + kpis.failed;
  const rated = workflows.succeeded + workflows.failing;

  return {
    organizations,
    removed,
    kpis: {
      ...kpis,
      successRate: completed ? kpis.succeeded / completed : null,
      avgWarnings: average(warnings),
      avgDurationMinutes: average(durations),
      // A duration comes from the audit event that brought a repository online,
      // which not every migration produces and which the log only retains for
      // 180 days. Reporting the sample size keeps the average from reading as if
      // it covered the whole estate.
      durationSamples: durations.length,
      avgRepoSizeMB: average(sizes),
      repoSizeSamples: sizes.length,
    },
    onboarding,
    workflows: {
      ...workflows,
      total: workflows.succeeded + workflows.failing + workflows.idle,
      successRate: rated ? workflows.succeeded / rated : null,
    },
    states: [...byState.entries()].map(([state, count]) => ({ state, count })),
    teams: [...byTeam.values()],
    orgs: [...byOrg.values()],
  };
}

function tally(map, key, row) {
  const entry = map.get(key) ?? {
    key,
    succeeded: 0,
    failed: 0,
    other: 0,
    workflows: { succeeded: 0, failing: 0, idle: 0 },
  };
  if (row.state === "SUCCEEDED") entry.succeeded += 1;
  else if (row.state === "FAILED") entry.failed += 1;
  else entry.other += 1;
  if (row.workflows) {
    entry.workflows.succeeded += row.workflows.succeeded;
    entry.workflows.failing += row.workflows.failing;
    entry.workflows.idle += row.workflows.idle;
  }
  map.set(key, entry);
}

export { buildRows, buildSummary, summaryState, sourceKey, markSuperseded, migratedAtOf };
