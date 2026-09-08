import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRows, buildSummary, summaryState, sourceKey } from "../src/summary.js";

const migrations = [
  { id: "M1", org: "org-a", repository: "api", state: "FAILED", createdAt: "2026-01-01T00:00:00Z", warningsCount: 2 },
  { id: "M2", org: "org-a", repository: "api", state: "SUCCEEDED", createdAt: "2026-01-03T00:00:00Z", warningsCount: 1, durationMinutes: 14 },
  { id: "M3", org: "org-b", repository: "web", state: "FAILED", createdAt: "2026-01-04T00:00:00Z", warningsCount: 3 },
];

const repos = {
  "org-a/api": {
    org: "org-a",
    repository: "api",
    team: "Payments",
    repoSizeMB: 50,
    deletedAt: null,
    workflows: {
      "ci.yml": { name: "CI", status: "succeeded", url: "https://x/ci" },
      "shared.yml": { name: "Shared", status: "idle", reusable: true },
      "nightly.yml": { name: "Nightly", status: "idle" },
    },
  },
  "org-b/web": {
    org: "org-b",
    repository: "web",
    team: null,
    repoSizeMB: 10,
    deletedAt: null,
    workflows: {},
  },
};

test("buildRows folds attempts into one row per repository", () => {
  const { rows } = buildRows(migrations, repos);
  assert.equal(rows.length, 2);
  const api = rows.find((r) => r.id === "org-a/api");
  assert.equal(api.attemptCount, 2);
  assert.equal(api.state, "SUCCEEDED");
  assert.equal(api.durationMinutes, 14);
});

test("rows stay light: attempts and workflows move to detail buckets", () => {
  const { rows, detail } = buildRows(migrations, repos);
  const api = rows.find((r) => r.id === "org-a/api");

  // The browser holds every row in memory to cross-filter, so a row must not
  // carry its attempts or its workflow list.
  assert.equal(api.attempts, undefined);
  assert.equal(api.workflows.workflows, undefined);
  assert.match(api.d, /^[0-9a-f]{2}$/);

  const bucket = detail.get(api.d);
  assert.equal(bucket["org-a/api"].attempts.length, 2);
  assert.deepEqual(
    bucket["org-a/api"].workflows.map((w) => w.name),
    ["CI", "Nightly"],
  );
});

// A retried migration raises the same warnings every attempt; the row reports
// the attempt that produced the repository, not the sum.
test("warnings come from the representative attempt, not every attempt", () => {
  const { rows } = buildRows(migrations, repos);
  assert.equal(rows.find((r) => r.id === "org-a/api").warningsCount, 1);
  assert.equal(rows.find((r) => r.id === "org-b/web").warningsCount, 3, "latest attempt when none succeeded");
});

test("workflows are counted once per repository and exclude reusable workflows", () => {
  const { rows } = buildRows(migrations, repos);
  const api = rows.find((r) => r.id === "org-a/api");
  assert.deepEqual(api.workflows, { succeeded: 1, failing: 0, idle: 1, manual: 0, postOnboarding: 0 });
});

test("team and size come from current repository state, not the migration", () => {
  const { rows } = buildRows(migrations, repos);
  const api = rows.find((r) => r.id === "org-a/api");
  assert.equal(api.team, "Payments");
  assert.equal(api.repoSizeMB, 50);
});

// A repository with one workflow has nothing to fold, so the table shows it
// inline — which it can only do if the row carries it.
test("a repository with a single workflow carries it on the row", () => {
  const one = {
    "org-a/api": {
      ...repos["org-a/api"],
      workflows: {
        "ci.yml": { name: "CI", status: "succeeded", url: "https://x/ci", state: "active" },
        "shared.yml": { name: "Shared", status: "idle", reusable: true },
      },
    },
  };
  const { rows } = buildRows(migrations, one);
  const api = rows.find((r) => r.id === "org-a/api");

  assert.equal(api.workflow.name, "CI");
  assert.equal(api.workflow.status, "succeeded");
  assert.equal(api.workflow.url, "https://x/ci");
});

test("a repository with several workflows, or none, carries no single workflow", () => {
  const { rows } = buildRows(migrations, repos);

  assert.equal(rows.find((r) => r.id === "org-a/api").workflow, null);
  assert.equal(rows.find((r) => r.id === "org-b/web").workflow, null);
});

