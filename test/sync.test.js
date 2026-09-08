import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recordLiveMigrations,
  syncOrganization,
  applyAuditEvents,
  earliestMigrationMs,
  earliestInventoryMs,
  migratedOrgs,
} from "../src/sync.js";
import { Store } from "../src/store.js";
import { Budget } from "../src/budget.js";

// Covers the sequencing index.js used to hold inline. Every module it calls is
// stubbed, so this exercises the composition rather than the API.

function tempStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "migration-store-"));
  return new Store(root);
}

const config = {
  teamProperty: "team",
  inventoryTtlDays: 7,
  attributeTtlDays: 1,
  settledAttributeTtlDays: 7,
  onboardingWindowDays: 60,
};

const MIGRATED_AT = "2026-09-01T08:00:00Z";
const ENABLED_AT = Date.parse("2026-09-01T08:30:00Z");

function migration(overrides = {}) {
  return {
    id: "M1",
    org: "org-a",
    repository: "api",
    state: "SUCCEEDED",
    createdAt: MIGRATED_AT,
    warningsCount: 0,
    ...overrides,
  };
}

const quietOctokit = {
  graphql: async () => ({}),
  rest: {
    actions: {
      listRepoWorkflows: async () => ({ data: { workflows: [] } }),
      listWorkflowRuns: async () => ({ data: { workflow_runs: [], total_count: 0 } }),
    },
    repos: {
      getContent: async () => ({ data: { content: "", encoding: "base64" } }),
    },
  },
};

async function sync({ store, state, budget = new Budget({}), octokit = quietOctokit, fetchLog = async () => null }) {
  await syncOrganization({ octokit, org: "org-a", store, state, budget, config, fetchLog });
}

function freshState() {
  return { migrationCursors: {}, auditCursor: null };
}

const enabled = (at = ENABLED_AT, documentId = "on-1") => ({
  documentId,
  at,
  type: "actions_enabled",
  org: "org-a",
  repository: "api",
});

const destroyed = (at, org = "org-a", repository = "api") => ({
  documentId: `gone-${at}`,
  at,
  type: "repo_deleted",
  org,
  repository,
});

test("a live migration keeps the date it was first seen on", () => {
  const store = tempStore();
  const live = migration({ id: "elm:1:org-a/api", live: true, createdAt: "2026-09-05T00:00:00Z" });

  recordLiveMigrations(store, "org-a", [live]);
  const first = store.migrationsFor("org-a")[0].createdAt;

  // The destination does not report when a live migration was created, so a
  // re-dated row would move between month shards on every run.
  recordLiveMigrations(store, "org-a", [{ ...live, createdAt: "2026-10-05T00:00:00Z" }]);

  assert.equal(store.migrationsFor("org-a")[0].createdAt, first);
});

// Recording is separate from syncing so an organization the token cannot read
// as an owner — which throws in sync and is then backed off — still has its live
// migrations kept current.
test("live migrations are recorded without touching the API", () => {
  const store = tempStore();
  const live = migration({ id: "elm:1:org-a/api", live: true, state: "IN_PROGRESS" });

  recordLiveMigrations(store, "org-a", [live]);
  recordLiveMigrations(store, "org-a", [{ ...live, state: "SUCCEEDED" }]);

  assert.equal(store.migrationsFor("org-a")[0].state, "SUCCEEDED");
});

test("a first audit read starts at the earliest migration", () => {
  const store = tempStore();
  assert.equal(earliestMigrationMs(store), null, "nothing migrated, nothing to bound");

  store.putMigration(migration({ id: "M2", createdAt: "2026-03-01T00:00:00Z" }));
  store.putMigration(migration({ id: "M1", createdAt: "2026-01-15T00:00:00Z" }));

  assert.equal(earliestMigrationMs(store), Date.parse("2026-01-15T00:00:00Z"));
});

