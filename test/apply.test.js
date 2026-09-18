import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyRepo,
  repoLocation,
  isSameRepository,
  applyWorkflowRun,
  applyWorkflowInventory,
  applyRepoAttributes,
  applyRepoDeleted,
  applyMigration,
  dedupeWorkflows,
  workflowCounts,
  backOnlineAt,
  inOnboarding,
  onboardingWindowMs,
  onboardingClosesAt,
  isAttributeRefreshDue,
} from "../src/apply.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-06-01T00:00:00Z");
const ttls = { now: NOW, onboardingTtlMs: 1 * DAY, settledTtlMs: 7 * DAY };

test("a repository never fetched is always due for attributes", () => {
  assert.equal(isAttributeRefreshDue(undefined, { ...ttls, closesAt: Infinity }), true);
  assert.equal(
    isAttributeRefreshDue({ attributesFetchedAt: null }, { ...ttls, closesAt: Infinity }),
    true,
  );
});

test("an onboarding repository refreshes attributes on the short TTL", () => {
  const record = { attributesFetchedAt: new Date(NOW - 2 * DAY).toISOString() };
  const closesAt = NOW + 10 * DAY;
  assert.equal(isAttributeRefreshDue(record, { ...ttls, closesAt }), true);

  const fresh = { attributesFetchedAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() };
  assert.equal(isAttributeRefreshDue(fresh, { ...ttls, closesAt }), false);
});

test("a settled repository still refreshes, just less often", () => {
  // Team ownership changes long after a migration, so it must not freeze.
  const closesAt = NOW - 10 * DAY;
  const twoDays = { attributesFetchedAt: new Date(NOW - 2 * DAY).toISOString() };
  const tenDays = { attributesFetchedAt: new Date(NOW - 10 * DAY).toISOString() };

  assert.equal(isAttributeRefreshDue(twoDays, { ...ttls, closesAt }), false);
  assert.equal(isAttributeRefreshDue(tenDays, { ...ttls, closesAt }), true);
});

test("a settled TTL of Infinity freezes attributes at window close", () => {
  const record = { attributesFetchedAt: new Date(NOW - 365 * DAY).toISOString() };
  const opts = { ...ttls, settledTtlMs: Infinity, closesAt: NOW - 10 * DAY };
  assert.equal(isAttributeRefreshDue(record, opts), false);
});

test("a deleted repository is never refreshed", () => {
  const record = { attributesFetchedAt: null, deletedAt: "2026-01-01T00:00:00Z" };
  assert.equal(isAttributeRefreshDue(record, { ...ttls, closesAt: Infinity }), false);
});

const repo = () => emptyRepo("org-a", "api");

test("a successful run marks the workflow succeeded", () => {
  const after = applyWorkflowRun(repo(), {
    workflowKey: "id:1",
    name: "CI",
    conclusion: "success",
    completedAt: "2026-01-01T00:00:00Z",
  });
  assert.equal(after.workflows["id:1"].status, "succeeded");
  assert.equal(after.workflows["id:1"].name, "CI");
});

test("success is monotonic: a later failure cannot undo it", () => {
  let record = applyWorkflowRun(repo(), {
    workflowKey: "id:1",
    conclusion: "success",
    completedAt: "2026-01-01T00:00:00Z",
  });
  record = applyWorkflowRun(record, {
    workflowKey: "id:1",
    conclusion: "failure",
    completedAt: "2026-02-01T00:00:00Z",
  });
  assert.equal(record.workflows["id:1"].status, "succeeded");
  assert.equal(record.workflows["id:1"].lastConclusion, "failure");
});

