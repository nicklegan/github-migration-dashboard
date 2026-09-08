import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSummary } from "../src/api.js";

// This mapping used to allowlist fields, which meant a field added to the
// summary reached the browser as undefined and the feature that depended on it
// rendered nothing at all — no error, no empty state, just absence.
test("every field the action writes reaches the dashboard", () => {
  const payload = {
    generatedAt: "2026-09-03T10:00:00Z",
    serverUrl: "https://acme.ghe.com",
    enterprise: "acme",
    organizations: ["org-a"],
    onboardingWindowDays: 60,
    removed: 15,
    teamLabel: "Business unit",
    kpis: { total: 170 },
    onboarding: { inProgress: 8, complete: 137, incomplete: 22 },
    workflows: { total: 44, manual: 12 },
    states: [{ state: "SUCCEEDED", count: 167 }],
    teams: [{ key: "Payments" }],
    orgs: [{ key: "org-a" }],
  };

  assert.deepEqual(normalizeSummary(payload), payload);
});

test("a field the dashboard does not know about is still carried through", () => {
  const next = normalizeSummary({ somethingAddedLater: { deep: true } });
  assert.deepEqual(next.somethingAddedLater, { deep: true });
});

test("an older payload without the newer fields still renders", () => {
  // Data written by a previous version of the action must not break the page.
  const summary = normalizeSummary({ kpis: { total: 5 } });

  assert.equal(summary.removed, 0, "no toggle rather than a broken comparison");
  assert.equal(summary.onboardingWindowDays, 0, "onboarding bank hidden");
  assert.equal(summary.teamLabel, "Team", "headings still have a word to print");
  assert.deepEqual(summary.states, []);
  assert.deepEqual(summary.teams, []);
  assert.deepEqual(summary.orgs, []);
  assert.equal(summary.generatedAt, null);
});

test("the removed toggle only shows when something was removed", () => {
  // The condition the control renders on, asserted directly.
  assert.equal(normalizeSummary({}).removed > 0, false);
  assert.equal(normalizeSummary({ removed: 15 }).removed > 0, true);
});
