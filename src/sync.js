import * as core from "@actions/core";
import { fetchNewMigrations, refreshMigrations } from "./migrations.js";
import { fetchRepoDetails } from "./repos.js";
import { fetchWorkflowInventory } from "./workflows.js";
import { fetchMigrationLogDuration } from "./migrationLog.js";
import {
  emptyRepo,
  applyMigration,
  applyRepoAttributes,
  applyRepoDeleted,
  applyWorkflowInventory,
  applyWorkflowRun,
  dedupeWorkflows,
  isAttributeRefreshDue,
  isTerminal,
  onboardingWindowMs,
  onboardingClosesAt,
} from "./apply.js";
import { migratedAtOf } from "./summary.js";

const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

// Records one organization's live migrations. They were already read
// enterprise-wide, and this must run for every organization — including one the
// token cannot read as an owner, which still has its live migrations, just
// without the team, size, and workflow enrichment that syncOrganization adds.
//
// The destination reports them in full every run, so they need no cursor; they
// do need their first-seen date pinned, since the API does not report when a
// migration was created and a re-dated row would move between month shards.
function recordLiveMigrations(store, org, liveRows) {
  if (liveRows.length === 0) return;
  const priorById = new Map(store.migrationsFor(org).map((row) => [row.id, row]));
  for (const row of liveRows) {
    const prior = priorById.get(row.id) ?? null;
    const dated = prior ? { ...row, createdAt: prior.createdAt } : row;
    store.putMigration(applyMigration(prior, dated));
  }
  core.info(`Live migrations: ${liveRows.length} repository migration(s)`);
}

