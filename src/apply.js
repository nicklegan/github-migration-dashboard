// Pure reducers over the repository record. No I/O, so the correctness rules
// unit-test without touching the network.
//
// Invariants:
//   - a workflow that has ever succeeded never goes back (that success is what
//     proves the workflow migrated, and Actions run retention will eventually
//     age the run out of the API)
//   - events are commutative: replays and out-of-order delivery are harmless
//   - a value is only cleared by an explicit observation, never by absence

import { TERMINAL_STATES, isTerminal } from "./states.js";

function emptyRepo(org, repository) {
  return {
    org,
    repository,
    team: null,
    repoSizeMB: null,
    deletedAt: null,
    observedAliveAt: null,
    attributesFetchedAt: null,
    workflows: {},
    workflowsBootstrappedAt: null,
    updatedAt: null,
  };
}

const CONCLUSION_STATUS = {
  success: "succeeded",
  failure: "failing",
  timed_out: "failing",
  startup_failure: "failing",
};

// A completed workflow run. `succeeded` is monotonic; anything else only
// downgrades a workflow that has not already proven itself.
//
// Run events identify a workflow by numeric id while the inventory keys it by
// path, so an existing entry is matched on id first and name second. Without
// that, a workflow would be counted once per key.
function applyWorkflowRun(repo, event) {
  const existing = findWorkflow(repo.workflows, event);
  const key = existing?.key ?? event.workflowKey;
  if (!key) return repo;

  const before =
    existing?.workflow ?? repo.workflows?.[key] ?? { name: event.name ?? key, status: "idle" };
  const observed = CONCLUSION_STATUS[event.conclusion];
  const status =
    before.status === "succeeded" || observed === "succeeded"
      ? "succeeded"
      : (observed ?? before.status);

  const discovered = !existing && !repo.workflows?.[key];
  const workflow = {
    ...before,
    name: before.name ?? event.name ?? key,
    workflowId: event.workflowId ?? before.workflowId ?? null,
    status,
    lastConclusion: event.conclusion ?? before.lastConclusion ?? null,
    lastRunAt: newerOf(before.lastRunAt, event.completedAt),
    firstSeenAt:
      before.firstSeenAt ??
      (discovered && repo.workflowsBootstrappedAt ? (event.completedAt ?? null) : null),
  };

  return { ...repo, workflows: { ...repo.workflows, [key]: workflow } };
}

function findWorkflow(workflows, event) {
  const entries = Object.entries(workflows ?? {});
  const byId =
    event.workflowId != null
      ? entries.find(([, w]) => w.workflowId === event.workflowId)
      : undefined;
  const match = byId ?? (event.name ? entries.find(([, w]) => w.name === event.name) : undefined);
  return match ? { key: match[0], workflow: match[1] } : null;
}

// The workflow set as the repository currently reports it. Removed workflows
// disappear; surviving ones keep a success they already earned.
//
// `firstSeenAt` records when a workflow was discovered, which is what places it
// inside or outside the onboarding window. Workflows present at the first
// inventory have no discovery date — they cannot be dated, and predate our
// observation, so they always count as migration scope.
function applyWorkflowInventory(repo, workflows, observedAt) {
  const bootstrap = !repo.workflowsBootstrappedAt;
  const next = {};
  for (const workflow of workflows) {
    const key = workflow.path || workflow.name;
    const before = repo.workflows[key] ?? findWorkflow(repo.workflows, workflow)?.workflow;
    next[key] = {
      ...before,
      name: workflow.name,
      path: workflow.path ?? null,
      workflowId: workflow.workflowId ?? before?.workflowId ?? null,
      state: workflow.state ?? null,
      url: workflow.url ?? before?.url ?? null,
      reusable: workflow.reusable ?? before?.reusable ?? false,
      manual: workflow.manual ?? before?.manual ?? false,
      classifiedAt: workflow.classifiedAt ?? before?.classifiedAt ?? null,
      status: before?.status === "succeeded" ? "succeeded" : (workflow.status ?? before?.status ?? "idle"),
      lastConclusion: before?.lastConclusion ?? null,
      lastRunAt: before?.lastRunAt ?? null,
      firstSeenAt: before?.firstSeenAt ?? (before || bootstrap ? null : observedAt),
    };
  }
  return { ...repo, workflows: next, workflowsBootstrappedAt: observedAt };
}

// Organization-reported attributes. Passing a key with a null value clears it;
// omitting the key leaves the stored value alone. Being listed at all is proof
// the repository exists, which clears an earlier deletion — names get reused.
function applyRepoAttributes(repo, attributes, observedAt) {
  const next = { ...repo };
  if ("team" in attributes) next.team = attributes.team ?? null;
  if ("repoSizeMB" in attributes) next.repoSizeMB = attributes.repoSizeMB ?? null;
  if (observedAt) {
    next.observedAliveAt = observedAt;
    next.attributesFetchedAt = observedAt;
    next.deletedAt = null;
  }
  return next;
}