test("events are commutative, so replays and out-of-order delivery are safe", () => {
  const success = { workflowKey: "id:1", conclusion: "success", completedAt: "2026-02-01T00:00:00Z" };
  const failure = { workflowKey: "id:1", conclusion: "failure", completedAt: "2026-01-01T00:00:00Z" };

  const forward = applyWorkflowRun(applyWorkflowRun(repo(), failure), success);
  const reverse = applyWorkflowRun(applyWorkflowRun(repo(), success), failure);
  const replayed = applyWorkflowRun(forward, success);

  assert.equal(forward.workflows["id:1"].status, "succeeded");
  assert.equal(reverse.workflows["id:1"].status, "succeeded");
  assert.equal(replayed.workflows["id:1"].status, "succeeded");
});

test("a run with no matching conclusion leaves the status alone", () => {
  const after = applyWorkflowRun(repo(), { workflowKey: "id:1", conclusion: "cancelled" });
  assert.equal(after.workflows["id:1"].status, "idle");
});

test("the inventory replaces the workflow set but keeps earned successes", () => {
  let record = applyWorkflowRun(repo(), { workflowKey: "ci.yml", conclusion: "success" });
  record = applyWorkflowInventory(
    record,
    [
      { name: "CI", path: "ci.yml", state: "active", status: "idle", url: "https://x/ci" },
      { name: "Release", path: "release.yml", state: "active", status: "failing" },
    ],
    "2026-03-01T00:00:00Z",
  );

  assert.equal(record.workflows["ci.yml"].status, "succeeded");
  assert.equal(record.workflows["ci.yml"].url, "https://x/ci");
  assert.equal(record.workflows["release.yml"].status, "failing");
  assert.equal(record.workflowsBootstrappedAt, "2026-03-01T00:00:00Z");
});

test("the inventory drops workflows the repository no longer reports", () => {
  let record = applyWorkflowInventory(
    repo(),
    [{ name: "Old", path: "old.yml", status: "succeeded" }],
    "2026-01-01T00:00:00Z",
  );
  record = applyWorkflowInventory(
    record,
    [{ name: "CI", path: "ci.yml", status: "idle" }],
    "2026-02-01T00:00:00Z",
  );
  assert.deepEqual(Object.keys(record.workflows), ["ci.yml"]);
});

test("attributes clear on an explicit null but survive an omitted key", () => {
  const withTeam = applyRepoAttributes(repo(), { team: "Payments", repoSizeMB: 10 });
  assert.equal(applyRepoAttributes(withTeam, { team: null }).team, null);
  assert.equal(applyRepoAttributes(withTeam, {}).team, "Payments");
  assert.equal(applyRepoAttributes(withTeam, { team: "Data" }).team, "Data");
  assert.equal(applyRepoAttributes(withTeam, {}).repoSizeMB, 10);
});

// The record stays keyed by the name the repository was migrated under, so
// where it lives now is an attribute of it rather than a new record.
test("a repository that moved records where it went, and when it was noticed", () => {
  const moved = applyRepoAttributes(
    repo(),
    { repoId: "R_1", nameWithOwner: "org-b/platform-api" },
    "2026-03-01T00:00:00Z",
  );

  assert.equal(moved.org, "org-a", "the migration-time owner is untouched");
  assert.equal(moved.currentOrg, "org-b");
  assert.equal(moved.currentRepository, "platform-api");
  assert.equal(moved.renamedAt, "2026-03-01T00:00:00Z");

  // Seen in the same place again: the date it was first noticed stands.
  const again = applyRepoAttributes(
    moved,
    { repoId: "R_1", nameWithOwner: "org-b/platform-api" },
    "2026-06-01T00:00:00Z",
  );
  assert.equal(again.renamedAt, "2026-03-01T00:00:00Z");

  // Renamed back is not renamed at all.
  const back = applyRepoAttributes(
    again,
    { repoId: "R_1", nameWithOwner: "org-a/api" },
    "2026-07-01T00:00:00Z",
  );
  assert.equal(back.currentOrg, null);
  assert.equal(back.currentRepository, null);
  assert.equal(back.renamedAt, null);
});

