import { test } from "node:test";
import assert from "node:assert/strict";
import { onlyWorkflowCall, triggerClass, fetchWorkflowInventory } from "../src/workflows.js";
import { Budget } from "../src/budget.js";
import { buildQuery } from "../src/repos.js";

test("drops a workflow_call-only reusable workflow (inline)", () => {
  assert.equal(onlyWorkflowCall("on: workflow_call\njobs: {}\n"), true);
});

test("drops a workflow_call-only reusable workflow (block)", () => {
  const yaml = ["on:", "  workflow_call:", "    inputs: {}", "jobs: {}"].join("\n");
  assert.equal(onlyWorkflowCall(yaml), true);
});

test("keeps a self-runnable workflow", () => {
  assert.equal(onlyWorkflowCall("on: push\njobs: {}\n"), false);
});

test("keeps a mixed-trigger workflow", () => {
  assert.equal(onlyWorkflowCall("on: [push, workflow_call]\njobs: {}\n"), false);
});

test("keeps a block workflow with a self-runnable trigger", () => {
  const yaml = ["on:", "  push:", "    branches: [main]", "  workflow_call:", "jobs: {}"].join("\n");
  assert.equal(onlyWorkflowCall(yaml), false);
});

test("a workflow_dispatch-only workflow is manual, not reusable", () => {
  assert.deepEqual(triggerClass("on: workflow_dispatch\njobs: {}\n"), {
    reusable: false,
    manual: true,
  });
});

test("a dispatchable reusable workflow is manual", () => {
  // Nothing fires it on its own, so idleness proves nothing either way.
  const yaml = ["on:", "  workflow_dispatch:", "  workflow_call:", "jobs: {}"].join("\n");
  assert.deepEqual(triggerClass(yaml), { reusable: false, manual: true });
});

test("a dispatchable workflow that also runs on push is ordinary", () => {
  const yaml = ["on:", "  workflow_dispatch:", "  push:", "jobs: {}"].join("\n");
  assert.deepEqual(triggerClass(yaml), { reusable: false, manual: false });
});

test("an unreadable or trigger-less workflow is treated as ordinary", () => {
  assert.deepEqual(triggerClass("jobs: {}\n"), { reusable: false, manual: false });
});

test("the batched attribute query passes repo names as variables", () => {
  // Interpolating names would let a repository name alter the query.
  const query = buildQuery(2);
  assert.match(query, /\$owner: String!, \$n0: String!, \$n1: String!/);
  assert.match(query, /r0: repository\(owner: \$owner, name: \$n0\)/);
  assert.match(query, /r1: repository\(owner: \$owner, name: \$n1\)/);
  assert.match(query, /fragment RepoFields on Repository/);
});

// Classification is what a never-seen workflow costs on first inventory, so the
// call count is the thing under test.
function runsOctokit(byStatus) {
  const calls = [];
  return {
    calls,
    rest: {
      actions: {
        listRepoWorkflows: async () => ({
          data: { workflows: [{ id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" }] },
        }),
        listWorkflowRuns: async ({ status }) => {
          calls.push(status);
          const runs = byStatus[status] ?? [];
          const total = status === "completed" ? (byStatus.total ?? runs.length) : runs.length;
          return { data: { total_count: total, workflow_runs: runs } };
        },
      },
      repos: { getContent: async () => ({ data: { content: Buffer.from("on: push").toString("base64") } }) },
    },
  };
}

test("a workflow that ever succeeded is settled in one call", async () => {
  const octokit = runsOctokit({ success: [{ conclusion: "success" }] });
  const [wf] = await fetchWorkflowInventory(octokit, "o", "r", new Budget({}));

  assert.equal(wf.status, "succeeded");
  assert.deepEqual(octokit.calls, ["success"]);
});

test("a failing workflow is settled in two calls, whichever way it failed", async () => {
  for (const conclusion of ["failure", "timed_out", "startup_failure"]) {
    const octokit = runsOctokit({ completed: [{ conclusion: "cancelled" }, { conclusion }] });
    const [wf] = await fetchWorkflowInventory(octokit, "o", "r", new Budget({}));

    assert.equal(wf.status, "failing", conclusion);
    assert.deepEqual(octokit.calls, ["success", "completed"]);
  }
});

test("only cancelled or skipped runs leave a workflow idle", async () => {
  const octokit = runsOctokit({ completed: [{ conclusion: "cancelled" }, { conclusion: "skipped" }] });
  const [wf] = await fetchWorkflowInventory(octokit, "o", "r", new Budget({}));

  assert.equal(wf.status, "idle");
});

test("a workflow with no runs is idle", async () => {
  const [wf] = await fetchWorkflowInventory(runsOctokit({}), "o", "r", new Budget({}));
  assert.equal(wf.status, "idle");
});

// The audit feed no longer replays history, so a status stored at inventory is
// final until the workflow runs again. One the budget cut short must not be
// stored as if it were classified.
test("a repository whose classification ran out of budget is not stored", async () => {
  const octokit = runsOctokit({ completed: [{ conclusion: "failure" }] });
  // One call for the list, one for the success probe, none left for the rest.
  const rows = await fetchWorkflowInventory(octokit, "o", "r", new Budget({ rest: 2 }));
  assert.equal(rows, null);
});

// More than a page of completed runs and not one success is failing in any
// reading that matters, and looking further would cost a call per page.
test("a long history without a success reads as failing", async () => {
  const cancelled = Array.from({ length: 100 }, () => ({ conclusion: "cancelled" }));
  const octokit = runsOctokit({ completed: cancelled, total: 250 });
  const [wf] = await fetchWorkflowInventory(octokit, "o", "r", new Budget({}));

  assert.equal(wf.status, "failing");
});
