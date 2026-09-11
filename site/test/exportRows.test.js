import { test } from "node:test";
import assert from "node:assert/strict";
import { migrationCsv, workflowCsv, exportPlan } from "../src/exportRows.js";

const row = {
  id: "org-a/api",
  organization: "org-a",
  repository: "api",
  state: "SUCCEEDED",
  exists: true,
  removed: false,
  createdAt: "2026-01-03T00:00:00Z",
  durationMinutes: 14,
  warningsCount: 2,
  repoSizeMB: 50,
  attemptCount: 2,
  team: "Payments",
  sourceType: "GitLab Source",
  sourceUrl: "https://gitlab.dev/gl/sub/api",
  onboarding: "complete",
};

test("a repository exports the columns the table shows, plus the links", () => {
  const { headers, rows } = migrationCsv([row], {
    teamLabel: "Business unit",
    serverUrl: "https://acme.ghe.com",
  });
  const cell = (name) => rows[0][headers.indexOf(name)];

  assert.equal(headers.includes("Business unit"), true, "the team column uses the configured label");
  assert.equal(cell("State"), "SUCCEEDED");
  assert.equal(cell("Target repository"), "api");
  assert.equal(cell("Target URL"), "https://acme.ghe.com/org-a/api");
  assert.equal(cell("Source namespace"), "gl/sub");
  assert.equal(cell("Source repository"), "api");
  assert.equal(cell("Source URL"), "https://gitlab.dev/gl/sub/api");
  assert.equal(cell("Migration date"), "2026-01-03T00:00:00.000Z");
  assert.equal(cell("Attempts"), 2);
});

test("a repository with nothing to link exports empty cells, not placeholders", () => {
  const { headers, rows } = migrationCsv(
    [{ ...row, state: "FAILED", exists: false, sourceUrl: null, sourceType: null, team: null }],
    { serverUrl: "https://acme.ghe.com" },
  );
  const cell = (name) => rows[0][headers.indexOf(name)];

  // The table shows an em dash here; a spreadsheet needs a blank.
  assert.equal(cell("Target URL"), "");
  assert.equal(cell("Source namespace"), "");
  assert.equal(cell("Source URL"), "");
  assert.equal(cell("Team"), "");
});

test("the export is exactly the rows it was given", () => {
  assert.equal(migrationCsv([], {}).rows.length, 0);
  assert.equal(migrationCsv([row, { ...row, id: "org-a/web" }], {}).rows.length, 2);
});

const group = {
  key: "org-a/api",
  bucket: "0a",
  organization: "org-a",
  repository: "api",
  exists: true,
  sourceType: "GitLab Source",
  sourceUrl: "https://gitlab.dev/gl/api",
  team: "Payments",
  migratedAt: "2026-01-03T00:00:00Z",
};

// A rollup would drop the workflow names, which is what this table is for.
test("the workflow export is one line per workflow", () => {
  const workflows = [
    { name: "CI", status: "failing", state: "active", url: "https://x/ci" },
    { name: "Nightly", status: "idle", state: "active", manual: true, onboarding: false },
  ];
  const { headers, rows } = workflowCsv([group], () => workflows, { serverUrl: "https://acme.ghe.com" });
  const cell = (i, name) => rows[i][headers.indexOf(name)];

  assert.equal(rows.length, 2);
  assert.equal(cell(0, "Status"), "Failing");
  assert.equal(cell(0, "Workflow"), "CI");
  assert.equal(cell(0, "Workflow URL"), "https://x/ci");
  assert.equal(cell(0, "Target repository"), "api");
  assert.equal(cell(0, "Target URL"), "https://acme.ghe.com/org-a/api");
  assert.equal(cell(0, "Source repository"), "api");

  // A manual workflow that never ran is unmeasurable, exactly as the table badges it.
  assert.equal(cell(1, "Status"), "Manual");
  assert.equal(cell(1, "Manual"), true);
  assert.equal(cell(1, "Added after onboarding"), true);
});

test("a manual workflow that has run is scored on that run", () => {
  const { headers, rows } = workflowCsv([group], () => [
    { name: "Release", status: "succeeded", manual: true },
  ]);
  assert.equal(rows[0][headers.indexOf("Status")], "Succeeded");
});

test("a group whose workflows could not be read contributes no lines", () => {
  const { rows } = workflowCsv([group], () => []);
  assert.equal(rows.length, 0);
});

// Naming every workflow means fetching the detail bucket behind each group, so
// an unfiltered export on a large estate reaches for most of the payload.
test("an export spanning many buckets asks first", () => {
  const spread = Array.from({ length: 40 }, (_, i) => ({ ...group, bucket: String(i) }));

  assert.equal(exportPlan(spread).buckets, 40);
  assert.equal(exportPlan(spread).confirm, true);
});

test("an export the reader has already narrowed just runs", () => {
  const narrow = [group, { ...group, key: "org-a/web" }];

  assert.deepEqual(exportPlan(narrow), { buckets: 1, confirm: false });
  assert.equal(exportPlan([]).confirm, false);
});
