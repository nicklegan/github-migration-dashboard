// Drains the enterprise audit log since the last run and turns it into typed
// events. This replaces per-repository polling: the log already carries every
// signal the dashboard needs, and reading it at the enterprise level costs one
// request per run however many organizations there are.
//
// `workflows.completed_workflow_run` events include repo, workflow_id, name and
// conclusion, so workflow status is derived without a single REST call.
//
// The actions are read as two streams with different starting points. A
// workflow's history is classified once by REST when its repository is first
// inventoried, so run events from before that moment add nothing — and on a
// busy organization they are almost all of the log. The run stream therefore
// starts at the first inventory; the rare events that date durations and
// record deletions still start at the earliest migration.

const RUN_ACTIONS = ["workflows.completed_workflow_run"];
const RARE_ACTIONS = ["repo.actions_enabled", "repo.destroy"];
const ACTIONS = [...RUN_ACTIONS, ...RARE_ACTIONS];

// Of everything the importer leaves in the audit log, enabling Actions is the
// only step that comes after the metadata import (verified against a
// migration log side by side). The earlier traces — the deploy key removed when
// the git import lands, branch protection restored — predate the phase that
// takes hours on a repository with thousands of pull requests, so they would
// report a duration that is confidently wrong. Migration paths that never
// enable Actions are dated from the migration log instead (see migrationLog.js).

// The log is eventually consistent, so re-scan a window before the last cursor
// and rely on _document_id to drop anything already applied.
const OVERLAP_MS = 60 * 60 * 1000;

// Repeated `action:` qualifiers are ORed, so the three arrive as one stream in
// time order. That is what lets a single cursor be correct under truncation:
// whatever the budget ran out before is, by construction, after the cursor.
//
// Repeated `org:` qualifiers are ORed the same way (verified on a ghe.com
// tenant). Scoping to the organizations that hold migrations means a large
// enterprise's other organizations cost nothing, whether the token cannot read
// them or they simply never migrated. Past ORGS_LIMIT the qualifier list is
// dropped: the phrase would be unwieldy, and at that point the enterprise-wide
// stream is mostly relevant anyway.
//
// The `created:` qualifier accepts a full timestamp, not just a date. Resuming
// at date granularity would re-read every event since midnight on every run,
// so the cost would follow the day's total activity rather than what is new.
// Milliseconds are dropped because the qualifier does not accept them.
const ORGS_LIMIT = 50;

function phraseFor(since, actions = ACTIONS, orgs = []) {
  const parts = actions.map((action) => `action:${action}`);
  if (orgs.length > 0 && orgs.length <= ORGS_LIMIT) {
    parts.push(...orgs.map((org) => `org:${org}`));
  }
  if (since) parts.push(`created:>=${since.toISOString().replace(/\.\d{3}Z$/, "Z")}`);
  return parts.join(" ");
}

function toEpochMs(value) {
  if (value == null) return null;
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function repoParts(fullName) {
  if (!fullName) return null;
  const slash = fullName.indexOf("/");
  if (slash === -1) return null;
  return { org: fullName.slice(0, slash), repository: fullName.slice(slash + 1) };
}

// Workflow runs identify their workflow by numeric id; the path is not in the
// event, so the id is the stable key until an inventory fetch supplies a path.
function workflowKeyOf(event) {
  return event.workflow_id != null ? `id:${event.workflow_id}` : (event.name ?? null);
}

function toEvent(raw) {
  const parts = repoParts(raw.repo);
  if (!parts) return null;
  const at = toEpochMs(raw.created_at ?? raw["@timestamp"]);
  const base = { documentId: raw._document_id, at, ...parts };

  switch (raw.action) {
    case "workflows.completed_workflow_run":
      return {
        ...base,
        type: "workflow_run",
        workflowKey: workflowKeyOf(raw),
        workflowId: raw.workflow_id ?? null,
        name: raw.name ?? null,
        conclusion: raw.conclusion ?? null,
        completedAt: raw.completed_at ?? null,
      };
    case "repo.actions_enabled":
      return { ...base, type: "actions_enabled" };
    case "repo.destroy":
      return { ...base, type: "repo_deleted" };
    default:
      return null;
  }
}

// Data written when the feed was read per organization stored a cursor per
// organization (and, for a while, per action within it). The enterprise stream
// needs one, so the earliest of them seeds it: resuming from the earliest is a
// re-read of a window already applied — every event is idempotent — whereas
// resuming from the latest would skip whatever a slower organization had not
// yet reached.
function cursorFrom(stored) {
  if (!stored || typeof stored !== "object") return null;
  if (typeof stored.at === "number") return stored;

  let earliest = null;
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.at === "number") {
      if (!earliest || value.at < earliest.at) earliest = value;
      return;
    }
    for (const inner of Object.values(value)) visit(inner);
  };
  visit(stored);
  return earliest ? { at: earliest.at, documentIds: [] } : null;
}

// Returns { events, cursor, truncated }. Events come back in time order across
// the requested organizations; the caller routes them by `org`.
//
// `floorMs` bounds a first read that has no cursor yet. Without it the whole
// retained history is read, most of which predates any migration. `orgs`
// narrows the stream to the organizations whose repositories are tracked, and
// `actions` to one of the two streams.
async function fetchAuditEvents(
  octokit,
  enterprise,
  stored,
  budget,
  { floorMs = null, orgs = [], actions = ACTIONS } = {},
) {
  const cursor = cursorFrom(stored);
  const startMs = cursor?.at ? cursor.at - OVERLAP_MS : floorMs;
  const since = startMs ? new Date(startMs) : null;
  const applied = new Set(cursor?.documentIds ?? []);
  const events = [];
  let newest = cursor?.at ?? 0;
  const newestIds = [];

  const iterator = octokit.paginate.iterator("GET /enterprises/{enterprise}/audit-log", {
    enterprise,
    phrase: phraseFor(since, actions, orgs),
    include: "web",
    order: "asc",
    per_page: 100,
  });

  for await (const { data } of iterator) {
    if (!budget.take("audit")) {
      // A cursor may only advance over pages that were read to the end; what
      // was collected before the budget ran out is still applied and the rest
      // is re-read next run.
      return { events, cursor: { at: newest, documentIds: newestIds }, truncated: true };
    }

    for (const raw of data) {
      const at = toEpochMs(raw.created_at ?? raw["@timestamp"]);
      if (at != null && cursor?.at && at < cursor.at - OVERLAP_MS) continue;
      if (raw._document_id && applied.has(raw._document_id)) continue;

      const event = toEvent(raw);
      if (!event) continue;
      events.push(event);

      if (at != null && at >= newest) {
        if (at > newest) newestIds.length = 0;
        newest = at;
        if (raw._document_id) newestIds.push(raw._document_id);
      }
    }
  }

  return { events, cursor: { at: newest, documentIds: newestIds }, truncated: false };
}

export {
  fetchAuditEvents,
  cursorFrom,
  toEvent,
  workflowKeyOf,
  phraseFor,
  ACTIONS,
  RUN_ACTIONS,
  RARE_ACTIONS,
  OVERLAP_MS,
  ORGS_LIMIT,
};