// Whether a repository's team and size need re-reading. Onboarding repositories
// are checked often because that is when ownership is first assigned; settled
// ones fall back to a slower cadence, since a team can still change long after
// the migration. A settled TTL of Infinity freezes them at window close.
function isAttributeRefreshDue(record, { now, closesAt, onboardingTtlMs, settledTtlMs }) {
  if (record?.deletedAt) return false;
  const fetchedAt = Date.parse(record?.attributesFetchedAt ?? 0) || 0;
  if (!fetchedAt) return true;
  const ttl = now < closesAt ? onboardingTtlMs : settledTtlMs;
  return now - fetchedAt >= ttl;
}

// Only records a deletion the repository has not been seen alive since.
function applyRepoDeleted(repo, deletedAt) {
  const aliveAt = Date.parse(repo.observedAliveAt ?? 0) || 0;
  if (aliveAt >= (Date.parse(deletedAt) || 0)) return repo;
  return { ...repo, deletedAt: repo.deletedAt ?? deletedAt };
}

// Collapses workflows stored under two keys, which happens to data written
// before run events were matched to the inventory. The path-keyed entry wins
// because it carries the URL and reusable verdict; any success is kept.
function dedupeWorkflows(repo) {
  const byName = new Map();
  for (const [key, workflow] of Object.entries(repo.workflows ?? {})) {
    const name = workflow.name ?? key;
    const seen = byName.get(name);
    if (!seen) {
      byName.set(name, { key, workflow });
      continue;
    }
    const preferred = workflow.path ? { key, workflow } : seen;
    const other = preferred === seen ? workflow : seen.workflow;
    byName.set(name, {
      key: preferred.key,
      workflow: {
        ...other,
        ...preferred.workflow,
        status:
          preferred.workflow.status === "succeeded" || other.status === "succeeded"
            ? "succeeded"
            : preferred.workflow.status,
        workflowId: preferred.workflow.workflowId ?? other.workflowId ?? null,
        url: preferred.workflow.url ?? other.url ?? null,
        manual: preferred.workflow.manual ?? other.manual ?? false,
      },
    });
  }

  const workflows = {};
  for (const { key, workflow } of byName.values()) workflows[key] = workflow;
  return { ...repo, workflows };
}

// Migration facts freeze once the migration reaches a terminal state.
function applyMigration(prior, fresh) {
  if (!prior) return fresh;
  if (!isTerminal(prior.state)) return { ...prior, ...fresh };
  // Terminal: keep the frozen facts, but let a later-derived duration land.
  const durationMinutes = prior.durationMinutes ?? fresh.durationMinutes ?? null;
  const from = prior.durationMinutes != null ? prior : fresh;
  return {
    ...prior,
    durationMinutes,
    durationSource: durationMinutes != null ? (from.durationSource ?? null) : null,
    gitMinutes: durationMinutes != null ? (from.gitMinutes ?? null) : null,
  };
}

function newerOf(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function onboardingWindowMs(days) {
  return days > 0 ? days * DAY_MS : Infinity;
}

function onboardingClosesAt(migratedAt, windowMs) {
  const migrated = Date.parse(migratedAt ?? 0) || 0;
  if (!migrated || windowMs === Infinity) return Infinity;
  return migrated + windowMs;
}

// A workflow belongs to the migration if it existed before the onboarding
// window closed. Anything authored later is ordinary day-to-day work that
// happens to live in a migrated repository, and must not move migration
// metrics — otherwise they never converge.
function inOnboarding(workflow, closesAt) {
  if (!workflow.firstSeenAt) return true;
  return (Date.parse(workflow.firstSeenAt) || 0) <= closesAt;
}

// Rolls the workflow map up to the counts the dashboard charts on. Workflows
// added after the window are counted separately rather than dropped, and so are
// manual-only ones that have never run — nothing triggers those, so idleness
// says nothing about them. One that has been dispatched is scored normally,
// because a real run is a real measurement.
function workflowCounts(repo, closesAt = Infinity) {
  const counts = { succeeded: 0, failing: 0, idle: 0, manual: 0, postOnboarding: 0 };
  for (const workflow of Object.values(repo.workflows ?? {})) {
    if (workflow.reusable) continue;
    if (!inOnboarding(workflow, closesAt)) {
      counts.postOnboarding += 1;
      continue;
    }
    if (workflow.manual && workflow.status === "idle") {
      counts.manual += 1;
      continue;
    }
    if (workflow.status in counts) counts[workflow.status] += 1;
  }
  return counts;
}

export {
  emptyRepo,
  applyWorkflowRun,
  applyWorkflowInventory,
  applyRepoAttributes,
  applyRepoDeleted,
  isAttributeRefreshDue,
  applyMigration,
  dedupeWorkflows,
  workflowCounts,
  inOnboarding,
  onboardingWindowMs,
  onboardingClosesAt,
  isTerminal,
  TERMINAL_STATES,
  CONCLUSION_STATUS,
};
