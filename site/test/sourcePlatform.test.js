import { test } from "node:test";
import assert from "node:assert/strict";
import { sourcePlatform, platformOf, inferSourceKinds } from "../src/sourcePlatform.js";

// The importer's own type decides the family; the name is not consulted.
test("the importer's source type decides the platform", () => {
  assert.equal(sourcePlatform("GHEC Source", "https://code.acme.com/g/p", "GITLAB"), "GitLab");
  assert.equal(sourcePlatform("whatever", "https://bb.acme.internal/scm/P/r", "BITBUCKET_SERVER"), "Bitbucket");
  assert.equal(sourcePlatform("whatever", "https://dev.azure.com/a/p/_git/r", "AZURE_DEVOPS"), "Azure DevOps");
  assert.equal(sourcePlatform("GitLab Source", "https://github.acme.cloud/a/r", "GITHUB_ARCHIVE"), "GHES");
});

// GITHUB_ARCHIVE covers three products; only the host tells them apart.
test("a GitHub source is told apart by its host", () => {
  assert.equal(sourcePlatform("GHEC Source", "https://github.com/acme/api", "GITHUB_ARCHIVE"), "GHEC");
  assert.equal(sourcePlatform("GHEC Source", "https://acme.ghe.com/acme/api", "GITHUB_ARCHIVE"), "GHEC DR");
  assert.equal(sourcePlatform("GHEC Source", "https://github.acme.cloud/acme/api", "GITHUB_ARCHIVE"), "GHES");
  assert.equal(sourcePlatform("GHEC Source", null, "GITHUB_ARCHIVE"), "GHES", "no URL, not github.com");
});

// Without a type the name may decide the family, never the product: "GHEC
// Source" on a self-hosted host is a GHES, whatever the migrator called it.
test("without a type, the name decides the family and the host the product", () => {
  assert.equal(sourcePlatform("GHEC Source", "https://github.acme.cloud/acme/api"), "GHES");
  assert.equal(sourcePlatform("GHEC Source", "https://github.com/acme/api"), "GHEC");
  assert.equal(sourcePlatform("GHEC Source", "https://acme.ghe.com/acme/api"), "GHEC DR");
  assert.equal(sourcePlatform("GitHub Enterprise Server", "https://ghes.acme.internal/a/r"), "GHES");
  assert.equal(sourcePlatform("GitLab Source", "https://code.acme.com/g/p"), "GitLab");
  assert.equal(sourcePlatform("GitLab Archive Migration", "https://gitlab.acme.internal/g/p"), "GitLab");
  assert.equal(sourcePlatform("GitLab Source", "https://not-used"), "GitLab");
  assert.equal(sourcePlatform("Bitbucket Cloud Migration", "https://bitbucket.org/w/r"), "Bitbucket");
  assert.equal(sourcePlatform("Azure DevOps Source", "https://dev.azure.com/o/p/_git/r"), "Azure DevOps");
});

// A name that names no family is not a platform, so the column stays empty
// rather than showing a project path as if it were one; the raw name remains
// on hover and in the CSV's source-type column.
test("an unclassifiable name yields no platform", () => {
  assert.equal(sourcePlatform("test-migration-project", "https://code.acme.com/a/b"), null);
  assert.equal(sourcePlatform("platform-team/iac-enforcement-infrastructure", "https://code.acme.com/a/b"), null);
  assert.equal(sourcePlatform(null, null), null);
});

// A migrator who named one source after its project usually migrated many more
// from the same host under a proper name; those decide what the host is.
test("an unclassified source takes the platform of its host's other sources", () => {
  const rows = inferSourceKinds([
    { id: "a", sourceType: "GitLab Source", sourceUrl: "https://code.acme.com/x/a" },
    { id: "b", sourceType: "GitLab Archive Migration", sourceUrl: "https://code.acme.com/y/b" },
    { id: "c", sourceType: "platform-team/iac-enforcement-infrastructure", sourceUrl: "https://code.acme.com/platform-team/iac" },
    { id: "d", sourceType: "GHEC Source", sourceUrl: "https://github.acme.cloud/o/d" },
  ]);
  assert.equal(platformOf(rows[2]), "GitLab");
  assert.equal(rows[2].sourceKind, "GITLAB");
  // Classified rows are untouched, and the same objects come back.
  assert.equal(rows[0].sourceKind, undefined);
  assert.equal(platformOf(rows[3]), "GHES");
});

test("a host that hosted more than one platform teaches nothing", () => {
  const rows = inferSourceKinds([
    { id: "a", sourceType: "GitLab Source", sourceUrl: "https://scm.acme.com/x/a" },
    { id: "b", sourceType: "Bitbucket Source", sourceUrl: "https://scm.acme.com/y/b" },
    { id: "c", sourceType: "team/project", sourceUrl: "https://scm.acme.com/team/project" },
  ]);
  assert.equal(platformOf(rows[2]), null);
});

test("inference leaves rows alone when nothing is missing or nothing is known", () => {
  const known = [{ id: "a", sourceType: "GitLab Source", sourceUrl: "https://code.acme.com/x/a" }];
  assert.equal(inferSourceKinds(known), known);
  const alone = [{ id: "c", sourceType: "team/project", sourceUrl: "https://code.acme.com/team/project" }];
  assert.equal(inferSourceKinds(alone), alone);
  const live = [{ id: "l", sourceType: "Enterprise Live Migration", sourceUrl: null }];
  assert.equal(platformOf(inferSourceKinds(live)[0]), "GHES ELM");
});

test("a live migration has its own label", () => {
  assert.equal(sourcePlatform("Enterprise Live Migration", null), "GHES ELM");
});

test("platformOf reads the three fields off a row", () => {
  assert.equal(platformOf({ sourceType: "GHEC Source", sourceUrl: "https://github.com/a/r", sourceKind: "GITHUB_ARCHIVE" }), "GHEC");
  assert.equal(platformOf({ sourceType: "GHEC Source", sourceUrl: "https://github.acme.cloud/a/r" }), "GHES");
});
