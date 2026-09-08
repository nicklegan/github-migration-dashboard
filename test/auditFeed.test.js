import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchAuditEvents,
  cursorFrom,
  phraseFor,
  toEvent,
  workflowKeyOf,
  ACTIONS,
  RUN_ACTIONS,
  RARE_ACTIONS,
  OVERLAP_MS,
  ORGS_LIMIT,
} from "../src/auditFeed.js";
import { Budget } from "../src/budget.js";

test("a first run asks for the whole history of every action at once", () => {
  assert.equal(phraseFor(null, ["repo.destroy"]), "action:repo.destroy");
  assert.equal(
    phraseFor(null),
    "action:workflows.completed_workflow_run action:repo.actions_enabled action:repo.destroy",
  );
});

test("a resume carries a full timestamp, not just a date", () => {
  // Date granularity would re-read every event since midnight on every run.
  const since = new Date("2026-09-01T12:34:56.789Z");
  assert.equal(
    phraseFor(since, ["repo.destroy"]),
    "action:repo.destroy created:>=2026-09-01T12:34:56Z",
  );
});

// Repeated org: qualifiers are ORed, so a busy enterprise's other organizations
// never reach the stream. Past the limit the list is dropped rather than sent.
test("the phrase is scoped to the given organizations, up to a limit", () => {
  const since = new Date("2026-09-01T12:00:00Z");
  assert.equal(
    phraseFor(since, ["repo.destroy"], ["org-a", "org-b"]),
    "action:repo.destroy org:org-a org:org-b created:>=2026-09-01T12:00:00Z",
  );
  assert.equal(phraseFor(null, ["repo.destroy"], []), "action:repo.destroy");

  const many = Array.from({ length: ORGS_LIMIT + 1 }, (_, i) => `org-${i}`);
  assert.equal(phraseFor(null, ["repo.destroy"], many), "action:repo.destroy");
});

test("the audit read passes its organizations through to the phrase", async () => {
  const octokit = stubOctokit([[]]);
  await fetchAuditEvents(octokit, "acme", null, new Budget({}), { orgs: ["org-a"] });
  assert.match(octokit.asked[0].phrase, /\borg:org-a\b/);
});

// Run events are the bulk of a busy organization's log and are redundant before
// the first inventory; the rare events are not. Each stream asks only for its own.
test("a stream asks only for its own actions", async () => {
  const rare = stubOctokit([[]]);
  await fetchAuditEvents(rare, "acme", null, new Budget({}), { actions: RARE_ACTIONS });
  assert.match(rare.asked[0].phrase, /action:repo\.actions_enabled action:repo\.destroy/);
  assert.doesNotMatch(rare.asked[0].phrase, /completed_workflow_run/);

  const runs = stubOctokit([[]]);
  await fetchAuditEvents(runs, "acme", null, new Budget({}), { actions: RUN_ACTIONS });
  assert.equal(runs.asked[0].phrase, "action:workflows.completed_workflow_run");

  assert.deepEqual([...RUN_ACTIONS, ...RARE_ACTIONS].sort(), [...ACTIONS].sort());
});

test("a workflow run event carries the workflow, conclusion and time", () => {
  const event = toEvent({
    _document_id: "doc-1",
    action: "workflows.completed_workflow_run",
    repo: "org-a/api",
    created_at: "2026-09-01T12:00:00Z",
    workflow_id: 42,
    name: "CI",
    conclusion: "success",
    completed_at: "2026-09-01T11:59:00Z",
  });

  assert.equal(event.type, "workflow_run");
  assert.equal(event.org, "org-a");
  assert.equal(event.repository, "api");
  assert.equal(event.workflowKey, "id:42");
  assert.equal(event.conclusion, "success");
  assert.equal(event.completedAt, "2026-09-01T11:59:00Z");
});

test("an event without a repository is ignored", () => {
  assert.equal(toEvent({ action: "repo.destroy", repo: null }), null);
  assert.equal(toEvent({ action: "repo.destroy", repo: "no-slash" }), null);
});

test("an unrecognised action is ignored", () => {
  assert.equal(toEvent({ action: "org.update_member", repo: "org-a/api" }), null);
});

test("a run event falls back to the workflow name when there is no id", () => {
  assert.equal(workflowKeyOf({ workflow_id: 7 }), "id:7");
  assert.equal(workflowKeyOf({ name: "CI" }), "CI");
  assert.equal(workflowKeyOf({}), null);
});

// The enterprise log is one time-ordered stream across every organization, and
// repeated `action:` qualifiers are ORed, so the three arrive interleaved.
function stubOctokit(pages) {
  const asked = [];
  return {
    asked,
    paginate: {
      iterator: (route, params) => {
        asked.push({ route, ...params });
        return (async function* () {
          for (const data of pages) yield { data };
        })();
      },
    },
  };
}

