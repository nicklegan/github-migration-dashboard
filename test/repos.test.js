import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchRepoDetails, buildQuery, BATCH_SIZE } from "../src/repos.js";
import { Budget } from "../src/budget.js";

function stubGraphql(responses) {
  const calls = [];
  return {
    calls,
    graphql: async (query, variables) => {
      calls.push({ query, variables });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function repo(name, { diskUsage = 2048, properties = [] } = {}) {
  return { name, diskUsage, repositoryCustomPropertyValues: { nodes: properties } };
}

// A repository name ends up in the query document, so it travels as a variable.
test("repository names are variables, never interpolated", () => {
  const query = buildQuery(2);

  assert.match(query, /\$owner: String!/);
  assert.match(query, /\$n0: String!/);
  assert.match(query, /r0: repository\(owner: \$owner, name: \$n0\)/);
  assert.doesNotMatch(query, /name: "/);
});

test("size is reported in MB and the team comes from the named property", async () => {
  const octokit = stubGraphql([
    {
      r0: repo("alpha", {
        diskUsage: 1536,
        properties: [
          { propertyName: "cost_centre", value: "ignored" },
          { propertyName: "team", value: "Platform" },
        ],
      }),
    },
  ]);

  const details = await fetchRepoDetails(octokit, "acme", ["alpha"], "team", new Budget());

  assert.deepEqual(details.get("alpha"), { repoSizeMB: 1.5, team: "Platform" });
  assert.deepEqual(octokit.calls[0].variables, { owner: "acme", n0: "alpha" });
});

test("a repository without the property is unassigned, not skipped", async () => {
  const octokit = stubGraphql([{ r0: repo("alpha", { properties: [] }) }]);
  const details = await fetchRepoDetails(octokit, "acme", ["alpha"], "team", new Budget());

  assert.deepEqual(details.get("alpha"), { repoSizeMB: 2, team: null });
});

test("the property name matches regardless of case", async () => {
  const octokit = stubGraphql([
    { r0: repo("alpha", { properties: [{ propertyName: "Area", value: "Mobility" }] }) },
  ]);
  const details = await fetchRepoDetails(octokit, "acme", ["alpha"], "area", new Budget());

  assert.equal(details.get("alpha").team, "Mobility");
});

test("a multi-select property is flattened to one label", async () => {
  const octokit = stubGraphql([
    {
      r0: repo("alpha", { properties: [{ propertyName: "area", value: ["Mobility", "Energy"] }] }),
      r1: repo("beta", { properties: [{ propertyName: "area", value: [] }] }),
    },
  ]);
  const details = await fetchRepoDetails(octokit, "acme", ["alpha", "beta"], "area", new Budget());

  assert.equal(details.get("alpha").team, "Mobility, Energy");
  assert.equal(details.get("beta").team, null);
});

test("an empty repository reports no size rather than zero", async () => {
  const octokit = stubGraphql([{ r0: repo("alpha", { diskUsage: null }) }]);
  const details = await fetchRepoDetails(octokit, "acme", ["alpha"], "team", new Budget());

  assert.equal(details.get("alpha").repoSizeMB, null);
});

// A repository the lookup cannot resolve keeps whatever the store already has,
// so it must be absent from the result rather than present-and-empty.
test("an unresolvable repository is absent from the result", async () => {
  const octokit = stubGraphql([{ r0: null, r1: repo("beta") }]);
  const details = await fetchRepoDetails(octokit, "acme", ["alpha", "beta"], "team", new Budget());

  assert.equal(details.has("alpha"), false);
  assert.equal(details.has("beta"), true);
});

// One missing repository makes the whole response an error even though the
// surviving aliases resolved.
test("a partial error keeps the repositories that did resolve", async () => {
  const err = Object.assign(new Error("Could not resolve to a Repository"), {
    data: { r0: null, r1: repo("beta") },
  });
  const octokit = stubGraphql([err]);

  const details = await fetchRepoDetails(octokit, "acme", ["alpha", "beta"], "team", new Budget());

  assert.deepEqual([...details.keys()], ["beta"]);
});

test("an error carrying no data still surfaces", async () => {
  const octokit = stubGraphql([new Error("network down")]);
  await assert.rejects(
    () => fetchRepoDetails(octokit, "acme", ["alpha"], "team", new Budget()),
    /network down/,
  );
});

test("names are split into batches, one request each", async () => {
  const names = Array.from({ length: BATCH_SIZE + 1 }, (_, i) => `r${i}`);
  const octokit = stubGraphql([{}, {}]);

  await fetchRepoDetails(octokit, "acme", names, "team", new Budget());

  assert.equal(octokit.calls.length, 2);
  assert.equal(Object.keys(octokit.calls[0].variables).length, BATCH_SIZE + 1); // owner + names
  assert.equal(Object.keys(octokit.calls[1].variables).length, 2);
});

test("an exhausted budget stops before the next batch", async () => {
  const names = Array.from({ length: BATCH_SIZE + 1 }, (_, i) => `r${i}`);
  const octokit = stubGraphql([{}, {}]);
  const budget = new Budget({ graphql: 1 });

  await fetchRepoDetails(octokit, "acme", names, "team", budget);

  assert.equal(octokit.calls.length, 1);
});

test("the budget is optional", async () => {
  const octokit = stubGraphql([{ r0: repo("alpha") }]);
  const details = await fetchRepoDetails(octokit, "acme", ["alpha"], "team");

  assert.equal(details.get("alpha").team, null);
});
