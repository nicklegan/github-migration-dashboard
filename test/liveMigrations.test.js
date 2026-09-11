import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchLiveMigrations, toRows, newestFirst, settledPage } from "../src/liveMigrations.js";
import { Budget } from "../src/budget.js";

const OBSERVED = "2026-03-01T00:00:00.000Z";

function stubOctokit(pages) {
  const calls = [];
  return {
    calls,
    request: async (_route, params) => {
      calls.push(params);
      const page = pages[params.page_token ?? ""];
      if (page instanceof Error) throw page;
      return { data: page };
    },
  };
}

test("a migration becomes one row per repository it carries", () => {
  const rows = toRows(
    {
      migrationId: "42",
      status: "STATUS_TYPE_COMPLETE",
      repositories: ["octo-org/octo-repo", "octo-org/other"],
      sourceUrl: "https://ghes.example/legacy/octo-repo",
    },
    OBSERVED,
  );

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    id: "elm:42:octo-org/octo-repo",
    org: "octo-org",
    repository: "octo-repo",
    state: "SUCCEEDED",
    createdAt: OBSERVED,
    warningsCount: 0,
    continueOnError: false,
    sourceUrl: "https://ghes.example/legacy/octo-repo",
    failureReason: null,
    migrationLogUrl: null,
    sourceType: "Enterprise Live Migration",
    live: true,
  });
  assert.equal(rows[1].id, "elm:42:octo-org/other");
});

// The documented target record carries no source at all, so the field is probed
// under every name it could arrive as rather than assumed absent.
test("a source repository URL is read under any of its spellings", () => {
  const sourceOf = (migration) =>
    toRows({ migrationId: "1", repositories: ["o/r"], ...migration }, OBSERVED)[0].sourceUrl;

  for (const field of ["sourceUrl", "source_url", "sourceRepositoryUrl", "source_repository_url"]) {
    assert.equal(sourceOf({ [field]: "https://ghes.example/o/r" }), "https://ghes.example/o/r");
  }
  assert.equal(sourceOf({}), null);
  assert.equal(sourceOf({ sourceUrl: "   " }), null);
});

// Folding the target vocabulary into the states the dashboard already speaks is
// what lets live migrations reuse the existing cards and tables.
test("target statuses map onto the dashboard states", () => {
  const stateOf = (status) =>
    toRows({ migrationId: "1", status, repositories: ["o/r"] }, OBSERVED)[0];

  assert.equal(stateOf("STATUS_TYPE_COMPLETE").state, "SUCCEEDED");
  assert.equal(stateOf("STATUS_TYPE_IN_PROGRESS").state, "IN_PROGRESS");
  assert.equal(stateOf("STATUS_TYPE_PAUSED").state, "PAUSED");
  assert.equal(stateOf("STATUS_TYPE_FAILED").state, "FAILED");
  assert.equal(stateOf("STATUS_TYPE_INVALID").state, "PENDING");
  assert.equal(stateOf("SOMETHING_NEW").state, "PENDING");
});

// Aborted and expired both leave the repository absent from the target, so they
// count as failures — but why must not be lost.
test("aborted and expired read as failures with a reason", () => {
  const aborted = toRows(
    { migrationId: "1", status: "STATUS_TYPE_ABORTED", repositories: ["o/r"] },
    OBSERVED,
  )[0];
  const expired = toRows(
    { migrationId: "1", status: "STATUS_TYPE_EXPIRED", repositories: ["o/r"] },
    OBSERVED,
  )[0];

  assert.equal(aborted.state, "FAILED");
  assert.equal(aborted.failureReason, "Migration aborted");
  assert.equal(expired.state, "FAILED");
  assert.equal(expired.failureReason, "Migration expired");
});

test("a creation date the API reports wins over the observation date", () => {
  const [row] = toRows(
    {
      migrationId: "7",
      status: "STATUS_TYPE_COMPLETE",
      createdAt: "2026-01-05T10:00:00Z",
      repositories: ["o/r"],
    },
    OBSERVED,
  );
  assert.equal(row.createdAt, "2026-01-05T10:00:00Z");
});