const runAt = Date.parse("2026-09-01T12:00:00Z");
const enabledAt = Date.parse("2026-09-01T10:00:00Z");
const destroyAt = Date.parse("2026-09-01T09:00:00Z");

const page = [
  {
    _document_id: "gone-1",
    action: "repo.destroy",
    repo: "org-b/web",
    created_at: new Date(destroyAt).toISOString(),
  },
  {
    _document_id: "on-1",
    action: "repo.actions_enabled",
    repo: "org-a/api",
    created_at: new Date(enabledAt).toISOString(),
  },
  {
    _document_id: "run-1",
    action: "workflows.completed_workflow_run",
    repo: "org-a/api",
    created_at: new Date(runAt).toISOString(),
    workflow_id: 42,
    conclusion: "success",
  },
];

test("one request covers every action and every organization", async () => {
  const octokit = stubOctokit([page]);
  const { events, cursor, truncated } = await fetchAuditEvents(octokit, "acme", null, new Budget({}));

  assert.equal(octokit.asked.length, 1);
  assert.equal(octokit.asked[0].route, "GET /enterprises/{enterprise}/audit-log");
  assert.equal(octokit.asked[0].enterprise, "acme");
  for (const action of ACTIONS) assert.match(octokit.asked[0].phrase, new RegExp(`action:${action}`));

  assert.equal(truncated, false);
  assert.deepEqual(
    events.map((e) => [e.type, e.org]),
    [["repo_deleted", "org-b"], ["actions_enabled", "org-a"], ["workflow_run", "org-a"]],
  );
  assert.equal(cursor.at, runAt);
  assert.deepEqual(cursor.documentIds, ["run-1"]);
});

test("a spent budget leaves the cursor where the last full page ended", async () => {
  const later = [{ ...page[2], _document_id: "run-2", created_at: "2026-09-01T13:00:00Z" }];
  const { events, cursor, truncated } = await fetchAuditEvents(
    stubOctokit([page, later]),
    "acme",
    null,
    new Budget({ audit: 1 }),
  );

  assert.equal(truncated, true);
  assert.equal(events.length, 3, "the page that was read is still applied");
  assert.equal(cursor.at, runAt, "the unread page sits after the cursor, so it is read next run");
});

test("the resume point sits one overlap window behind the cursor", async () => {
  const octokit = stubOctokit([[]]);
  await fetchAuditEvents(octokit, "acme", { at: runAt, documentIds: [] }, new Budget({}));

  assert.match(octokit.asked[0].phrase, /created:>=2026-09-01T11:00:00Z$/);
});

// Nothing before the first migration can concern a migrated repository, and a
// busy enterprise's retained history is mostly runs in repositories that never
// migrated.
test("a first read starts at the floor, and a cursor overrides it", async () => {
  const floorMs = Date.parse("2026-06-01T00:00:00Z");

  const first = stubOctokit([[]]);
  await fetchAuditEvents(first, "acme", null, new Budget({}), { floorMs });
  assert.match(first.asked[0].phrase, /created:>=2026-06-01T00:00:00Z$/);

  const resumed = stubOctokit([[]]);
  await fetchAuditEvents(resumed, "acme", { at: runAt, documentIds: [] }, new Budget({}), { floorMs });
  assert.match(resumed.asked[0].phrase, /created:>=2026-09-01T11:00:00Z$/);

  const unbounded = stubOctokit([[]]);
  await fetchAuditEvents(unbounded, "acme", null, new Budget({}), { floorMs: null });
  assert.doesNotMatch(unbounded.asked[0].phrase, /created:/);
});

test("events already applied at the cursor are not applied twice", async () => {
  const { events } = await fetchAuditEvents(
    stubOctokit([page]),
    "acme",
    { at: runAt, documentIds: ["run-1"] },
    new Budget({}),
  );

  assert.deepEqual(events.map((e) => e.documentId), []);
});

// Earlier data stored a cursor per organization, and for a while per action
// within it. Resuming from the earliest of them re-reads a window that is
// already applied, which is harmless; resuming from the latest would skip
// whatever a slower organization had not yet reached.
test("per-organization cursors fold to the earliest", () => {
  const perOrg = {
    "org-a": { at: 300, documentIds: ["x"] },
    "org-b": {
      "workflows.completed_workflow_run": { at: 200, documentIds: [] },
      "repo.destroy": { at: 100, documentIds: [] },
    },
  };
  assert.deepEqual(cursorFrom(perOrg), { at: 100, documentIds: [] });
});

test("a single cursor and an empty state pass through", () => {
  const single = { at: 5, documentIds: ["d"] };
  assert.equal(cursorFrom(single), single);
  assert.equal(cursorFrom(null), null);
  assert.equal(cursorFrom({}), null);
});