// A name lookup follows a rename only until the old name is taken by a new
// repository, and then resolves to a stranger.
test("identity is the node id, not the name", () => {
  const known = { repoId: "R_ours" };

  assert.equal(isSameRepository(known, "R_ours"), true);
  assert.equal(isSameRepository(known, "R_theirs"), false);
  // Records written before ids were stored have nothing to compare against.
  assert.equal(isSameRepository({}, "R_theirs"), true);
  assert.equal(isSameRepository(known, null), true);
});

test("a repository is looked up where it lives now", () => {
  assert.deepEqual(repoLocation(null, "org-a", "api"), { owner: "org-a", name: "api" });
  assert.deepEqual(
    repoLocation({ currentOrg: "org-b", currentRepository: "platform-api" }, "org-a", "api"),
    { owner: "org-b", name: "platform-api" },
  );
});

test("deletion is recorded once and never overwritten", () => {
  const deleted = applyRepoDeleted(repo(), "2026-01-01T00:00:00Z");
  assert.equal(applyRepoDeleted(deleted, "2026-05-01T00:00:00Z").deletedAt, "2026-01-01T00:00:00Z");
});

test("a terminal migration keeps its facts but can gain a duration", () => {
  const prior = { id: "M1", state: "SUCCEEDED", createdAt: "2026-01-01T00:00:00Z", durationMinutes: null };
  const fresh = { id: "M1", state: "FAILED", createdAt: "2026-01-01T00:00:00Z", durationMinutes: 14 };
  const merged = applyMigration(prior, fresh);
  assert.equal(merged.state, "SUCCEEDED");
  assert.equal(merged.durationMinutes, 14);
});

test("an in-flight migration is refreshed", () => {
  const prior = { id: "M1", state: "QUEUED", createdAt: "2026-01-01T00:00:00Z" };
  const merged = applyMigration(prior, { id: "M1", state: "SUCCEEDED", createdAt: "2026-01-01T00:00:00Z" });
  assert.equal(merged.state, "SUCCEEDED");
});

test("workflow counts exclude reusable workflows", () => {
  const record = applyWorkflowInventory(
    repo(),
    [
      { name: "CI", path: "a.yml", status: "succeeded" },
      { name: "Shared", path: "b.yml", status: "idle", reusable: true },
      { name: "Nightly", path: "c.yml", status: "idle" },
    ],
    "2026-01-01T00:00:00Z",
  );
  assert.deepEqual(workflowCounts(record), { succeeded: 1, failing: 0, idle: 1, manual: 0, postOnboarding: 0 });
});

// The repository is back online when its LAST workflow goes green, so the date
// is the maximum of the first successes — not the minimum.
test("a repository is dated green by the last workflow to get there", () => {
  const record = applyWorkflowInventory(
    repo(),
    [
      { name: "CI", path: "a.yml", status: "succeeded", firstSuccessAt: "2026-01-02T00:00:00Z" },
      { name: "Release", path: "b.yml", status: "succeeded", firstSuccessAt: "2026-01-09T00:00:00Z" },
    ],
    "2026-01-01T00:00:00Z",
  );

  assert.equal(backOnlineAt(record), "2026-01-09T00:00:00Z");
});

test("a repository with anything still red or never run is not dated", () => {
  const failing = applyWorkflowInventory(
    repo(),
    [
      { name: "CI", path: "a.yml", status: "succeeded", firstSuccessAt: "2026-01-02T00:00:00Z" },
      { name: "Release", path: "b.yml", status: "failing" },
    ],
    "2026-01-01T00:00:00Z",
  );
  assert.equal(backOnlineAt(failing), null);

  const idle = applyWorkflowInventory(
    repo(),
    [
      { name: "CI", path: "a.yml", status: "succeeded", firstSuccessAt: "2026-01-02T00:00:00Z" },
      { name: "Nightly", path: "b.yml", status: "idle" },
    ],
    "2026-01-01T00:00:00Z",
  );
  assert.equal(backOnlineAt(idle), null);
});

