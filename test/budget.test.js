import { test } from "node:test";
import assert from "node:assert/strict";
import { poolFor } from "../src/octokit.js";
import { Budget, PROGRESS_EVERY } from "../src/budget.js";

test("a request is attributed to the budget pool it draws from", () => {
  assert.equal(poolFor({ url: "/graphql" }), "graphql");
  assert.equal(poolFor({ url: "https://api.acme.ghe.com/graphql" }), "graphql");
  assert.equal(poolFor({ url: "/orgs/acme/audit-log" }), "audit");
  assert.equal(poolFor({ url: "/repos/acme/api/actions/workflows" }), "rest");
  assert.equal(poolFor({}), "rest");
});

test("a budget stops handing out calls once it is spent", () => {
  const budget = new Budget({ rest: 2 });
  assert.equal(budget.take("rest"), true);
  assert.equal(budget.take("rest"), true);
  assert.equal(budget.take("rest"), false);
  assert.equal(budget.truncated, true);
  assert.deepEqual(budget.report(), { rest: 2, graphql: 0, audit: 0 });
});

test("hitting a real rate limit closes the pool like spending the budget does", () => {
  // The configured budget is a guess; GitHub's own limit is the fact.
  const budget = new Budget({ rest: 1000 });
  budget.exhaust("rest", "rest primary rate limit reached");

  assert.equal(budget.take("rest"), false);
  assert.equal(budget.truncated, true);
  assert.equal(budget.take("graphql"), true, "other pools keep working");
});

test("exhausting a pool twice only reports once", () => {
  const budget = new Budget({ rest: 1 });
  budget.exhaust("rest", "first");
  budget.exhaust("rest", "second");
  assert.equal(budget.exhausted.size, 1);
});

test("an unlimited pool never truncates", () => {
  const budget = new Budget({ rest: Infinity });
  for (let i = 0; i < 10_000; i += 1) budget.take("rest");
  assert.equal(budget.truncated, false);
});

// The rate-limit headers are the only view of the hourly allowance the token
// shares with everything else it is used for, so they ride along in the log.
test("rate-limit headers are remembered per pool and described with the spend", () => {
  const budget = new Budget({ rest: 4000, audit: 1500 });
  budget.take("rest");
  budget.observe("rest", {
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": "4650",
    "x-ratelimit-reset": String(Math.floor(Date.parse("2026-09-10T15:00:00Z") / 1000)),
  });
  budget.take("graphql");
  budget.observe("graphql", {});

  assert.deepEqual(budget.rateLimits.rest, {
    limit: 5000,
    remaining: 4650,
    resetAt: Date.parse("2026-09-10T15:00:00Z"),
  });
  assert.equal(budget.rateLimits.graphql, undefined, "a response without headers reports nothing");

  const line = budget.describe();
  assert.match(line, /REST 1\/4000 \(4,650 of 5,000 left, resets 15:00Z\)/);
  assert.match(line, /GraphQL 1$|GraphQL 1,/);
  assert.match(line, /Audit log 0\/1500/);
});

test("a nearly spent rate limit is warned about once", () => {
  const budget = new Budget();
  const low = { "x-ratelimit-limit": "1750", "x-ratelimit-remaining": "100" };
  budget.observe("audit", low);
  budget.observe("audit", { ...low, "x-ratelimit-remaining": "50" });
  assert.deepEqual([...budget.warnedLow], ["audit"]);

  budget.observe("rest", { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4000" });
  assert.equal(budget.warnedLow.has("rest"), false);
});

test("progress is written every fixed number of responses", () => {
  const budget = new Budget();
  for (let i = 0; i < PROGRESS_EVERY * 2; i += 1) budget.observe("rest", {});
  assert.equal(budget.observed, PROGRESS_EVERY * 2);
});

test("a repository whose name collides with an API path is still REST", () => {
  // Substring matching charged these to the wrong pool, so a 403 on such a repo
  // would have closed GraphQL or audit work instead of REST.
  assert.equal(poolFor({ url: "/repos/acme/graphql/actions/workflows" }), "rest");
  assert.equal(poolFor({ url: "/repos/acme/audit-log/actions/workflows" }), "rest");
  assert.equal(poolFor({ url: "/repos/acme/graphql-gateway/contents/ci.yml" }), "rest");
});

test("pool attribution survives an absolute URL and a query string", () => {
  assert.equal(poolFor({ url: "https://api.acme.ghe.com/graphql" }), "graphql");
  assert.equal(poolFor({ url: "https://ghes.example.com/api/graphql" }), "graphql");
  assert.equal(poolFor({ url: "/orgs/acme/audit-log?phrase=action%3Arepo.destroy" }), "audit");
  assert.equal(poolFor({ url: "/enterprises/acme/audit-log" }), "audit");
});
