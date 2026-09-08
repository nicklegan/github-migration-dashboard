import { test } from "node:test";
import assert from "node:assert/strict";
import { workflowGroups, workflowCount, worstStatus, statusFromCounts } from "../src/groupWorkflows.js";

const repo = (id, counts) => ({
  id,
  d: "0a",
  organization: id.split("/")[0],
  repository: id.split("/")[1],
  createdAt: "2026-01-01T00:00:00Z",
  workflows: counts,
});

test("worstStatus lets one failure decide the repository", () => {
  assert.equal(worstStatus(["succeeded", "failing", "idle"]), "failing");
  assert.equal(worstStatus(["failing"]), "failing");
});

// The table has one row per repository, so its length understates the estate;
// the badge and header count the workflows those rows fold.
test("workflowCount sums the workflows behind the repository rows", () => {
  const groups = workflowGroups([
    repo("acme/api", { succeeded: 3, failing: 1, idle: 0, manual: 1 }),
    repo("acme/web", { succeeded: 0, failing: 0, idle: 2 }),
    repo("acme/empty", { succeeded: 0, failing: 0, idle: 0 }),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(workflowCount(groups), 7);
});

test("a workflow that never ran holds the repository at idle", () => {
  assert.equal(worstStatus(["succeeded", "succeeded", "idle"]), "idle");
});

test("only an all-green repository reads as succeeded", () => {
  assert.equal(worstStatus(["succeeded", "succeeded"]), "succeeded");
});

test("statusFromCounts applies the same rule to the folded counts", () => {
  assert.equal(statusFromCounts({ succeeded: 2, failing: 1, idle: 3 }), "failing");
  assert.equal(statusFromCounts({ succeeded: 2, failing: 0, idle: 1 }), "idle");
  assert.equal(statusFromCounts({ succeeded: 2, failing: 0, idle: 0 }), "succeeded");
  assert.equal(statusFromCounts({ succeeded: 0, failing: 0, idle: 0 }), null);
  assert.equal(statusFromCounts(null), null);
});

test("workflowGroups folds each repository into one row", () => {
  const groups = workflowGroups([
    repo("org-a/api", { succeeded: 1, failing: 0, idle: 1 }),
    repo("org-b/web", { succeeded: 0, failing: 1, idle: 0 }),
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].status, "idle");
  assert.equal(groups[1].count, 1);
  assert.equal(groups[1].status, "failing");
});

test("a group carries the detail bucket so its workflows can be fetched", () => {
  const [group] = workflowGroups([repo("org-a/api", { succeeded: 1, failing: 0, idle: 0 })]);
  assert.equal(group.bucket, "0a");
  assert.equal(group.key, "org-a/api");
});

// The workflow table shows where the code came from and who owns it, which is a
// property of the repository's migration rather than of any single workflow.
test("a group carries its repository's source and owning team", () => {
  const [group] = workflowGroups([
    {
      ...repo("org-a/api", { succeeded: 1, failing: 0, idle: 0 }),
      sourceType: "GitLab Source",
      sourceUrl: "https://gitlab.dev/gl/api",
      team: "Payments",
    },
  ]);

  assert.equal(group.sourceType, "GitLab Source");
  assert.equal(group.sourceUrl, "https://gitlab.dev/gl/api");
  assert.equal(group.team, "Payments");
});

test("a repository with no source or team recorded still groups", () => {
  const [group] = workflowGroups([repo("org-a/api", { succeeded: 1, failing: 0, idle: 0 })]);
  assert.equal(group.sourceType, null);
  assert.equal(group.sourceUrl, null);
  assert.equal(group.team, null);
});

// The lone workflow travels on the row, so the table can render it inline
// rather than behind a toggle that opens a single line.
test("a group carries a lone workflow, and nothing when there are several", () => {
  const lone = { id: "org-a/api:ci.yml", name: "CI", status: "succeeded", state: "active" };
  const [single] = workflowGroups([
    { ...repo("org-a/api", { succeeded: 1, failing: 0, idle: 0 }), workflow: lone },
  ]);
  const [folded] = workflowGroups([repo("org-b/web", { succeeded: 1, failing: 0, idle: 1 })]);

  assert.deepEqual(single.workflow, lone);
  assert.equal(folded.workflow, null);
});

test("repositories without workflows are left out", () => {
  const groups = workflowGroups([
    repo("org-a/empty", { succeeded: 0, failing: 0, idle: 0 }),
    repo("org-a/none", null),
    repo("org-a/api", { succeeded: 1, failing: 0, idle: 0 }),
  ]);
  assert.deepEqual(
    groups.map((g) => g.key),
    ["org-a/api"],
  );
});

// A repository whose workflows all arrived after the window was dropped from the
// table entirely, though the detail bucket listed them.
test("a repository whose workflows all arrived late is still listed", () => {
  const [group] = workflowGroups([
    repo("org-a/api", { succeeded: 0, failing: 0, idle: 0, manual: 0, postOnboarding: 2 }),
  ]);

  assert.equal(group.count, 2);
  // Those counts record that the workflows exist, not how they ran, so the
  // repository is listed without being scored.
  assert.equal(group.status, "post-onboarding");
});

test("workflows added late are counted alongside the scored ones", () => {
  const [group] = workflowGroups([
    repo("org-a/api", { succeeded: 1, failing: 0, idle: 0, manual: 1, postOnboarding: 3 }),
  ]);

  assert.equal(group.count, 5);
  assert.equal(group.status, "succeeded", "a late arrival does not change the rollup");
});
