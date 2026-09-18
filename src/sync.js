import * as core from "@actions/core";
import { fetchNewMigrations, refreshMigrations } from "./migrations.js";
import { fetchRepoDetails } from "./repos.js";
import { fetchWorkflowInventory, dateKnownWorkflows, needsDating } from "./workflows.js";
import { fetchMigrationLogDuration } from "./migrationLog.js";
import {
  emptyRepo,
  repoLocation,
  isSameRepository,
  applyMigration,
  applyRepoAttributes,
  applyRepoDeleted,
  applyWorkflowInventory,
  applyWorkflowDates,
  applyWorkflowRun,
  dedupeWorkflows,
  isAttributeRefreshDue,
  isTerminal,
  onboardingWindowMs,
  onboardingClosesAt,
} from "./apply.js";
import { migratedAtOf } from "./summary.js";

const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

// Bumped when a run starts recording something about a repository that older
// records cannot carry — here, its id and current location. The first run after
// an upgrade re-reads every repository once to back-fill it, then records the
// marker so the sweep settles instead of repeating.
const ATTRIBUTE_SCHEMA = 1;

// Bumped when workflows start carrying something their earlier classification
// could not. Until the marker is recorded, every run keeps dating the successes
// that predate it — including in repositories the re-list never revisits, which
// is the only way those ever get a date.
const DATING_SCHEMA = 1;

// A changed team-property makes every stored team wrong at once, so the TTL is
// bypassed for one sweep rather than left to expire over a week.
function isAttributeSweepDue(state, config) {
  return (
    state.teamProperty !== config.teamProperty ||
    state.attributeSchema !== ATTRIBUTE_SCHEMA ||
    Boolean(config.refreshAttributes)
  );
}

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

  // 3 — refresh team, size, and current location for the repositories whose copy
  // has gone stale, or every one of them when a sweep is due.
  const sweep = isAttributeSweepDue(state, config);
  const attributesDue = [];
  for (const repository of migratedRepos) {
    const record = store.getRepo(`${org}/${repository}`);
    const due =
      sweep ||
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
    // Each repository is looked up where it lives now. Asking under the old name
    // works only while GitHub keeps the redirect, which ends the moment someone
    // creates a repository with that name.
    const byOwner = new Map();
    for (const repository of attributesDue) {
      const { owner, name } = repoLocation(store.getRepo(`${org}/${repository}`), org, repository);
      if (!byOwner.has(owner)) byOwner.set(owner, []);
      byOwner.get(owner).push({ repository, name });
    }

    let refreshed = 0;
    let strangers = 0;
    for (const [owner, targets] of byOwner) {
      const details = await fetchRepoDetails(
        octokit,
        owner,
        targets.map((t) => t.name),
        config.teamProperty,
        budget,
      );
      for (const { repository, name } of targets) {
        const attributes = details.get(name);
        // A repo the lookup could not resolve keeps its stored attributes; only
        // an actual 404 during the workflow list is treated as deletion.
        if (!attributes) continue;
        const key = `${org}/${repository}`;
        const record = store.getRepo(key) ?? emptyRepo(org, repository);
        if (!isSameRepository(record, attributes.repoId)) {
          strangers += 1;
          continue;
        }
        store.putRepo(key, applyRepoAttributes(dedupeWorkflows(record), attributes, observedAt));
        refreshed += 1;
      }
    }
    core.info(`Refreshed attributes for ${refreshed} of ${attributesDue.length} due repo(s)`);
    if (strangers > 0) {
      core.info(
        `${strangers} repo(s) resolved to a different repository under the same name; left unchanged.`,
      );
    }
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

    const { owner, name } = repoLocation(record, org, repository);
    const workflows = await fetchWorkflowInventory(octokit, owner, name, budget, known);
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

  // 5 — date successes that were classified before the action recorded dates.
  // Unlike the re-list this ignores the window, because a settled repository is
  // never re-listed and would otherwise stay undated for good — and an estate
  // migrated before this feature existed is almost entirely settled.
  //
  // It runs until the marker is recorded, so a sweep the budget cuts short
  // simply continues next run.
  if (state.datingSchema !== DATING_SCHEMA) {
    let repos = 0;
    let workflows = 0;
    for (const repository of migratedRepos) {
      const key = `${org}/${repository}`;
      const record = store.getRepo(key);
      if (!record || record.deletedAt) continue;
      if (!Object.values(record.workflows ?? {}).some(needsDating)) continue;

      const { owner, name } = repoLocation(record, org, repository);
      const patch = await dateKnownWorkflows(octokit, owner, name, record.workflows, budget);
      if (Object.keys(patch).length > 0) {
        store.putRepo(key, applyWorkflowDates(record, patch));
        repos += 1;
        workflows += Object.keys(patch).length;
      }
      if (budget.exhausted.has("rest")) break;
    }
    if (repos > 0) {
      core.info(`Dated ${workflows} earlier success(es) across ${repos} repository(ies)`);
    }
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
  const moved = renameIndex(store);

  let applied = 0;
  let runEvents = 0;
  for (const event of events) {
    // The log names a repository where it lives now; the store keys it by the
    // name it was migrated under.
    const target = moved.get(`${event.org}/${event.repository}`) ?? event;
    const attemptsByRepo = attemptsFor(target.org);
    if (!attemptsByRepo.has(target.repository)) continue;

    const key = `${target.org}/${target.repository}`;
    const record = store.getRepo(key) ?? emptyRepo(target.org, target.repository);

    // A repository that has moved cannot be deleted under the name it left
    // behind; that event belongs to whatever repository took the name.
    const here = repoLocation(record, target.org, target.repository);
    if (event.type === "repo_deleted" && (here.owner !== event.org || here.name !== event.repository))
      continue;
    applied += 1;

    if (event.type === "workflow_run") {
      store.putRepo(key, applyWorkflowRun(record, event));
      runEvents += 1;
    } else if (event.type === "repo_deleted") {
      store.putRepo(key, applyRepoDeleted(record, new Date(event.at).toISOString()));
    } else if (event.type === "actions_enabled") {
      applyDuration(store, { ...event, ...target }, attemptsByRepo);
    }
  }
  return { applied, runEvents };
}

// Maps a repository's current location back to the key it is stored under.
// Only repositories that have moved are in it, so the common case costs nothing.
function renameIndex(store) {
  const index = new Map();
  for (const record of Object.values(store.allRepos())) {
    if (!record.currentOrg && !record.currentRepository) continue;
    const owner = record.currentOrg ?? record.org;
    const name = record.currentRepository ?? record.repository;
    index.set(`${owner}/${name}`, { org: record.org, repository: record.repository });
  }
  return index;
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
  const orgs = new Set(store.allMigrations().map((row) => row.org));
  // A repository transferred out of the organization it was migrated into emits
  // its events under the new owner, so that organization has to be read too.
  for (const record of Object.values(store.allRepos())) {
    if (record.currentOrg) orgs.add(record.currentOrg);
  }
  return [...orgs].sort();
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
  isAttributeSweepDue,
  ATTRIBUTE_SCHEMA,
  DATING_SCHEMA,
};