test("records without an id or a parseable repository are dropped", () => {
  assert.deepEqual(toRows({ status: "STATUS_TYPE_COMPLETE", repositories: ["o/r"] }, OBSERVED), []);
  assert.deepEqual(toRows({ migrationId: "1", repositories: ["no-slash", "/r", "o/"] }, OBSERVED), []);
  assert.deepEqual(toRows({ migrationId: "1" }, OBSERVED), []);
});

test("pagination is followed and rows are grouped by organization", async () => {
  const octokit = stubOctokit({
    "": {
      migrations: [
        { migrationId: "1", status: "STATUS_TYPE_COMPLETE", repositories: ["alpha/one"] },
        { migrationId: "2", status: "STATUS_TYPE_FAILED", repositories: ["beta/two"] },
      ],
      nextPageToken: "page2",
    },
    page2: {
      migrations: [
        { migrationId: "3", status: "STATUS_TYPE_PAUSED", repositories: ["alpha/three"] },
      ],
      nextPageToken: "",
    },
  });

  const { byOrg, count, unavailable } = await fetchLiveMigrations(octokit, new Budget());

  assert.equal(unavailable, null);
  assert.equal(count, 3);
  assert.deepEqual([...byOrg.keys()].sort(), ["alpha", "beta"]);
  assert.equal(byOrg.get("alpha").length, 2);
  assert.equal(octokit.calls.length, 2);
  assert.equal(octokit.calls[1].page_token, "page2");
});

// A cursor the API hands back twice cannot deliver anything new; following it
// would spin forever.
test("a repeated page token stops the walk", async () => {
  const octokit = stubOctokit({
    "": { migrations: [{ migrationId: "1", repositories: ["o/r"] }], nextPageToken: "loop" },
    loop: { migrations: [], nextPageToken: "loop" },
  });

  const { count } = await fetchLiveMigrations(octokit, new Budget());

  assert.equal(count, 1);
  assert.equal(octokit.calls.length, 2);
});

test("a tenant without the endpoint is reported, not fatal", async () => {
  const notFound = Object.assign(new Error("Not Found"), { status: 404 });
  const { byOrg, count, unavailable } = await fetchLiveMigrations(
    stubOctokit({ "": notFound }),
    new Budget(),
  );

  assert.equal(byOrg.size, 0);
  assert.equal(count, 0);
  assert.match(unavailable, /does not expose/);
});

// github.com has no live-migrations API at all. Whatever it answers with, an
// optional source must not take down a run that is otherwise fine.
test("any client error retires the source for the run", async () => {
  for (const status of [400, 401, 403, 404, 410, 422]) {
    const err = Object.assign(new Error(`HTTP ${status}`), { status });
    const { count, unavailable } = await fetchLiveMigrations(
      stubOctokit({ "": err }),
      new Budget(),
    );
    assert.equal(count, 0);
    assert.ok(unavailable, `HTTP ${status} should report a reason`);
  }
});

// The remedy for a 403 here is a specific scope, so the log names it.
test("a forbidden live-migrations read names the scope it needs", async () => {
  const err = Object.assign(new Error("HTTP 403"), { status: 403 });
  const { unavailable } = await fetchLiveMigrations(stubOctokit({ "": err }), new Budget());
  assert.match(unavailable, /admin:enterprise/);
});

test("an unexpected failure still surfaces", async () => {
  const boom = Object.assign(new Error("Server Error"), { status: 500 });
  await assert.rejects(
    () => fetchLiveMigrations(stubOctokit({ "": boom }), new Budget()),
    /Server Error/,
  );
});

test("an exhausted REST budget stops before the first call", async () => {
  const octokit = stubOctokit({ "": { migrations: [], nextPageToken: "" } });
  const budget = new Budget({ rest: 0 });

  const { count } = await fetchLiveMigrations(octokit, budget);

  assert.equal(count, 0);
  assert.equal(octokit.calls.length, 0);
});