// The same exclusions the counts use, or the date would answer a different
// question from the badge beside it.
test("dating ignores the workflows the counts ignore", () => {
  const record = applyWorkflowInventory(
    repo(),
    [
      { name: "CI", path: "a.yml", status: "succeeded", firstSuccessAt: "2026-01-02T00:00:00Z" },
      { name: "Shared", path: "b.yml", status: "idle", reusable: true },
      { name: "Deploy", path: "c.yml", status: "idle", manual: true },
    ],
    "2026-01-01T00:00:00Z",
  );

  assert.equal(backOnlineAt(record), "2026-01-02T00:00:00Z");
});

// A repository whose workflows all predate the dating cannot be placed on the
// curve; guessing a date would invent a recovery that was never observed.
test("a success with no date leaves the repository undated", () => {
  const record = applyWorkflowInventory(
    repo(),
    [{ name: "CI", path: "a.yml", status: "succeeded" }],
    "2026-01-01T00:00:00Z",
  );

  assert.equal(backOnlineAt(record), null);
});

test("a repository with nothing scored is not dated green", () => {
  const record = applyWorkflowInventory(
    repo(),
    [{ name: "Shared", path: "b.yml", status: "idle", reusable: true }],
    "2026-01-01T00:00:00Z",
  );

  assert.equal(backOnlineAt(record), null);
});

// Success is monotonic, so the first one is the one that counts — but events
// arrive out of order, and an older success has to win.
test("the first success is kept, whichever order the runs arrive in", () => {
  let record = applyWorkflowRun(repo(), {
    workflowKey: "ci.yml",
    workflowId: 1,
    name: "CI",
    conclusion: "success",
    completedAt: "2026-02-10T00:00:00Z",
  });
  assert.equal(record.workflows["ci.yml"].firstSuccessAt, "2026-02-10T00:00:00Z");

  record = applyWorkflowRun(record, {
    workflowKey: "ci.yml",
    workflowId: 1,
    name: "CI",
    conclusion: "success",
    completedAt: "2026-03-01T00:00:00Z",
  });
  assert.equal(record.workflows["ci.yml"].firstSuccessAt, "2026-02-10T00:00:00Z", "a later run does not move it");

  record = applyWorkflowRun(record, {
    workflowKey: "ci.yml",
    workflowId: 1,
    name: "CI",
    conclusion: "success",
    completedAt: "2026-01-05T00:00:00Z",
  });
  assert.equal(record.workflows["ci.yml"].firstSuccessAt, "2026-01-05T00:00:00Z", "a redelivered older run does");
});

test("a failing run does not date a workflow green", () => {
  const record = applyWorkflowRun(repo(), {
    workflowKey: "ci.yml",
    workflowId: 1,
    name: "CI",
    conclusion: "failure",
    completedAt: "2026-02-10T00:00:00Z",
  });

  assert.equal(record.workflows["ci.yml"].firstSuccessAt, null);
});

// A workflow that was already green before the action started dating cannot be
// dated from a run now — that run is not its first success, and recording it
// would report a months-old recovery as today's.
test("a later run never becomes the first success of an already-green workflow", () => {
  const green = applyWorkflowInventory(
    repo(),
    [{ name: "CI", path: "a.yml", status: "succeeded" }],
    "2026-01-01T00:00:00Z",
  );
  assert.equal(green.workflows["a.yml"].firstSuccessAt, null);

  const ran = applyWorkflowRun(green, {
    workflowKey: "a.yml",
    workflowId: 1,
    name: "CI",
    conclusion: "success",
    completedAt: "2026-09-01T00:00:00Z",
  });

  assert.equal(ran.workflows["a.yml"].firstSuccessAt, null, "left undated rather than misdated");
});

