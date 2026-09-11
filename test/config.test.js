import { test } from "node:test";
import assert from "node:assert/strict";
import { labelFromProperty, readConfig, resolveEnterprise, resolveServerUrl } from "../src/config.js";

// Organizations name this concept team, business unit, group, or tribe. The
// dashboard prints the label, so it has to read as a heading rather than as a
// property key.
test("a single-word property is capitalised", () => {
  assert.equal(labelFromProperty("team"), "Team");
  assert.equal(labelFromProperty("group"), "Group");
});

test("separators become spaces", () => {
  assert.equal(labelFromProperty("business_unit"), "Business unit");
  assert.equal(labelFromProperty("business-unit"), "Business unit");
  assert.equal(labelFromProperty("owning.team"), "Owning team");
});

test("camelCase is split", () => {
  assert.equal(labelFromProperty("businessUnit"), "Business unit");
  assert.equal(labelFromProperty("costCentre"), "Cost centre");
});

test("an already-capitalised property is not shouted back", () => {
  assert.equal(labelFromProperty("TEAM"), "Team");
  assert.equal(labelFromProperty("Business Unit"), "Business unit");
});

test("a property that reduces to nothing falls back to Team", () => {
  assert.equal(labelFromProperty(""), "Team");
  assert.equal(labelFromProperty("__"), "Team");
});

// Only a data-residency tenant carries its enterprise slug in the host, so
// github.com and GHES have to be told which enterprise to enumerate.
test("a ghe.com tenant autosenses its enterprise", () => {
  assert.equal(resolveEnterprise("", "https://acme.ghe.com"), "acme");
  assert.equal(resolveEnterprise(undefined, "https://acme.ghe.com"), "acme");
});

test("github.com and GHES need the enterprise input", () => {
  assert.equal(resolveEnterprise("", "https://github.com"), "");
  assert.equal(resolveEnterprise("", "https://ghes.example.com"), "");
  assert.equal(resolveEnterprise("acme", "https://github.com"), "acme");
  assert.equal(resolveEnterprise("  acme  ", "https://ghes.example.com"), "acme");
});

test("an explicit enterprise wins over the host", () => {
  assert.equal(resolveEnterprise("other", "https://acme.ghe.com"), "other");
});

// The dashboard links target repositories, so it needs the web host the
// migrations landed on rather than the API host they were read from.
test("the runner's server URL is the target host by default", () => {
  assert.equal(resolveServerUrl("", "https://acme.ghe.com"), "https://acme.ghe.com");
  assert.equal(resolveServerUrl("", "https://github.com/"), "https://github.com");
});

test("an api-url override moves the links to that instance", () => {
  assert.equal(resolveServerUrl("https://api.github.com", "https://acme.ghe.com"), "https://github.com");
  assert.equal(resolveServerUrl("https://api.acme.ghe.com", "https://github.com"), "https://acme.ghe.com");
  assert.equal(resolveServerUrl("https://ghes.example.com/api/v3", ""), "https://ghes.example.com");
});

test("an unusable server URL falls back to github.com", () => {
  assert.equal(resolveServerUrl("", ""), "https://github.com");
  assert.equal(resolveServerUrl("not a url", undefined), "https://github.com");
});

// @actions/core reads inputs from INPUT_* variables, which is how a workflow
// hands them to the action.
function withInputs(inputs, serverUrl, fn) {
  const saved = { ...process.env };
  process.env.INPUT_TOKEN = "x";
  process.env["INPUT_COMMIT-DATA"] = "true";
  process.env.GITHUB_SERVER_URL = serverUrl;
  for (const [name, value] of Object.entries(inputs)) process.env[`INPUT_${name.toUpperCase()}`] = value;
  try {
    return fn(readConfig());
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test("the committer defaults to the Actions bot on the runner's host", () => {
  withInputs({}, "https://acme.ghe.com", (config) => {
    assert.equal(config.committer.name, "github-actions[bot]");
    assert.equal(config.committer.email, "github-actions[bot]@users.noreply.acme.ghe.com");
  });
});

test("committer-name and committer-email override the defaults", () => {
  withInputs(
    { "committer-name": "Migration Bot", "committer-email": "migrations@example.com" },
    "https://github.com",
    (config) => {
      assert.equal(config.committer.name, "Migration Bot");
      assert.equal(config.committer.email, "migrations@example.com");
    },
  );
});