// Brings one organization up to date: the migration log, attributes, and the
// workflow inventory. Live migrations are recorded by recordLiveMigrations and
// the audit feed that maintains workflow status is read once for the whole
// enterprise (see applyAuditEvents), so neither happens here. Split out of
// index.js so the sequencing — which cursor advances when, and what a spent
// budget leaves for the next run — can be tested without a runner.
async function syncOrganization({
  octokit,
  org,
  store,
  state,
  budget,
  config,
  fetchLog = fetchMigrationLogDuration,
}) {
  const ownMigrations = () => store.migrationsFor(org);

  // 1 — advance the append-only migration log from the stored cursor.
  const { rows: fresh, cursor } = await fetchNewMigrations(
    octokit,
    org,
    state.migrationCursors[org],
    budget,
  );
  for (const row of fresh) {
    store.putMigration(applyMigration(store.getMigration(row.id, row.createdAt), row));
  }
  if (cursor) state.migrationCursors[org] = cursor;
  core.info(`Migrations: ${fresh.length} new or updated`);

  // 2 — re-check only the migrations still in flight. Live ones are excluded:
  // their ids are not GraphQL node ids, and the tenant listing already refreshed
  // them above.
  const inFlight = ownMigrations().filter((row) => !row.live && !isTerminal(row.state));
  if (inFlight.length > 0) {
    const refreshed = await refreshMigrations(octokit, inFlight, budget);
    for (const row of refreshed) store.putMigration(row);
    core.info(`Re-checked ${refreshed.length} in-flight migration(s)`);
  }

  // 2b — read each newly succeeded migration's own log for its exact duration.
  // The log URL expires five days after completion, so this is a one-time read
  // per migration; anything already dated, or whose log is gone, is left to the
  // audit-log fallback. Plain downloads, so no budget is spent.
  await dateFromMigrationLogs(store, org, fetchLog);

  const migratedRepos = new Set(ownMigrations().map((row) => row.repository));
  if (migratedRepos.size === 0) return;

  // When each repository's onboarding window closes. Both the attribute refresh
  // and the workflow re-list slow down once a repository is past it, which is
  // what keeps their cost tied to the migration rate instead of the estate.
  const windowMs = onboardingWindowMs(config.onboardingWindowDays);
  const attemptsByRepo = groupAttempts(ownMigrations());
  const closesAtOf = (repository) => {
    const attempts = attemptsByRepo.get(repository);
    return attempts ? onboardingClosesAt(migratedAtOf(attempts), windowMs) : Infinity;
  };

  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const onboardingTtlMs = config.attributeTtlDays * DAY_MS;
  const settledTtlMs =
    config.settledAttributeTtlDays > 0 ? config.settledAttributeTtlDays * DAY_MS : Infinity;

  // 3 — refresh team and size for the repositories whose copy has gone stale.
  // A changed team-property makes every stored team wrong at once, so the TTL
  // is bypassed for one sweep rather than left to expire over a week.
  const attributesDue = [];
  for (const repository of migratedRepos) {
    const record = store.getRepo(`${org}/${repository}`);
    const due =
      state.teamProperty !== config.teamProperty ||
      isAttributeRefreshDue(record, {
        now,
        closesAt: closesAtOf(repository),
        onboardingTtlMs,
        settledTtlMs,
      });
    if (due) attributesDue.push(repository);
  }

  if (attributesDue.length > 0) {
    const observedAt = new Date().toISOString();
    const details = await fetchRepoDetails(
      octokit,
      org,
      attributesDue,
      config.teamProperty,
      budget,
    );
    for (const repository of attributesDue) {
      const attributes = details.get(repository);
      // A repo the lookup could not resolve keeps its stored attributes; only
      // an actual 404 during the workflow list is treated as deletion.
      if (!attributes) continue;
      const key = `${org}/${repository}`;
      const record = store.getRepo(key) ?? emptyRepo(org, repository);
      store.putRepo(key, applyRepoAttributes(dedupeWorkflows(record), attributes, observedAt));
    }
    core.info(`Refreshed attributes for ${details.size} of ${attributesDue.length} due repo(s)`);
  }

  // 4 — inventory workflows: once when a repository first appears, then on a TTL
  // so workflows added after migration are found even if they never run (a
  // workflow that never runs emits no audit event).
  //
  // Re-listing stops one sweep after the onboarding window closes. That bounds
  // this phase to repositories still onboarding, so its cost tracks the
  // migration rate rather than the size of the estate.
  const ttlMs = config.inventoryTtlDays * DAY_MS;
  const due = [];
  for (const repository of migratedRepos) {
    const record = store.getRepo(`${org}/${repository}`) ?? emptyRepo(org, repository);
    if (record.deletedAt) continue;
    const inventoriedAt = Date.parse(record.workflowsBootstrappedAt ?? 0) || 0;
    if (inventoriedAt && (ttlMs === 0 || now - inventoriedAt < ttlMs)) continue;
    if (inventoriedAt > closesAtOf(repository)) continue;
    due.push({ repository, record, inventoriedAt });
  }
  // Never-inventoried repositories first, then the stalest.
  due.sort((a, b) => a.inventoriedAt - b.inventoriedAt);

  let inventoried = 0;
  for (const { repository, record } of due) {
    const key = `${org}/${repository}`;
    const known = Object.fromEntries(
      Object.values(record.workflows ?? {})
        .filter((w) => w.path)
        .map((w) => [w.path, w]),
    );

    const workflows = await fetchWorkflowInventory(octokit, org, repository, budget, known);
    if (workflows === null) {
      // Out of budget mid-sweep leaves the rest for the next run.
      if (budget.truncated) break;
      store.putRepo(key, applyRepoDeleted(record, new Date().toISOString()));
      continue;
    }
    store.putRepo(key, applyWorkflowInventory(record, workflows, new Date().toISOString()));
    inventoried += 1;
  }
  if (due.length > 0) {
    core.info(`Inventoried workflows for ${inventoried} of ${due.length} due repository(ies)`);
  }
}

// Dates undated successes from their migration logs. Live migrations have no
// log; a log that could not be read is marked so the URL is not retried on
// every run for the rest of time — after five days it is gone for good, and the
// audit-log fallback may still date the attempt.
async function dateFromMigrationLogs(store, org, fetchLog) {
  const due = store
    .migrationsFor(org)
    .filter(
      (row) =>
        row.state === "SUCCEEDED" &&
        !row.live &&
        row.durationSource !== "log" &&
        !row.logChecked &&
        row.migrationLogUrl,
    );
  if (due.length === 0) return;

  let dated = 0;
  for (const row of due) {
    const result = await fetchLog(row.migrationLogUrl);
    const next = result ? { ...row, ...result } : { ...row, logChecked: true };
    if (result) dated += 1;
    store.putMigration(next);
  }
  core.info(`Migration logs: ${dated} of ${due.length} read for an exact duration`);
}