// The inventory reads the date from history, so it can only be older than what
// run events already saw; a re-inventory must not lose it either way.
test("re-inventorying keeps the earlier of the two dates", () => {
  const seen = applyWorkflowRun(repo(), {
    workflowKey: "a.yml",
    workflowId: 1,
    name: "CI",
    conclusion: "success",
    completedAt: "2026-02-10T00:00:00Z",
  });

  const older = applyWorkflowInventory(
    seen,
    [{ name: "CI", path: "a.yml", status: "succeeded", firstSuccessAt: "2026-01-04T00:00:00Z" }],
    "2026-03-01T00:00:00Z",
  );
  assert.equal(older.workflows["a.yml"].firstSuccessAt, "2026-01-04T00:00:00Z");

  const undated = applyWorkflowInventory(
    older,
    [{ name: "CI", path: "a.yml", status: "succeeded" }],
    "2026-04-01T00:00:00Z",
  );
  assert.equal(undated.workflows["a.yml"].firstSuccessAt, "2026-01-04T00:00:00Z", "an undated re-read keeps it");
});

test("a repository seen alive is not hidden by an older deletion event", () => {
  // Names get reused: a repo destroyed in January and re-migrated in March is
  // listed by the organization again, so the old event must not hide it.
  const alive = applyRepoAttributes(repo(), { team: "Payments" }, "2026-03-01T00:00:00Z");
  const after = applyRepoDeleted(alive, "2026-01-01T00:00:00Z");
  assert.equal(after.deletedAt, null);
});

test("a deletion after the last sighting is recorded", () => {
  const alive = applyRepoAttributes(repo(), { team: "Payments" }, "2026-01-01T00:00:00Z");
  const after = applyRepoDeleted(alive, "2026-03-01T00:00:00Z");
  assert.equal(after.deletedAt, "2026-03-01T00:00:00Z");
});

test("being listed again clears a recorded deletion", () => {
  const deleted = applyRepoDeleted(repo(), "2026-01-01T00:00:00Z");
  assert.equal(deleted.deletedAt, "2026-01-01T00:00:00Z");
  const revived = applyRepoAttributes(deleted, { team: null }, "2026-02-01T00:00:00Z");
  assert.equal(revived.deletedAt, null);
});

test("a run event updates the inventoried workflow instead of adding a duplicate", () => {
  // The inventory keys by path; run events identify the workflow by numeric id.
  let record = applyWorkflowInventory(
    repo(),
    [{ name: "CI", path: ".github/workflows/ci.yml", workflowId: 1798451, status: "idle" }],
    "2026-01-01T00:00:00Z",
  );
  record = applyWorkflowRun(record, {
    workflowKey: "id:1798451",
    workflowId: 1798451,
    name: "CI",
    conclusion: "success",
  });

  assert.deepEqual(Object.keys(record.workflows), [".github/workflows/ci.yml"]);
  assert.equal(record.workflows[".github/workflows/ci.yml"].status, "succeeded");
  assert.deepEqual(workflowCounts(record), { succeeded: 1, failing: 0, idle: 0, manual: 0, postOnboarding: 0 });
});

test("a run event matches a legacy path-keyed workflow by name", () => {
  // Data imported before ids were recorded has no workflowId to match on.
  const legacy = {
    ...repo(),
    workflows: { "ci.yml": { name: "CI", path: "ci.yml", status: "idle" } },
  };
  const after = applyWorkflowRun(legacy, {
    workflowKey: "id:99",
    workflowId: 99,
    name: "CI",
    conclusion: "success",
  });

  assert.deepEqual(Object.keys(after.workflows), ["ci.yml"]);
  assert.equal(after.workflows["ci.yml"].status, "succeeded");
  assert.equal(after.workflows["ci.yml"].workflowId, 99);
});

test("a run for an unknown workflow still records it", () => {
  const after = applyWorkflowRun(repo(), {
    workflowKey: "id:7",
    workflowId: 7,
    name: "New",
    conclusion: "failure",
  });
  assert.deepEqual(Object.keys(after.workflows), ["id:7"]);
  assert.equal(after.workflows["id:7"].status, "failing");
});

