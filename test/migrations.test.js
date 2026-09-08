import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchNewMigrations,
  refreshMigrations,
  buildRefreshQuery,
} from "../src/migrations.js";
import { Budget } from "../src/budget.js";

function node(id, overrides = {}) {
  return {
    id,
    repositoryName: `repo-${id}`,
    state: "SUCCEEDED",
    createdAt: "2026-03-01T00:00:00Z",
    warningsCount: 0,
    continueOnError: false,
    sourceUrl: `https://ghes.example/legacy/${id}`,
    failureReason: null,
    migrationLogUrl: null,
    migrationSource: { name: "Azure DevOps" },
    ...overrides,
  };
}

function page(nodes, { hasNextPage = false, endCursor = null } = {}) {
  return { organization: { login: "acme", repositoryMigrations: { pageInfo: { hasNextPage, endCursor }, nodes } } };
}

function stubGraphql(pages) {
  const calls = [];
  return {
    calls,
    graphql: async (query, variables) => {
      calls.push({ query, variables });
      const next = pages.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test("a migration node becomes a row with its source and state", async () => {
  const octokit = stubGraphql([page([node("m1")])]);
  const { rows } = await fetchNewMigrations(octokit, "acme", null, new Budget());

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: "m1",
    org: "acme",
    repository: "repo-m1",
    state: "SUCCEEDED",
    createdAt: "2026-03-01T00:00:00Z",
    warningsCount: 0,
    continueOnError: false,
    sourceUrl: "https://ghes.example/legacy/m1",
    failureReason: null,
    migrationLogUrl: null,
    sourceType: "Azure DevOps",
  });
});

// repositoryMigrations treats `after` as inclusive: each page repeats the node
// its cursor points at. Without dedup that node would be counted twice.
test("the node a cursor points at is not returned twice", async () => {
  const octokit = stubGraphql([
    page([node("m1"), node("m2")], { hasNextPage: true, endCursor: "c2" }),
    page([node("m2"), node("m3")], { hasNextPage: false, endCursor: "c3" }),
  ]);

  const { rows, cursor } = await fetchNewMigrations(octokit, "acme", null, new Budget());

  assert.deepEqual(rows.map((r) => r.id), ["m1", "m2", "m3"]);
  assert.equal(cursor, "c3");
});

test("pagination resumes from the stored cursor", async () => {
  const octokit = stubGraphql([page([node("m9")])]);
  await fetchNewMigrations(octokit, "acme", "stored-cursor", new Budget());

  assert.equal(octokit.calls[0].variables.cursor, "stored-cursor");
  assert.equal(octokit.calls[0].variables.login, "acme");
});

// Stopping mid-walk must leave the cursor on the last page actually applied, or
// the next run would skip whatever was never read.
test("an exhausted budget stops the walk and reports it", async () => {
  const octokit = stubGraphql([
    page([node("m1")], { hasNextPage: true, endCursor: "c1" }),
    page([node("m2")], { hasNextPage: true, endCursor: "c2" }),
  ]);
  const budget = new Budget({ graphql: 1 });

  const { rows, cursor, truncated } = await fetchNewMigrations(octokit, "acme", null, budget);

  assert.deepEqual(rows.map((r) => r.id), ["m1"]);
  assert.equal(cursor, "c1");
  assert.equal(truncated, true);
  assert.equal(octokit.calls.length, 1);
});

test("an organization the query cannot resolve yields nothing", async () => {
  const octokit = stubGraphql([{ organization: null }]);
  const { rows, cursor } = await fetchNewMigrations(octokit, "acme", null, new Budget());

  assert.deepEqual(rows, []);
  assert.equal(cursor, null);
});

test("a missing migration source is left null rather than invented", async () => {
  const octokit = stubGraphql([
    page([node("m1", { migrationSource: null, sourceUrl: null, warningsCount: null })]),
  ]);
  const { rows } = await fetchNewMigrations(octokit, "acme", null, new Budget());

  assert.equal(rows[0].sourceType, null);
  assert.equal(rows[0].sourceUrl, null);
  assert.equal(rows[0].warningsCount, 0);
});

// A stored id ends up in the query document, so it travels as a variable.
test("refresh ids are variables, never interpolated", () => {
  const query = buildRefreshQuery(2);

  assert.match(query, /\$id0: ID!/);
  assert.match(query, /\$id1: ID!/);
  assert.match(query, /m0: node\(id: \$id0\)/);
  assert.doesNotMatch(query, /node\(id: "/);
});

test("in-flight migrations are refreshed in one request per batch", async () => {
  const rows = [
    { id: "m1", org: "acme", repository: "a", state: "IN_PROGRESS", warningsCount: 2 },
    { id: "m2", org: "acme", repository: "b", state: "QUEUED", warningsCount: 0 },
  ];
  const octokit = stubGraphql([
    {
      m0: { state: "SUCCEEDED", warningsCount: 3, failureReason: null, migrationLogUrl: null },
      m1: { state: "FAILED", warningsCount: null, failureReason: "boom", migrationLogUrl: "u" },
    },
  ]);

  const refreshed = await refreshMigrations(octokit, rows, new Budget());

  assert.equal(octokit.calls.length, 1);
  assert.deepEqual(octokit.calls[0].variables, { id0: "m1", id1: "m2" });
  assert.equal(refreshed[0].state, "SUCCEEDED");
  assert.equal(refreshed[0].warningsCount, 3);
  // A null count is an absent observation, so the stored one stands.
  assert.equal(refreshed[1].warningsCount, 0);
  assert.equal(refreshed[1].failureReason, "boom");
});

test("a migration the API can no longer resolve keeps what is stored", async () => {
  const rows = [{ id: "gone", org: "acme", repository: "a", state: "IN_PROGRESS" }];
  const octokit = stubGraphql([{ m0: null }]);

  assert.deepEqual(await refreshMigrations(octokit, rows, new Budget()), []);
});

// GraphQL reports one unresolvable id as an error for the whole response even
// though the other aliases came back.
test("a partial error keeps the aliases that did resolve", async () => {
  const rows = [
    { id: "gone", org: "acme", repository: "a", state: "IN_PROGRESS" },
    { id: "m2", org: "acme", repository: "b", state: "IN_PROGRESS" },
  ];
  const err = Object.assign(new Error("Could not resolve to a node"), {
    data: { m0: null, m1: { state: "SUCCEEDED" } },
  });
  const octokit = stubGraphql([err]);

  const refreshed = await refreshMigrations(octokit, rows, new Budget());

  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].id, "m2");
  assert.equal(refreshed[0].state, "SUCCEEDED");
});

test("an error carrying no data still surfaces", async () => {
  const rows = [{ id: "m1", org: "acme", repository: "a", state: "IN_PROGRESS" }];
  const octokit = stubGraphql([new Error("network down")]);

  await assert.rejects(() => refreshMigrations(octokit, rows, new Budget()), /network down/);
});

test("refreshing stops when the budget runs out", async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: `m${i}`,
    org: "acme",
    repository: `r${i}`,
    state: "IN_PROGRESS",
  }));
  const octokit = stubGraphql([{ m0: { state: "SUCCEEDED" } }]);
  const budget = new Budget({ graphql: 1 });

  const refreshed = await refreshMigrations(octokit, rows, budget, 1);

  assert.equal(refreshed.length, 1);
  assert.equal(octokit.calls.length, 1);
});