// An organization the token could not read has no migrations recorded, so it
// never reaches the audit-log phrase.
test("the audit read is scoped to organizations holding migrations", () => {
  const store = tempStore();
  assert.deepEqual(migratedOrgs(store), []);

  store.putMigration(migration({ id: "M1", org: "org-b" }));
  store.putMigration(migration({ id: "M2", org: "org-a" }));
  store.putMigration(migration({ id: "M3", org: "org-a", repository: "web" }));

  assert.deepEqual(migratedOrgs(store), ["org-a", "org-b"]);
});

// Run events older than the first inventory cannot change a status — REST
// classified that history — so the run stream starts there, not at the
// earliest migration.
test("the run stream starts at the earliest inventory", () => {
  const store = tempStore();
  assert.equal(earliestInventoryMs(store), null, "nothing inventoried, nothing to maintain");

  store.putRepo("org-a/api", { org: "org-a", repository: "api", workflows: {}, workflowsBootstrappedAt: "2026-09-09T10:00:00Z" });
  store.putRepo("org-a/web", { org: "org-a", repository: "web", workflows: {}, workflowsBootstrappedAt: "2026-09-08T10:00:00Z" });
  store.putRepo("org-a/old", { org: "org-a", repository: "old", workflows: {}, workflowsBootstrappedAt: null });

  assert.equal(earliestInventoryMs(store), Date.parse("2026-09-08T10:00:00Z"));
});

test("an actions_enabled event turns a migration date into a duration", () => {
  const store = tempStore();
  store.putMigration(migration());

  const { applied } = applyAuditEvents(store, [enabled()]);

  assert.equal(applied, 1);
  assert.equal(store.migrationsFor("org-a")[0].durationMinutes, 30);
});

test("a redelivered event does not re-date a duration already derived", () => {
  const store = tempStore();
  store.putMigration(migration());

  applyAuditEvents(store, [enabled(), enabled(Date.parse("2026-09-01T20:00:00Z"), "on-2")]);

  assert.equal(store.migrationsFor("org-a")[0].durationMinutes, 30);
});

// The migration log's own timestamps are exact; the audit event is the fallback
// for migrations whose log has expired, and never replaces a log-derived value.
test("a duration read from the migration log is not overwritten by the audit log", () => {
  const store = tempStore();
  store.putMigration(migration({ durationMinutes: 151, durationSource: "log", gitMinutes: 1 }));

  applyAuditEvents(store, [enabled()]);

  const row = store.migrationsFor("org-a")[0];
  assert.equal(row.durationMinutes, 151);
  assert.equal(row.durationSource, "log");
});

test("an Actions-enabled event more than a week after the migration is somebody else's doing", () => {
  const store = tempStore();
  store.putMigration(migration());

  applyAuditEvents(store, [enabled(Date.parse("2026-09-20T08:00:00Z"), "late")]);

  assert.equal(store.migrationsFor("org-a")[0].durationMinutes, undefined);
});

// The log URL expires after five days, so each success gets one read: dated if
// the log is there, marked checked if it is gone, never fetched twice either way.
test("a newly succeeded migration is dated from its log exactly once", async () => {
  const store = tempStore();
  store.putMigration(migration({ id: "M1", migrationLogUrl: "https://logs/m1" }));
  store.putMigration(migration({ id: "M2", repository: "web", migrationLogUrl: "https://logs/m2" }));
  store.putMigration(migration({ id: "M3", repository: "cli", state: "FAILED", migrationLogUrl: "https://logs/m3" }));
  store.putMigration(migration({ id: "elm:1", repository: "live", live: true }));

  const asked = [];
  const fetchLog = async (url) => {
    asked.push(url);
    return url.endsWith("m1") ? { durationMinutes: 151, durationSource: "log", gitMinutes: 62 } : null;
  };

  await sync({ store, state: freshState(), fetchLog });
  assert.deepEqual(asked.sort(), ["https://logs/m1", "https://logs/m2"], "failed and live rows are skipped");

  const byId = Object.fromEntries(store.migrationsFor("org-a").map((m) => [m.id, m]));
  assert.equal(byId.M1.durationMinutes, 151);
  assert.equal(byId.M1.durationSource, "log");
  assert.equal(byId.M1.gitMinutes, 62);
  assert.equal(byId.M2.durationMinutes, undefined);
  assert.equal(byId.M2.logChecked, true);

  await sync({ store, state: freshState(), fetchLog });
  assert.equal(asked.length, 2, "nothing is fetched a second time");
});