test("dedupeWorkflows collapses a workflow stored under two keys", () => {
  const doubled = {
    ...repo(),
    workflows: {
      "ci.yml": { name: "CI", path: "ci.yml", status: "idle", url: "https://x/ci", reusable: false },
      "id:99": { name: "CI", status: "succeeded", workflowId: 99, lastConclusion: "success" },
    },
  };
  const merged = dedupeWorkflows(doubled);

  assert.deepEqual(Object.keys(merged.workflows), ["ci.yml"]);
  assert.equal(merged.workflows["ci.yml"].status, "succeeded"); // success survives
  assert.equal(merged.workflows["ci.yml"].url, "https://x/ci"); // inventory detail survives
  assert.equal(merged.workflows["ci.yml"].workflowId, 99);
  assert.deepEqual(workflowCounts(merged), { succeeded: 1, failing: 0, idle: 0, manual: 0, postOnboarding: 0 });
});

test("dedupeWorkflows leaves distinct workflows alone", () => {
  const record = applyWorkflowInventory(
    repo(),
    [
      { name: "CI", path: "a.yml", status: "succeeded" },
      { name: "Release", path: "b.yml", status: "failing" },
    ],
    "2026-01-01T00:00:00Z",
  );
  assert.equal(Object.keys(dedupeWorkflows(record).workflows).length, 2);
});

test("a re-inventory adds workflows created after the migration", () => {
  // A workflow added later that never runs emits no audit event, so only a
  // re-list can discover it.
  let record = applyWorkflowInventory(
    repo(),
    [{ name: "CI", path: "ci.yml", workflowId: 1, status: "succeeded" }],
    "2026-01-01T00:00:00Z",
  );
  record = applyWorkflowInventory(
    record,
    [
      { name: "CI", path: "ci.yml", workflowId: 1, status: "succeeded" },
      { name: "Nightly", path: "nightly.yml", workflowId: 2, status: "idle" },
    ],
    "2026-01-08T00:00:00Z",
  );

  assert.deepEqual(Object.keys(record.workflows), ["ci.yml", "nightly.yml"]);
  assert.deepEqual(workflowCounts(record), { succeeded: 1, failing: 0, idle: 1, manual: 0, postOnboarding: 0 });
  assert.equal(record.workflowsBootstrappedAt, "2026-01-08T00:00:00Z");
});

test("a re-inventory keeps a success even if the API no longer reports the run", () => {
  let record = applyWorkflowInventory(
    repo(),
    [{ name: "CI", path: "ci.yml", workflowId: 1, status: "succeeded" }],
    "2026-01-01T00:00:00Z",
  );
  // Runs have aged past the retention window, so the re-list classifies idle.
  record = applyWorkflowInventory(
    record,
    [{ name: "CI", path: "ci.yml", workflowId: 1, status: "idle" }],
    "2026-06-01T00:00:00Z",
  );
  assert.equal(record.workflows["ci.yml"].status, "succeeded");
});

test("workflows present at the first inventory carry no discovery date", () => {
  // They predate our observation, so they always count as migration scope.
  const record = applyWorkflowInventory(
    repo(),
    [{ name: "CI", path: "ci.yml", workflowId: 1, status: "succeeded" }],
    "2026-01-01T00:00:00Z",
  );
  assert.equal(record.workflows["ci.yml"].firstSeenAt, null);
});

test("a workflow found by a later inventory is dated when it was discovered", () => {
  let record = applyWorkflowInventory(
    repo(),
    [{ name: "CI", path: "ci.yml", workflowId: 1, status: "succeeded" }],
    "2026-01-01T00:00:00Z",
  );
  record = applyWorkflowInventory(
    record,
    [
      { name: "CI", path: "ci.yml", workflowId: 1, status: "succeeded" },
      { name: "Nightly", path: "nightly.yml", workflowId: 2, status: "idle" },
    ],
    "2026-04-01T00:00:00Z",
  );

  assert.equal(record.workflows["ci.yml"].firstSeenAt, null);
  assert.equal(record.workflows["nightly.yml"].firstSeenAt, "2026-04-01T00:00:00Z");
});

