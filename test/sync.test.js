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
  isAttributeSweepDue,
  ATTRIBUTE_SCHEMA,
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
  return { migrationCursors: {}, auditCursor: null, attributeSchema: ATTRIBUTE_SCHEMA };
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

// A renamed repository's events arrive under its new name. Matching only on the
// migrated name silently freezes its workflow status at the moment it was moved.
test("events for a renamed repository reach the record it was migrated as", () => {
  const store = tempStore();
  store.putMigration(migration());
  store.putRepo("org-a/api", {
    org: "org-a",
    repository: "api",
    currentOrg: "org-b",
    currentRepository: "platform-api",
    workflows: {},
  });

  const { applied } = applyAuditEvents(store, [
    {
      documentId: "run-1",
      at: Date.parse("2026-09-03T08:00:00Z"),
      type: "workflow_run",
      org: "org-b",
      repository: "platform-api",
      workflowKey: "ci.yml",
      workflowId: 7,
      name: "CI",
      conclusion: "success",
      completedAt: "2026-09-03T08:00:00Z",
    },
  ]);

  assert.equal(applied, 1);
  assert.equal(store.getRepo("org-b/platform-api"), null, "no second record under the new name");
  assert.equal(store.getRepo("org-a/api").workflows["ci.yml"].status, "succeeded");
});

// The events of a transferred repository are logged against its new owner, so
// that organization has to be in the read even if nothing was migrated into it.
test("the audit read covers organizations repositories were transferred to", () => {
  const store = tempStore();
  store.putMigration(migration());
  store.putRepo("org-a/api", {
    org: "org-a",
    repository: "api",
    currentOrg: "org-b",
    currentRepository: "api",
    workflows: {},
  });

  assert.deepEqual(migratedOrgs(store), ["org-a", "org-b"]);
});