// The list endpoint has no `since`, so the whole tenant is re-read every run.
// It can only be cut short if the newest records come first, and reading a
// descending list as ascending would stop on page one and never see a new
// migration again — so the order is inferred, not assumed.
test("the order is only inferred when the timestamps show it", () => {
  const descending = [
    { createdAt: "2026-03-01T00:00:00Z" },
    { createdAt: "2026-01-01T00:00:00Z" },
  ];
  assert.equal(newestFirst(descending), true);
  assert.equal(newestFirst([...descending].reverse()), false);

  // Undated or single-record pages say nothing, so the walk continues.
  assert.equal(newestFirst([{ createdAt: "2026-03-01T00:00:00Z" }]), false);
  assert.equal(newestFirst([{}, {}]), false);
  assert.equal(newestFirst([]), false);
});

test("a page counts as settled only when every record is known and terminal", () => {
  const known = new Set(["1", "2"]);
  const complete = { migrationId: "1", status: "STATUS_TYPE_COMPLETE" };
  const aborted = { migrationId: "2", status: "STATUS_TYPE_ABORTED" };

  assert.equal(settledPage([complete, aborted], known), true);
  assert.equal(settledPage([complete, { migrationId: "2", status: "STATUS_TYPE_PAUSED" }], known), false);
  assert.equal(settledPage([complete, { migrationId: "9", status: "STATUS_TYPE_COMPLETE" }], known), false);
});

test("a newest-first list stops once it reaches migrations already settled", async () => {
  const octokit = stubOctokit({
    "": {
      migrations: [
        { migrationId: "3", status: "STATUS_TYPE_COMPLETE", createdAt: "2026-03-01T00:00:00Z", repositories: ["o/c"] },
        { migrationId: "1", status: "STATUS_TYPE_COMPLETE", createdAt: "2026-01-01T00:00:00Z", repositories: ["o/a"] },
      ],
      nextPageToken: "page2",
    },
    page2: { migrations: [], nextPageToken: "" },
  });

  await fetchLiveMigrations(octokit, new Budget(), { settledIds: new Set(["1", "3"]) });

  assert.equal(octokit.calls.length, 1, "nothing behind a fully settled page can have changed");
});

test("an unfinished migration keeps the walk going", async () => {
  const octokit = stubOctokit({
    "": {
      migrations: [
        { migrationId: "3", status: "STATUS_TYPE_PAUSED", createdAt: "2026-03-01T00:00:00Z", repositories: ["o/c"] },
        { migrationId: "1", status: "STATUS_TYPE_COMPLETE", createdAt: "2026-01-01T00:00:00Z", repositories: ["o/a"] },
      ],
      nextPageToken: "page2",
    },
    page2: { migrations: [], nextPageToken: "" },
  });

  await fetchLiveMigrations(octokit, new Budget(), { settledIds: new Set(["1"]) });

  assert.equal(octokit.calls.length, 2);
});

test("an order that cannot be read is walked in full", async () => {
  const octokit = stubOctokit({
    "": {
      migrations: [{ migrationId: "1", status: "STATUS_TYPE_COMPLETE", repositories: ["o/a"] }],
      nextPageToken: "page2",
    },
    page2: { migrations: [], nextPageToken: "" },
  });

  await fetchLiveMigrations(octokit, new Budget(), { settledIds: new Set(["1"]) });

  assert.equal(octokit.calls.length, 2, "without timestamps the order is unknown, so nothing is skipped");
});

// GitHub's rate limit also arrives as a 403, and that one is the budget
// stopping rather than anything about the endpoint.
test("a rate-limited read is not mistaken for a missing endpoint", async () => {
  const forbidden = Object.assign(new Error("rate limited"), { status: 403 });
  const budget = new Budget();
  budget.exhaust("rest", "primary rate limit reached");
  // The pool is closed, so take() refuses before the request; force the read.
  budget.take = () => true;

  const { unavailable } = await fetchLiveMigrations(stubOctokit({ "": forbidden }), budget);

  assert.match(unavailable, /budget ran out/);
});