test("a run for a workflow discovered after bootstrap is dated by the run", () => {
  let record = applyWorkflowInventory(
    repo(),
    [{ name: "CI", path: "ci.yml", workflowId: 1, status: "idle" }],
    "2026-01-01T00:00:00Z",
  );
  record = applyWorkflowRun(record, {
    workflowKey: "id:2",
    workflowId: 2,
    name: "Nightly",
    conclusion: "success",
    completedAt: "2026-05-01T00:00:00Z",
  });
  assert.equal(record.workflows["id:2"].firstSeenAt, "2026-05-01T00:00:00Z");
});

test("workflows added after the window are counted separately, not as idle", () => {
  let record = applyWorkflowInventory(
    repo(),
    [{ name: "CI", path: "ci.yml", workflowId: 1, status: "succeeded" }],
    "2026-01-01T00:00:00Z",
  );
  record = applyWorkflowInventory(
    record,
    [
      { name: "CI", path: "ci.yml", workflowId: 1, status: "succeeded" },
      { name: "Nightly", path: "nightly.yml", workflowId: 2, status: "idle" },
    ],
    "2026-06-01T00:00:00Z",
  );

  const closesAt = onboardingClosesAt("2026-01-01T00:00:00Z", onboardingWindowMs(60));
  assert.deepEqual(workflowCounts(record, closesAt), {
    succeeded: 1,
    failing: 0,
    idle: 0,
    manual: 0,
    postOnboarding: 1,
  });
});

test("manual-only workflows are listed but never scored", () => {
  const record = applyWorkflowInventory(
    repo(),
    [
      { name: "CI", path: "ci.yml", status: "succeeded" },
      { name: "Deploy", path: "deploy.yml", status: "idle", manual: true },
    ],
    "2026-01-01T00:00:00Z",
  );
  assert.deepEqual(workflowCounts(record), {
    succeeded: 1,
    failing: 0,
    idle: 0,
    manual: 1,
    postOnboarding: 0,
  });
});

test("a manual workflow that has been dispatched is scored on that run", () => {
  // Unmeasurable means never run. A real run is a real measurement.
  let record = applyWorkflowInventory(
    repo(),
    [{ name: "Deploy", path: "deploy.yml", workflowId: 5, status: "idle", manual: true }],
    "2026-01-01T00:00:00Z",
  );
  assert.equal(workflowCounts(record).manual, 1);

  record = applyWorkflowRun(record, {
    workflowKey: "id:5",
    workflowId: 5,
    name: "Deploy",
    conclusion: "success",
    completedAt: "2026-01-10T00:00:00Z",
  });

  assert.equal(record.workflows["deploy.yml"].manual, true);
  assert.deepEqual(workflowCounts(record), {
    succeeded: 1,
    failing: 0,
    idle: 0,
    manual: 0,
    postOnboarding: 0,
  });
});

test("a re-inventory preserves the stored classification", () => {
  // Status is maintained by the audit feed, so a re-list must not reset it.
  let record = applyWorkflowInventory(
    repo(),
    [{ name: "CI", path: "ci.yml", status: "failing", classifiedAt: "2026-01-01T00:00:00Z" }],
    "2026-01-01T00:00:00Z",
  );
  record = applyWorkflowInventory(
    record,
    [{ name: "CI", path: "ci.yml", status: "failing", classifiedAt: "2026-01-01T00:00:00Z" }],
    "2026-01-08T00:00:00Z",
  );
  assert.equal(record.workflows["ci.yml"].classifiedAt, "2026-01-01T00:00:00Z");
});

test("a disabled window keeps every workflow in migration scope", () => {
  const late = { firstSeenAt: "2030-01-01T00:00:00Z", status: "idle" };
  assert.equal(inOnboarding(late, onboardingClosesAt("2026-01-01T00:00:00Z", onboardingWindowMs(0))), true);
});