test("a failed migration with no repository is a failure, not a deletion", () => {
  // The repository was never created. Labelling it deleted would let it be
  // filtered away with the removed ones, hiding the failure entirely.
  const withDeleted = {
    ...repos,
    "org-b/web": { ...repos["org-b/web"], deletedAt: "2026-02-01T00:00:00Z" },
  };
  const { rows } = buildRows(migrations, withDeleted);

  assert.equal(rows.length, 2);
  const web = rows.find((r) => r.id === "org-b/web");
  assert.equal(web.state, "FAILED");
  assert.equal(web.removed, false);
  assert.equal(web.deletedAt, null);
  assert.equal(web.workflows, null);
});

// A live migration that aborted or expired can still leave the repository on
// the target, so migration state alone cannot answer whether it is there.
test("a repository the action saw alive exists even though its migration failed", () => {
  const seenAlive = {
    ...repos,
    "org-b/web": { ...repos["org-b/web"], observedAliveAt: "2026-02-01T00:00:00Z" },
  };
  const { rows } = buildRows(migrations, seenAlive);
  const web = rows.find((r) => r.id === "org-b/web");

  assert.equal(web.state, "FAILED");
  assert.equal(web.exists, true);
});

test("a repository the action never resolved does not exist unless it migrated", () => {
  const { rows } = buildRows(migrations, repos);

  assert.equal(rows.find((r) => r.id === "org-b/web").exists, false);
  // No lookup yet is not proof of absence, so a success keeps its link.
  assert.equal(rows.find((r) => r.id === "org-a/api").exists, true);
});

test("a deleted repository does not exist however its migration ended", () => {
  const gone = {
    "org-a/api": { ...repos["org-a/api"], deletedAt: "2026-02-01T00:00:00Z" },
    "org-b/web": {
      ...repos["org-b/web"],
      observedAliveAt: "2026-01-01T00:00:00Z",
      deletedAt: "2026-02-01T00:00:00Z",
    },
  };
  const { rows } = buildRows(migrations, gone);

  assert.equal(rows.find((r) => r.id === "org-a/api").exists, false);
  assert.equal(rows.find((r) => r.id === "org-b/web").exists, false);
});

test("a repository removed after a successful migration is left out of the counts", () => {
  const withRemoved = {
    ...repos,
    "org-a/api": { ...repos["org-a/api"], deletedAt: "2026-02-01T00:00:00Z" },
  };
  const { rows } = buildRows(migrations, withRemoved);
  const api = rows.find((r) => r.id === "org-a/api");

  assert.equal(api.removed, true);
  assert.equal(api.deletedAt, "2026-02-01T00:00:00Z");
  assert.equal(api.workflows, null);

  const summary = buildSummary(rows, []);
  assert.equal(summary.removed, 1);
  assert.equal(summary.workflows.total, 0);
  assert.equal(summary.kpis.total, 1); // the row stays in the payload, not the counts
});

test("removing every successful repository must not erase the failures", () => {
  // The failure mode this guards against: dropping absent repositories wholesale
  // reported a flawless migration programme that had in fact failed three times.
  const log = [
    { id: "M1", org: "o", repository: "ok", state: "SUCCEEDED", createdAt: "2026-01-01T00:00:00Z" },
    { id: "M2", org: "o", repository: "bad", state: "FAILED", createdAt: "2026-01-02T00:00:00Z" },
  ];
  const gone = {
    "o/ok": { org: "o", repository: "ok", deletedAt: "2026-03-01T00:00:00Z", workflows: {} },
    "o/bad": { org: "o", repository: "bad", deletedAt: "2026-03-01T00:00:00Z", workflows: {} },
  };
  const summary = buildSummary(buildRows(log, gone).rows, []);

  assert.equal(summary.removed, 1);
  assert.equal(summary.kpis.total, 1);
  assert.equal(summary.kpis.failed, 1);
  assert.equal(summary.kpis.succeeded, 0);
  assert.equal(summary.kpis.successRate, 0);
});

test("a migration with no repository record still produces a row", () => {
  const { rows } = buildRows(migrations, {});
  assert.equal(rows.length, 2);
  assert.equal(rows[0].team, null);
  assert.equal(rows[0].workflows, null);
});

test("summaryState prefers success, then an in-flight attempt, then the newest", () => {
  assert.equal(summaryState([{ state: "FAILED" }, { state: "SUCCEEDED" }]), "SUCCEEDED");
  assert.equal(summaryState([{ state: "FAILED" }, { state: "IN_PROGRESS" }]), "IN_PROGRESS");
  assert.equal(summaryState([{ state: "FAILED" }, { state: "FAILED" }]), "FAILED");
});

