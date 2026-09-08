// Inventory of a repository's Actions workflows. This exists to *discover*
// workflows — status is maintained by the audit feed, which carries every
// completed run. So a workflow's run history is read exactly once, when it is
// first seen, in at most two calls; after that a re-list costs one call for the
// whole repository no matter how many workflows it holds.
//
// Succeeded — >=1 successful run ever (rerun-to-green counts).
// Failing   — ran, never succeeded (failure/timed_out/startup_failure).
// Idle      — 0 runs, or only cancelled/skipped/neutral/etc.
//
// Only an idle workflow is ambiguous: it may be broken, or nothing may run it.
// So the trigger block is read only for idle workflows. A workflow_call-only
// workflow is reusable (hidden); one that only ever runs when a human
// dispatches it is manual (listed, but idleness proves nothing about it).

const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);

// Triggers that fire on their own, so an idle workflow with one of these is
// genuinely idle rather than merely un-dispatched.
const SELF_RUNNING = new Set([
  "push",
  "pull_request",
  "pull_request_target",
  "schedule",
  "release",
  "issues",
  "issue_comment",
  "create",
  "delete",
  "fork",
  "gollum",
  "label",
  "milestone",
  "page_build",
  "project",
  "public",
  "pull_request_review",
  "pull_request_review_comment",
  "registry_package",
  "repository_dispatch",
  "status",
  "watch",
  "check_run",
  "check_suite",
  "deployment",
  "deployment_status",
  "discussion",
  "discussion_comment",
  "merge_group",
  "workflow_run",
  "branch_protection_rule",
]);

// Returns an array of workflow records, or null if the repository is gone.
// `known` carries what is already stored, keyed by path. A workflow that has
// already been classified is carried through untouched, so re-listing a
// settled repository costs the single list call.
async function fetchWorkflowInventory(octokit, org, repo, budget, known = {}) {
  if (!budget.take("rest")) return null;

  let workflows;
  try {
    const res = await octokit.rest.actions.listRepoWorkflows({ owner: org, repo, per_page: 100 });
    workflows = res.data.workflows.filter((w) => w.state !== "deleted");
  } catch (err) {
    if (err.status === 404) return null; // repo no longer exists
    throw err;
  }

  const rows = [];
  for (const workflow of workflows) {
    const before = known[workflow.path];

    if (before?.classifiedAt) {
      rows.push({
        name: workflow.name,
        path: workflow.path,
        workflowId: workflow.id,
        state: workflow.state,
        status: before.status,
        reusable: before.reusable ?? false,
        manual: before.manual ?? false,
        classifiedAt: before.classifiedAt,
        url: workflow.html_url ?? null,
      });
      continue;
    }

    const status = await classifyWorkflow(octokit, org, repo, workflow.id, budget);
    const { reusable, manual } =
      status === "idle"
        ? await fetchTriggerClass(octokit, org, repo, workflow.path, budget)
        : { reusable: false, manual: false };
    // A classification cut short by the budget is a guess, and storing it with
    // classifiedAt would make the guess permanent. Drop the whole repository
    // instead; it is never-inventoried again and goes first next run.
    if (budget.exhausted.has("rest")) return null;

    rows.push({
      name: workflow.name,
      path: workflow.path,
      workflowId: workflow.id,
      state: workflow.state,
      status,
      reusable,
      manual,
      classifiedAt: new Date().toISOString(),
      url: workflow.html_url ?? null,
    });
  }

  return rows;
}

// A success anywhere in the history settles it, and that is one call. Only when
// there is none do the failing conclusions need telling apart from cancelled and
// skipped ones, and one page of recent completed runs answers that; a workflow
// with more than a hundred completed runs and not one success is failing in any
// reading that matters.
async function classifyWorkflow(octokit, org, repo, workflowId, budget) {
  if (await hasRuns(octokit, org, repo, workflowId, "success", budget)) return "succeeded";

  if (!budget.take("rest")) return "idle";
  const res = await octokit.rest.actions.listWorkflowRuns({
    owner: org,
    repo,
    workflow_id: workflowId,
    status: "completed",
    per_page: 100,
  });
  const runs = res.data.workflow_runs ?? [];
  if (runs.some((run) => FAILING_CONCLUSIONS.has(run.conclusion))) return "failing";
  if (res.data.total_count > runs.length) return "failing";
  return "idle";
}

// Reads only total_count (per_page=1); never pages the runs.
async function hasRuns(octokit, org, repo, workflowId, status, budget) {
  if (!budget.take("rest")) return false;
  const res = await octokit.rest.actions.listWorkflowRuns({
    owner: org,
    repo,
    workflow_id: workflowId,
    status,
    per_page: 1,
  });
  return res.data.total_count > 0;
}

async function fetchTriggerClass(octokit, org, repo, path, budget) {
  const unknown = { reusable: false, manual: false };
  if (!budget.take("rest")) return unknown;
  try {
    const res = await octokit.rest.repos.getContent({ owner: org, repo, path });
    const content = Buffer.from(res.data.content, "base64").toString("utf8");
    return triggerClass(content);
  } catch {
    return unknown; // if we cannot read it, treat the workflow as ordinary
  }
}

// Pure: classifies a workflow by its `on:` block.
//   reusable — workflow_call and nothing else; hidden from the dashboard.
//   manual   — never fires on its own, only on workflow_dispatch (optionally
//              also callable). Listed, but idleness proves nothing about it.
function triggerClass(yamlText) {
  const triggers = extractTriggers(yamlText);
  if (triggers.length === 0) return { reusable: false, manual: false };
  if (triggers.some((t) => SELF_RUNNING.has(t))) return { reusable: false, manual: false };
  if (triggers.includes("workflow_dispatch")) return { reusable: false, manual: true };
  return { reusable: triggers.includes("workflow_call"), manual: false };
}

// Pure: true when the workflow's `on:` block contains workflow_call and no
// self-runnable trigger (push, pull_request, schedule, workflow_dispatch, ...).
function onlyWorkflowCall(yamlText) {
  return triggerClass(yamlText).reusable;
}

// Minimal, dependency-free extraction of the top-level `on:` trigger names.
function extractTriggers(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const triggers = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const inline = /^on:\s*(.+)$/.exec(line);
    if (inline) {
      // on: push | on: [push, workflow_call] | on: { push: {...} }
      return parseInline(inline[1]);
    }
    if (/^on:\s*$/.test(line)) {
      // Block form: collect only the direct child keys of `on:` (the shallowest
      // indentation level), ignoring nested keys like `branches:` or `inputs:`.
      let baseIndent = null;
      for (let j = i + 1; j < lines.length; j += 1) {
        const child = lines[j];
        if (child.trim() === "") continue;
        if (/^\S/.test(child)) break; // back to top level
        const indent = child.length - child.trimStart().length;
        if (baseIndent === null) baseIndent = indent;
        if (indent !== baseIndent) continue; // nested under a trigger — skip
        const key = /^\s+([A-Za-z_]+):/.exec(child);
        const item = /^\s+-\s*([A-Za-z_]+)/.exec(child);
        if (key) triggers.push(key[1]);
        else if (item) triggers.push(item[1]);
      }
      return triggers;
    }
  }
  return triggers;
}

function parseInline(rest) {
  const trimmed = rest.trim().replace(/^\[|\]$/g, "").replace(/[{}]/g, "");
  return trimmed
    .split(",")
    .map((s) => s.split(":")[0].trim())
    .filter(Boolean);
}

export { fetchWorkflowInventory, onlyWorkflowCall, triggerClass };