test("a repo.destroy event marks the repository deleted", () => {
  const store = tempStore();
  store.putMigration(migration());
  const at = Date.parse("2026-09-02T08:00:00Z");

  applyAuditEvents(store, [destroyed(at)]);

  assert.equal(store.getRepo("org-a/api").deletedAt, new Date(at).toISOString());
});

// The enterprise stream carries every organization's activity. Only events for
// repositories the dashboard tracks may touch the store, or a busy enterprise
// would grow a record for every repository it has.
test("events for repositories that were never migrated are dropped", () => {
  const store = tempStore();
  store.putMigration(migration());
  const at = Date.parse("2026-09-02T08:00:00Z");

  const { applied } = applyAuditEvents(store, [
    destroyed(at, "org-a", "unrelated"),
    destroyed(at, "org-z", "api"),
    destroyed(at),
  ]);

  assert.equal(applied, 1);
  assert.equal(store.getRepo("org-a/unrelated"), null);
  assert.equal(store.getRepo("org-z/api"), null);
  assert.ok(store.getRepo("org-a/api").deletedAt);
});

test("events are routed to their own organization", () => {
  const store = tempStore();
  store.putMigration(migration());
  store.putMigration(migration({ id: "M2", org: "org-b", repository: "api" }));
  const at = Date.parse("2026-09-02T08:00:00Z");

  applyAuditEvents(store, [destroyed(at, "org-b")]);

  assert.equal(store.getRepo("org-a/api"), null, "org-a's repository of the same name is untouched");
  assert.ok(store.getRepo("org-b/api").deletedAt);
});

test("an organization with no migrations does no work", async () => {
  const store = tempStore();
  let asked = false;

  await sync({
    store,
    state: freshState(),
    octokit: { ...quietOctokit, graphql: async () => ((asked = true), {}) },
  });

  // One request to learn there is nothing new, and nothing after it.
  assert.equal(asked, true);
  assert.equal(Object.keys(store.allRepos()).length, 0);
});

// A changed team-property makes every stored team wrong at once; waiting for
// the settled TTL would leave the dashboard on the old grouping for a week.
test("a changed team-property re-reads attributes before their TTL", async () => {
  const store = tempStore();
  store.putMigration(migration());
  store.putRepo("org-a/api", {
    org: "org-a",
    repository: "api",
    team: null,
    attributesFetchedAt: new Date().toISOString(),
    workflowsBootstrappedAt: new Date().toISOString(),
    workflows: {},
  });

  const octokit = {
    ...quietOctokit,
    graphql: async (query) => {
      if (query.includes("repositoryMigrations")) {
        return { organization: { repositoryMigrations: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
      }
      return {
        r0: {
          name: "api",
          diskUsage: 1024,
          repositoryCustomPropertyValues: { nodes: [{ propertyName: "area", value: "Mobility" }] },
        },
      };
    },
  };

  const unchanged = { ...freshState(), teamProperty: "team" };
  await sync({ store, state: unchanged, octokit });
  assert.equal(store.getRepo("org-a/api").team, null, "fresh attributes are left alone");

  const changed = { ...freshState(), teamProperty: "team" };
  await syncOrganization({
    octokit,
    org: "org-a",
    store,
    state: changed,
    budget: new Budget({}),
    config: { ...config, teamProperty: "area" },
  });
  assert.equal(store.getRepo("org-a/api").team, "Mobility");
});