test("buildSummary counts repositories, not attempts", () => {
  const summary = buildSummary(buildRows(migrations, repos).rows, ["org-a", "org-b"]);
  assert.equal(summary.kpis.total, 2);
  assert.equal(summary.kpis.succeeded, 1);
  assert.equal(summary.kpis.failed, 1);
  assert.equal(summary.kpis.successRate, 0.5);
  assert.equal(summary.workflows.total, 2);
});

test("buildSummary groups by team and organization", () => {
  const summary = buildSummary(buildRows(migrations, repos).rows, []);
  const payments = summary.teams.find((t) => t.key === "Payments");
  assert.equal(payments.succeeded, 1);
  assert.deepEqual(payments.workflows, { succeeded: 1, failing: 0, idle: 1 });
  assert.equal(summary.teams.find((t) => t.key === "Unassigned").failed, 1);
  assert.equal(summary.orgs.length, 2);
});

test("buildSummary averages per repository", () => {
  const summary = buildSummary(buildRows(migrations, repos).rows, []);
  assert.equal(summary.kpis.avgRepoSizeMB, 30); // (50 + 10) / 2
  assert.equal(summary.kpis.avgDurationMinutes, 14);
});

test("sourceKey normalises an origin and ignores placeholder URLs", () => {
  assert.equal(sourceKey("https://gitlab.dev/gl/Widgets.git"), "gitlab.dev/gl/widgets");
  assert.equal(sourceKey("https://gitlab.dev/gl/widgets/"), "gitlab.dev/gl/widgets");
  // Placeholders carry no path and must never correlate unrelated repositories.
  assert.equal(sourceKey("https://not-used"), null);
  assert.equal(sourceKey("https://not-used/"), null);
  assert.equal(sourceKey(null), null);
  assert.equal(sourceKey("nonsense"), null);
});

test("a failure is superseded when the same source later lands elsewhere", () => {
  const log = [
    { id: "M1", org: "o", repository: "api-attempt1", state: "FAILED", createdAt: "2026-01-01T00:00:00Z", sourceUrl: "https://gitlab.dev/gl/api" },
    { id: "M2", org: "o", repository: "api-attempt2", state: "SUCCEEDED", createdAt: "2026-02-01T00:00:00Z", sourceUrl: "https://gitlab.dev/gl/api" },
  ];
  const { rows } = buildRows(log, {});
  const failed = rows.find((r) => r.id === "o/api-attempt1");

  assert.equal(failed.state, "SUPERSEDED");
  assert.equal(failed.supersededBy, "o/api-attempt2");
  assert.equal(rows.find((r) => r.id === "o/api-attempt2").state, "SUCCEEDED");
});

test("a superseded row counts as neither a success nor a failure", () => {
  const log = [
    { id: "M1", org: "o", repository: "api-attempt1", state: "FAILED", createdAt: "2026-01-01T00:00:00Z", sourceUrl: "https://gitlab.dev/gl/api" },
    { id: "M2", org: "o", repository: "api-attempt2", state: "SUCCEEDED", createdAt: "2026-02-01T00:00:00Z", sourceUrl: "https://gitlab.dev/gl/api" },
  ];
  const summary = buildSummary(buildRows(log, {}).rows, []);
  assert.equal(summary.kpis.succeeded, 1);
  assert.equal(summary.kpis.failed, 0);
  assert.equal(summary.kpis.successRate, 1);
  assert.equal(summary.kpis.total, 2); // still listed
});

test("a failure after the last success is not superseded", () => {
  const log = [
    { id: "M1", org: "o", repository: "api-old", state: "SUCCEEDED", createdAt: "2026-01-01T00:00:00Z", sourceUrl: "https://gitlab.dev/gl/api" },
    { id: "M2", org: "o", repository: "api-new", state: "FAILED", createdAt: "2026-02-01T00:00:00Z", sourceUrl: "https://gitlab.dev/gl/api" },
  ];
  const { rows } = buildRows(log, {});
  assert.equal(rows.find((r) => r.id === "o/api-new").state, "FAILED");
});

test("placeholder sources never supersede each other", () => {
  const log = [
    { id: "M1", org: "o", repository: "a", state: "FAILED", createdAt: "2026-01-01T00:00:00Z", sourceUrl: "https://not-used" },
    { id: "M2", org: "o", repository: "b", state: "SUCCEEDED", createdAt: "2026-02-01T00:00:00Z", sourceUrl: "https://not-used" },
  ];
  const { rows } = buildRows(log, {});
  assert.equal(rows.find((r) => r.id === "o/a").state, "FAILED");
});

