// Enterprise Live Migrations (ELM) — GitHub Enterprise Server to GitHub
// Enterprise Cloud with data residency — read from the destination tenant only.
//
// The `gh elm` CLI (github/gh-elm) drives the same migrations from the source
// appliance with an admin:enterprise PAT, but every record it creates is also
// reported by the destination, and that is the side this action already holds a
// token for. Reading the target keeps the action on a single credential.
//
//   GET /enterprise/migration/list          every migration on the tenant
//   GET /enterprise/migration/{id}/status   per-repository resource progress
//
// Only the list is read. It carries the repositories and status the dashboard
// charts on in one call per 100 migrations, while status costs one call per
// migration for counters no card or table shows.

const PAGE_SIZE = 100;

// The target API speaks its own status vocabulary. Folding it into the states
// the dashboard already uses is what lets live migrations share the existing
// cards and tables instead of needing their own. Aborted and expired both leave
// the repository absent from the target, so they read as failures; what
// distinguishes them survives as the failure reason.
const STATES = {
  STATUS_TYPE_COMPLETE: { state: "SUCCEEDED" },
  STATUS_TYPE_IN_PROGRESS: { state: "IN_PROGRESS" },
  STATUS_TYPE_PAUSED: { state: "PAUSED" },
  STATUS_TYPE_FAILED: { state: "FAILED" },
  STATUS_TYPE_ABORTED: { state: "FAILED", failureReason: "Migration aborted" },
  STATUS_TYPE_EXPIRED: { state: "FAILED", failureReason: "Migration expired" },
  STATUS_TYPE_INVALID: { state: "PENDING" },
};

const SOURCE_TYPE = "Enterprise Live Migration";

// Statuses that will never change again, so a record carrying one needs no
// further reads.
const SETTLED = new Set([
  "STATUS_TYPE_COMPLETE",
  "STATUS_TYPE_FAILED",
  "STATUS_TYPE_ABORTED",
  "STATUS_TYPE_EXPIRED",
]);

// The list endpoint has no `since`, so the whole tenant is re-read every run and
// the cost grows with the estate rather than with the migration rate. It can be
// cut short only if the newest records come first, and that is inferred from the
// timestamps rather than assumed: reading a descending list as ascending would
// stop on page one and never see a new migration again.
function newestFirst(migrations) {
  const times = migrations
    .map((m) => Date.parse(m?.createdAt ?? m?.created_at ?? ""))
    .filter(Number.isFinite);
  if (times.length < 2) return false;
  return times[0] > times[times.length - 1];
}

function settledPage(migrations, known) {
  return migrations.every((m) => {
    const id = String(m?.migrationId ?? m?.migration_id ?? "");
    return id !== "" && SETTLED.has(m.status) && known.has(id);
  });
}

function splitNwo(nwo) {
  const slash = String(nwo ?? "").indexOf("/");
  if (slash <= 0) return null;
  const org = String(nwo).slice(0, slash);
  const repository = String(nwo).slice(slash + 1);
  return org && repository ? { org, repository } : null;
}

function firstTimestamp(...values) {
  for (const value of values) {
    if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  }
  return null;
}

// The target list models the migration record, not where it came from, so it
// carries no source repository in the shape gh-elm documents. A migration
// created target-side is given a source repository URL, though, so the field is
// probed under every name it could arrive as rather than assumed absent.
function sourceUrlOf(migration) {
  const candidates = [
    migration?.sourceUrl,
    migration?.source_url,
    migration?.sourceRepositoryUrl,
    migration?.source_repository_url,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

// One migration record becomes one row per repository it carries, matching the
// shape the GraphQL migrations produce so both flow through the same store,
// summary, and tables.
//
// The target API does not report when a migration was created, so `observedAt`
// dates a record the first time this action sees it. The caller pins that date
// afterwards — an undated row that re-dated itself every run would move between
// month shards and rewrite history.
function toRows(migration, observedAt) {
  const migrationId = String(migration?.migrationId ?? migration?.migration_id ?? "");
  if (!migrationId) return [];

  const mapped = STATES[migration.status] ?? { state: "PENDING" };
  const createdAt =
    firstTimestamp(migration.createdAt, migration.created_at, migration.startedAt) ?? observedAt;
  const sourceUrl = sourceUrlOf(migration);

  const rows = [];
  for (const nwo of migration.repositories ?? []) {
    const parts = splitNwo(nwo);
    if (!parts) continue;
    rows.push({
      id: `elm:${migrationId}:${parts.org}/${parts.repository}`,
      org: parts.org,
      repository: parts.repository,
      state: mapped.state,
      createdAt,
      warningsCount: 0,
      continueOnError: false,
      sourceUrl,
      failureReason: mapped.failureReason ?? null,
      migrationLogUrl: null,
      sourceType: SOURCE_TYPE,
      live: true,
    });
  }
  return rows;
}

// A host without live migrations — github.com, or a tenant that has not enabled
// them — must not fail a run that is otherwise healthy. This is an optional
// source, so any client error retires it for the run rather than throwing.
// GitHub's rate limit also arrives as a 403, and that one is the budget
// stopping rather than anything about the endpoint.
function unavailableReason(err, budget = null) {
  const status = err?.status ?? err?.response?.status ?? null;
  if (budget?.exhausted?.has("rest")) return "the REST budget ran out";
  if (status === 404) return "this host does not expose the live-migrations API";
  if (status === 401 || status === 403) {
    return "the token lacks the admin:enterprise scope that live migrations require";
  }
  if (status >= 400 && status < 500) return `the live-migrations API returned HTTP ${status}`;
  return null;
}

// Reads every live migration on the destination tenant, grouped by the
// organization each target repository lands in. Enterprise-wide, so this runs
// once per run rather than once per organization.
//
// `settledIds` are the migration ids already stored in a terminal state; a page
// made up entirely of those is the point at which a newest-first list has
// nothing left to say.
async function fetchLiveMigrations(
  octokit,
  budget,
  { pageSize = PAGE_SIZE, settledIds = new Set() } = {},
) {
  const observedAt = new Date().toISOString();
  const byOrg = new Map();
  const seenTokens = new Set();
  let count = 0;
  let pageToken = "";
  let descending = null;

  for (;;) {
    if (!budget.take("rest")) break;

    let data;
    try {
      ({ data } = await octokit.request("GET /enterprise/migration/list", {
        page_size: pageSize,
        ...(pageToken ? { page_token: pageToken } : {}),
      }));
    } catch (err) {
      const reason = unavailableReason(err, budget);
      if (!reason) throw err;
      return { byOrg: new Map(), count: 0, unavailable: reason };
    }

    const migrations = data?.migrations ?? [];
    for (const migration of migrations) {
      for (const row of toRows(migration, observedAt)) {
        if (!byOrg.has(row.org)) byOrg.set(row.org, []);
        byOrg.get(row.org).push(row);
        count += 1;
      }
    }

    if (descending === null) descending = newestFirst(migrations);
    if (descending && settledPage(migrations, settledIds)) break;

    const next = data?.nextPageToken ?? "";
    // A repeated cursor means the API cannot deliver the rest; stopping is the
    // only alternative to spinning forever on the same page.
    if (!next || seenTokens.has(next)) break;
    seenTokens.add(next);
    pageToken = next;
  }

  return { byOrg, count, unavailable: null };
}

export { fetchLiveMigrations, toRows, newestFirst, settledPage, STATES, SETTLED, SOURCE_TYPE };