function groupAttempts(rows) {
  const byRepo = new Map();
  for (const row of rows) {
    if (!byRepo.has(row.repository)) byRepo.set(row.repository, []);
    byRepo.get(row.repository).push(row);
  }
  return byRepo;
}

// Applies one run's worth of enterprise audit events to the repositories they
// concern. Events for repositories that were never migrated are dropped here,
// which is what keeps a busy enterprise's unrelated activity from costing
// anything beyond the read.
function applyAuditEvents(store, events) {
  const attemptsByOrg = new Map();
  const attemptsFor = (org) => {
    if (!attemptsByOrg.has(org)) attemptsByOrg.set(org, groupAttempts(store.migrationsFor(org)));
    return attemptsByOrg.get(org);
  };

  let applied = 0;
  let runEvents = 0;
  for (const event of events) {
    const attemptsByRepo = attemptsFor(event.org);
    if (!attemptsByRepo.has(event.repository)) continue;
    applied += 1;

    const key = `${event.org}/${event.repository}`;
    const record = store.getRepo(key) ?? emptyRepo(event.org, event.repository);

    if (event.type === "workflow_run") {
      store.putRepo(key, applyWorkflowRun(record, event));
      runEvents += 1;
    } else if (event.type === "repo_deleted") {
      store.putRepo(key, applyRepoDeleted(record, new Date(event.at).toISOString()));
    } else if (event.type === "actions_enabled") {
      applyDuration(store, event, attemptsByRepo);
    }
  }
  return { applied, runEvents };
}

// Dates an attempt from the audit log's Actions-enabled event, the importer's
// last step. This is the fallback for migrations whose log has expired; a
// duration read from the migration log itself (durationSource "log") is exact
// and is never overwritten. Attempts are looked up by repository rather than
// scanned, so a backfill of events does not cost events x log.
function applyDuration(store, event, attemptsByRepo = null) {
  const attempts =
    attemptsByRepo?.get(event.repository) ??
    store.migrationsFor(event.org).filter((row) => row.repository === event.repository);

  attempts.forEach((row, index) => {
    if (row.durationMinutes != null) return;
    const createdMs = Date.parse(row.createdAt);
    if (!Number.isFinite(createdMs) || event.at <= createdMs) return;
    // People enable Actions too, long after a migration; no importer run takes
    // a week, so anything later is not a completion.
    if (event.at - createdMs > MAX_DURATION_MS) return;

    const dated = {
      ...row,
      durationMinutes: Math.round((event.at - createdMs) / 60000),
      durationSource: "audit",
    };
    store.putMigration(dated);
    // The overlap window can redeliver an event; keeping the index in step stops
    // a second copy from re-dating a duration already derived.
    attempts[index] = dated;
  });
}


// Nothing in the audit log from before the first migration can concern a
// migrated repository, so a first read starts there rather than at the
// beginning of the enterprise's retained history — which, for a busy
// enterprise, is mostly workflow runs in repositories that were never migrated.
function earliestMigrationMs(store) {
  let earliest = Infinity;
  for (const row of store.allMigrations()) {
    const at = Date.parse(row.createdAt);
    if (Number.isFinite(at) && at < earliest) earliest = at;
  }
  return earliest === Infinity ? null : earliest;
}

// Audit events only ever apply to repositories with a recorded migration, so
// these are the only organizations worth asking the log about. An organization
// the token cannot read has none, and drops out of the read for free.
function migratedOrgs(store) {
  return [...new Set(store.allMigrations().map((row) => row.org))].sort();
}

// Every workflow's history is classified by REST when its repository is first
// inventoried, so no run event older than the earliest inventory can change a
// status. That moment is where the run stream starts; before it there is
// nothing to maintain. Null until a repository has been inventoried.
function earliestInventoryMs(store) {
  let earliest = Infinity;
  for (const record of Object.values(store.allRepos())) {
    const at = Date.parse(record.workflowsBootstrappedAt ?? "");
    if (Number.isFinite(at) && at < earliest) earliest = at;
  }
  return earliest === Infinity ? null : earliest;
}

export {
  recordLiveMigrations,
  syncOrganization,
  applyAuditEvents,
  applyDuration,
  earliestMigrationMs,
  earliestInventoryMs,
  migratedOrgs,
};