const DAY = 24 * 60 * 60 * 1000;
const WINDOW = 60 * DAY;

const onboardingLog = [
  { id: "M1", org: "o", repository: "api", state: "SUCCEEDED", createdAt: "2026-01-01T00:00:00Z" },
];

function repoWith(workflows) {
  return { "o/api": { org: "o", repository: "api", deletedAt: null, workflows } };
}

test("the window is anchored on the first successful attempt, not the last", () => {
  const log = [
    { id: "M1", org: "o", repository: "api", state: "FAILED", createdAt: "2026-01-01T00:00:00Z" },
    { id: "M2", org: "o", repository: "api", state: "SUCCEEDED", createdAt: "2026-02-01T00:00:00Z" },
    { id: "M3", org: "o", repository: "api", state: "SUCCEEDED", createdAt: "2026-03-01T00:00:00Z" },
  ];
  const { rows } = buildRows(log, {});
  assert.equal(rows[0].migratedAt, "2026-02-01T00:00:00Z");
});

test("a repository inside its window is still onboarding", () => {
  const { rows } = buildRows(onboardingLog, repoWith({ "ci.yml": { name: "CI", status: "idle" } }), {
    windowMs: WINDOW,
    now: Date.parse("2026-01-20T00:00:00Z"),
  });
  assert.equal(rows[0].onboarding, "in-progress");
});

test("a window that closes with every workflow green is onboarded", () => {
  const { rows } = buildRows(
    onboardingLog,
    repoWith({ "ci.yml": { name: "CI", status: "succeeded" } }),
    { windowMs: WINDOW, now: Date.parse("2026-06-01T00:00:00Z") },
  );
  assert.equal(rows[0].onboarding, "complete");
});

test("a window that closes with a workflow never green is incomplete", () => {
  // Closing the window must not declare success — this is the actionable list.
  const { rows } = buildRows(
    onboardingLog,
    repoWith({ "ci.yml": { name: "CI", status: "idle" } }),
    { windowMs: WINDOW, now: Date.parse("2026-06-01T00:00:00Z") },
  );
  assert.equal(rows[0].onboarding, "incomplete");
});

test("a repository with no workflows at all is onboarded, not incomplete", () => {
  const { rows } = buildRows(onboardingLog, repoWith({}), {
    windowMs: WINDOW,
    now: Date.parse("2026-06-01T00:00:00Z"),
  });
  assert.equal(rows[0].onboarding, "complete");
});

test("a workflow added after the window is reported but excluded from migration metrics", () => {
  const repos = repoWith({
    "ci.yml": { name: "CI", status: "succeeded" },
    "later.yml": { name: "Later", status: "idle", firstSeenAt: "2026-09-01T00:00:00Z" },
  });
  const { rows, detail } = buildRows(onboardingLog, repos, {
    windowMs: WINDOW,
    now: Date.parse("2026-10-01T00:00:00Z"),
  });

  assert.deepEqual(rows[0].workflows, { succeeded: 1, failing: 0, idle: 0, manual: 0, postOnboarding: 1 });
  assert.equal(rows[0].onboarding, "complete");

  // Still listed, so nobody thinks the workflow is missing.
  const workflows = detail.get(rows[0].d)["o/api"].workflows;
  assert.equal(workflows.find((w) => w.name === "Later").onboarding, false);
  assert.equal(workflows.find((w) => w.name === "CI").onboarding, true);
});

test("a repository whose only workflow is manual is onboarded, not incomplete", () => {
  // Nothing triggers it, so it can sit idle forever without anything being wrong.
  const { rows, detail } = buildRows(
    onboardingLog,
    repoWith({ "deploy.yml": { name: "Deploy", status: "idle", manual: true } }),
    { windowMs: WINDOW, now: Date.parse("2026-06-01T00:00:00Z") },
  );

  assert.equal(rows[0].workflows.manual, 1);
  assert.equal(rows[0].workflows.idle, 0);
  assert.equal(rows[0].onboarding, "complete");
  assert.equal(detail.get(rows[0].d)["o/api"].workflows[0].manual, true);
});

test("buildSummary rolls up onboarding status", () => {
  const summary = buildSummary(
    buildRows(onboardingLog, repoWith({ "ci.yml": { name: "CI", status: "failing" } }), {
      windowMs: WINDOW,
      now: Date.parse("2026-06-01T00:00:00Z"),
    }).rows,
    [],
  );
  assert.deepEqual(summary.onboarding, { inProgress: 0, complete: 0, incomplete: 1 });
});
