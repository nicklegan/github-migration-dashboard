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
    repoId: null,
    // Where the repository lives now, set only once it differs from the name it
    // was migrated under. The record stays keyed by the migration-time name:
    // that is the migration's identity, and re-keying would lose its history.
    currentOrg: null,
    currentRepository: null,
    renamedAt: null,
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

// Where to look a repository up today, which is where it was migrated to until
// something says otherwise.
function repoLocation(record, org, repository) {
  return {
    owner: record?.currentOrg ?? org,
    name: record?.currentRepository ?? repository,
  };
}

// A name lookup follows a rename, but only until the old name is taken by a new
// repository — after that it resolves to a stranger. The id is what tells those
// apart, so a mismatch means the observation is about something else entirely.
// Unknown on either side is not a mismatch: records predating the id have none.
function isSameRepository(record, repoId) {
  if (!repoId || !record?.repoId) return true;
  return record.repoId === repoId;
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
    // When this workflow came back to life. Success is monotonic, so the first
    // one is the moment that matters and later ones never move it — but events
    // arrive out of order, so an older success does.
    //
    // A workflow already green before this was recorded cannot be dated from a
    // run now: that run is not its first success, and saying so would report a
    // months-old recovery as today's.
    firstSuccessAt: firstSuccessOf(before, observed, event.completedAt),
    firstSeenAt:
      before.firstSeenAt ??
      (discovered && repo.workflowsBootstrappedAt ? (event.completedAt ?? null) : null),
  };

  return { ...repo, workflows: { ...repo.workflows, [key]: workflow } };
}

function firstSuccessOf(before, observed, completedAt) {
  if (observed !== "succeeded") return before.firstSuccessAt ?? null;
  if (before.status === "succeeded" && !before.firstSuccessAt) return null;
  return olderOf(before.firstSuccessAt, completedAt) ?? null;
}

function findWorkflow(workflows, event) {  const entries = Object.entries(workflows ?? {});
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
      // The inventory reads this from the run history, so it can only ever be
      // older than what run events have seen.
      firstSuccessAt: olderOf(before?.firstSuccessAt, workflow.firstSuccessAt) ?? null,
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
  if (attributes.repoId) next.repoId = attributes.repoId;
  if (attributes.nameWithOwner) Object.assign(next, movedTo(repo, attributes.nameWithOwner, observedAt));
  if (observedAt) {
    next.observedAliveAt = observedAt;
    next.attributesFetchedAt = observedAt;
    next.deletedAt = null;
  }
  return next;
}

// A repository renamed back to what it was migrated as is not renamed at all,
// so the fields clear rather than freezing the last move. `renamedAt` dates when
// the move was first *seen*, not when it happened — the poll is what notices.
function movedTo(repo, nameWithOwner, observedAt) {
  const slash = String(nameWithOwner).indexOf("/");
  if (slash < 1) return {};
  const owner = nameWithOwner.slice(0, slash);
  const name = nameWithOwner.slice(slash + 1);

  if (owner === repo.org && name === repo.repository) {
    return { currentOrg: null, currentRepository: null, renamedAt: null };
  }
  const unchanged = owner === repo.currentOrg && name === repo.currentRepository;
  return {
    currentOrg: owner,
    currentRepository: name,
    renamedAt: (unchanged ? repo.renamedAt : null) ?? observedAt ?? null,
  };
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
        firstSuccessAt: olderOf(preferred.workflow.firstSuccessAt, other.firstSuccessAt) ?? null,
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

function olderOf(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(b) < Date.parse(a) ? b : a;
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

// The workflows a repository is scored on: the same exclusions the counts use,
// so the dates answer the same question as the badge beside them.
function scoredWorkflows(repo, closesAt) {
  return Object.values(repo?.workflows ?? {}).filter(
    (w) => !w.reusable && inOnboarding(w, closesAt) && !(w.manual && w.status === "idle"),
  );
}

// When the repository first had every scored workflow green — the same rule the
// dashboard already calls onboarding "complete", but dated.
//
// It is the LAST workflow to go green that gets the repository there, so this is
// the maximum rather than the minimum. Success is monotonic (see the invariants
// above), so once reached the date never moves. Null while anything is still
// failing or has never run, which is exactly the set the window is there to
// surface — and null too when a scored workflow succeeded before the action
// started dating them, since a repository cannot be dated from a date it lacks.
function backOnlineAt(repo, closesAt = Infinity) {
  const scored = scoredWorkflows(repo, closesAt);
  if (scored.length === 0) return null;

  let latest = null;
  for (const workflow of scored) {
    if (workflow.status !== "succeeded" || !workflow.firstSuccessAt) return null;
    latest = newerOf(latest, workflow.firstSuccessAt);
  }
  return latest;
}

// When anything in the repository first ran green. A repository can sit here for
// weeks before every workflow follows, and that gap is the onboarding tail.
function firstGreenAt(repo, closesAt = Infinity) {
  let earliest = null;
  for (const workflow of scoredWorkflows(repo, closesAt)) {
    if (workflow.firstSuccessAt) earliest = olderOf(earliest, workflow.firstSuccessAt);
  }
  return earliest;
}

export {
  emptyRepo,
  repoLocation,
  isSameRepository,
  applyWorkflowRun,
  applyWorkflowInventory,
  applyRepoAttributes,
  applyRepoDeleted,
  isAttributeRefreshDue,
  applyMigration,
  dedupeWorkflows,
  workflowCounts,
  backOnlineAt,
  firstGreenAt,
  inOnboarding,
  onboardingWindowMs,
  onboardingClosesAt,
  isTerminal,
  TERMINAL_STATES,
  CONCLUSION_STATUS,
};
