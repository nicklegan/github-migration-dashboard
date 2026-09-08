import test from "node:test";
import assert from "node:assert/strict";
import {
  enterpriseSlugFromServerUrl,
  classifyOrgFailure,
  fetchViewerEnterprises,
  findEnterprisesOwningOrganization,
} from "../src/organizations.js";

test("derives the enterprise slug from a ghe.com tenant host", () => {
  assert.equal(enterpriseSlugFromServerUrl("https://nicklegan.ghe.com"), "nicklegan");
});

test("ignores a trailing path on the server URL", () => {
  assert.equal(enterpriseSlugFromServerUrl("https://acme.ghe.com/some/path"), "acme");
});

test("returns empty for github.com", () => {
  assert.equal(enterpriseSlugFromServerUrl("https://github.com"), "");
});

test("returns empty for a GHES host (no data-residency subdomain)", () => {
  assert.equal(enterpriseSlugFromServerUrl("https://ghes.example.com"), "");
});

test("returns empty for missing or malformed input", () => {
  assert.equal(enterpriseSlugFromServerUrl(""), "");
  assert.equal(enterpriseSlugFromServerUrl(undefined), "");
  assert.equal(enterpriseSlugFromServerUrl("not a url"), "");
});

// GitHub reports an SSO-unauthorized organization as a plain permission error,
// so the message is the only thing separating "authorize this token" from
// "this token has no access here". They need opposite remedies.
test("an SSO-protected organization is identified as needing authorization", () => {
  const err = new Error(
    "Resource protected by organization SAML enforcement. " +
      "You must grant your OAuth token access to this organization.",
  );
  err.status = 403;
  const failure = classifyOrgFailure(err);

  assert.equal(failure.kind, "sso");
  assert.match(failure.hint, /Configure SSO/);
});

test("the token's administered enterprises are read as slugs", async () => {
  const octokit = {
    graphql: async () => ({
      viewer: { enterprises: { nodes: [{ slug: "acme" }, { slug: "other" }, null] } },
    }),
  };
  assert.deepEqual(await fetchViewerEnterprises(octokit), ["acme", "other"]);
});

test("no administered enterprises reads as an empty list, not a crash", async () => {
  assert.deepEqual(await fetchViewerEnterprises({ graphql: async () => ({}) }), []);
  assert.deepEqual(
    await fetchViewerEnterprises({ graphql: async () => ({ viewer: { enterprises: { nodes: [] } } }) }),
    [],
  );
});

// Several administered enterprises are narrowed by which one owns the
// organization the workflow itself runs in.
test("candidates are tested against the workflow's organization in one request", async () => {
  let calls = 0;
  let seen = null;
  const octokit = {
    graphql: async (query, variables) => {
      calls += 1;
      seen = { query, variables };
      return {
        e0: { organizations: { nodes: [{ login: "unrelated" }] } },
        e1: { organizations: { nodes: [{ login: "sandbox" }] } },
      };
    },
  };

  const owning = await findEnterprisesOwningOrganization(octokit, ["acme", "other"], "sandbox");

  assert.deepEqual(owning, ["other"]);
  assert.equal(calls, 1, "one aliased request, not one per candidate");
  // Slugs reach the document as variables rather than interpolated text.
  assert.deepEqual(seen.variables, { org: "sandbox", s0: "acme", s1: "other" });
  assert.match(seen.query, /\$s0: String!/);
  assert.doesNotMatch(seen.query, /slug: "acme"/);
});

// `query` is a search, so a near miss must not be mistaken for the real thing.
test("only an exact login counts as a match", async () => {
  const octokit = {
    graphql: async () => ({ e0: { organizations: { nodes: [{ login: "sandbox-archive" }] } } }),
  };
  assert.deepEqual(await findEnterprisesOwningOrganization(octokit, ["acme"], "sandbox"), []);
});

test("login matching ignores case", async () => {
  const octokit = {
    graphql: async () => ({ e0: { organizations: { nodes: [{ login: "SandBox" }] } } }),
  };
  assert.deepEqual(await findEnterprisesOwningOrganization(octokit, ["acme"], "sandbox"), ["acme"]);
});

test("an enterprise the token cannot read is skipped, not fatal", async () => {
  const octokit = {
    graphql: async () => ({ e0: null, e1: { organizations: { nodes: [{ login: "sandbox" }] } } }),
  };
  assert.deepEqual(
    await findEnterprisesOwningOrganization(octokit, ["acme", "other"], "sandbox"),
    ["other"],
  );
});

test("nothing to narrow means no request at all", async () => {
  const octokit = {
    graphql: async () => {
      throw new Error("should not be called");
    },
  };
  assert.deepEqual(await findEnterprisesOwningOrganization(octokit, [], "sandbox"), []);
  assert.deepEqual(await findEnterprisesOwningOrganization(octokit, ["acme"], ""), []);
});

test("single sign-on is recognised however it is worded", () => {
  for (const message of ["SAML enforcement", "single sign-on required", "SSO is enabled"]) {
    assert.equal(classifyOrgFailure(new Error(message)).kind, "sso", message);
  }
});

test("a permission error without SSO points at access, not authorization", () => {
  const err = new Error("Must have admin rights to Repository.");
  err.status = 403;
  const failure = classifyOrgFailure(err);

  assert.equal(failure.kind, "access");
  assert.match(failure.reason, /HTTP 403/);
  assert.match(failure.hint, /owner or migrator/);
});

test("a migration permission error names both scope and role, not an unknown error", () => {
  const failure = classifyOrgFailure(
    new Error(
      "Request failed due to following response errors:\n" +
        " - octocat does not have the right permission to retrieve repository migrations.",
    ),
  );

  assert.equal(failure.kind, "access");
  assert.equal(failure.reason, "No access to repository migrations");
  assert.match(failure.hint, /admin:org, read:audit_log, read:enterprise, repo, and workflow/);
  assert.match(failure.hint, /owner or migrator/);
});

test("an unexpected failure keeps its own message on one line", () => {
  const failure = classifyOrgFailure(new Error("socket hang up\n  at Foo\n  at Bar"));
  assert.equal(failure.kind, "error");
  assert.equal(failure.reason, "socket hang up at Foo at Bar");
  assert.equal(failure.hint, null);
});