// Once a repository moves, its old name is free for somebody else to take —
// and to delete. Reading that as our repository's deletion would badge a live
// repository as removed.
test("a deletion under the name a repository left behind is not its deletion", () => {
  const store = tempStore();
  store.putMigration(migration());
  store.putRepo("org-a/api", {
    org: "org-a",
    repository: "api",
    currentOrg: "org-a",
    currentRepository: "api-v2",
    workflows: {},
  });

  applyAuditEvents(store, [destroyed(Date.parse("2026-09-05T08:00:00Z"), "org-a", "api")]);
  assert.equal(store.getRepo("org-a/api").deletedAt, undefined);

  applyAuditEvents(store, [destroyed(Date.parse("2026-09-06T08:00:00Z"), "org-a", "api-v2")]);
  assert.ok(store.getRepo("org-a/api").deletedAt, "deleted where it actually lives");
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

// Existing records carry no location, so one sweep after an upgrade back-fills
// them. It has to settle afterwards, or the TTLs never apply again.
test("a store that predates location tracking is swept once, then settles", () => {
  const state = { teamProperty: "team" };
  assert.equal(isAttributeSweepDue(state, config), true, "no marker yet");

  state.attributeSchema = ATTRIBUTE_SCHEMA;
  assert.equal(isAttributeSweepDue(state, config), false);
  assert.equal(isAttributeSweepDue(state, { ...config, refreshAttributes: true }), true);
});

// The re-list stops at the window, so a settled repository is never revisited —
// and on an estate migrated before dating existed, almost everything is settled.
// The dating pass has to reach them or their successes stay undated for good.
test("earlier successes are dated even in a repository the re-list never revisits", async () => {
  const store = tempStore();
  // Migrated long enough ago that its window closed and re-listing has stopped:
  // the last inventory happened after the window closed, which is the rule.
  store.putMigration(migration({ createdAt: "2026-01-01T00:00:00Z" }));
  store.putRepo("org-a/api", {
    org: "org-a",
    repository: "api",
    workflowsBootstrappedAt: "2026-04-01T00:00:00Z",
    attributesFetchedAt: new Date().toISOString(),
    workflows: {
      "ci.yml": { name: "CI", path: "ci.yml", workflowId: 7, status: "succeeded", classifiedAt: "2026-01-02T00:00:00Z" },
      "release.yml": { name: "Release", path: "release.yml", workflowId: 8, status: "failing", classifiedAt: "2026-01-02T00:00:00Z" },
    },
  });

  let listed = 0;
  const octokit = {
    ...quietOctokit,
    graphql: async (query) => {
      if (query.includes("repositoryMigrations")) {
        return { organization: { repositoryMigrations: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
      }
      return {};
    },
    rest: {
      ...quietOctokit.rest,
      actions: {
        listRepoWorkflows: async () => {
          listed += 1;
          return { data: { workflows: [] } };
        },
        listWorkflowRuns: async ({ page }) => ({
          data: {
            total_count: 4,
            workflow_runs: [{ updated_at: page ? "2026-01-09T00:00:00Z" : "2026-05-01T00:00:00Z" }],
          },
        }),
      },
    },
  };

  const state = { ...freshState(), teamProperty: "team" };
  await sync({ store, state, octokit });

  const record = store.getRepo("org-a/api");
  assert.equal(listed, 0, "the repository is past its window, so it is never re-listed");
  assert.equal(record.workflows["ci.yml"].firstSuccessAt, "2026-01-09T00:00:00Z", "oldest success");
  assert.ok(record.workflows["ci.yml"].datedAt);
  assert.equal(record.workflows["release.yml"].firstSuccessAt, undefined, "nothing succeeded to date");
});

// A success that has aged out of Actions run retention can never be dated. The
// attempt is recorded so it is not re-probed on every run for the rest of time.
test("a success that cannot be dated is asked once, then left alone", async () => {
  const store = tempStore();
  store.putMigration(migration({ createdAt: "2026-01-01T00:00:00Z" }));
  store.putRepo("org-a/api", {
    org: "org-a",
    repository: "api",
    workflowsBootstrappedAt: "2026-04-01T00:00:00Z",
    attributesFetchedAt: new Date().toISOString(),
    workflows: {
      "ci.yml": { name: "CI", path: "ci.yml", workflowId: 7, status: "succeeded", classifiedAt: "2026-01-02T00:00:00Z" },
    },
  });

  let probes = 0;
  const octokit = {
    ...quietOctokit,
    graphql: async (query) => {
      if (query.includes("repositoryMigrations")) {
        return { organization: { repositoryMigrations: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
      }
      return {};
    },
    rest: {
      ...quietOctokit.rest,
      actions: {
        listRepoWorkflows: async () => ({ data: { workflows: [] } }),
        // The runs have aged out, so there is nothing left to date it from.
        listWorkflowRuns: async () => {
          probes += 1;
          return { data: { total_count: 0, workflow_runs: [] } };
        },
      },
    },
  };

  await sync({ store, state: { ...freshState(), teamProperty: "team" }, octokit });
  const after = probes;
  assert.ok(after > 0, "it was asked");
  assert.equal(store.getRepo("org-a/api").workflows["ci.yml"].firstSuccessAt, null);

  await sync({ store, state: { ...freshState(), teamProperty: "team" }, octokit });
  assert.equal(probes, after, "and not asked again");
});

// Asking under the old name works only while GitHub keeps the redirect, which
// ends the moment somebody creates a repository with that name.
test("attributes are read where the repository lives now", async () => {
  const store = tempStore();
  store.putMigration(migration());
  store.putRepo("org-a/api", {
    org: "org-a",
    repository: "api",
    repoId: "R_api",
    currentOrg: "org-b",
    currentRepository: "platform-api",
    workflows: {},
  });

  const asked = [];
  const octokit = {
    ...quietOctokit,
    graphql: async (query, variables) => {
      if (query.includes("repositoryMigrations")) {
        return { organization: { repositoryMigrations: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
      }
      asked.push(variables);
      return {
        r0: {
          id: "R_api",
          nameWithOwner: "org-b/platform-api",
          diskUsage: 1024,
          repositoryCustomPropertyValues: { nodes: [] },
        },
      };
    },
  };

  await sync({ store, state: { ...freshState(), teamProperty: "team" }, octokit });

  assert.deepEqual(asked[0], { owner: "org-b", n0: "platform-api" });
  assert.equal(store.getRepo("org-a/api").repoSizeMB, 1);
});

// A repository created under a name a migrated repository used to have is a
// different repository. Folding its size and team in would misreport both.
test("a stranger under the old name does not overwrite the migrated repository", async () => {
  const store = tempStore();
  store.putMigration(migration());
  store.putRepo("org-a/api", {
    org: "org-a",
    repository: "api",
    repoId: "R_ours",
    team: "Platform",
    repoSizeMB: 5,
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
          id: "R_somebody_else",
          nameWithOwner: "org-a/api",
          diskUsage: 99999,
          repositoryCustomPropertyValues: { nodes: [{ propertyName: "team", value: "Unrelated" }] },
        },
      };
    },
  };

  await sync({ store, state: { ...freshState(), teamProperty: "team" }, octokit });

  const record = store.getRepo("org-a/api");
  assert.equal(record.team, "Platform");
  assert.equal(record.repoSizeMB, 5);
  assert.equal(record.observedAliveAt, undefined, "a stranger is not proof our repository is alive");
});
