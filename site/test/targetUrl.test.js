import test from "node:test";
import assert from "node:assert/strict";
import { targetUrl } from "../src/targetUrl.js";

const succeeded = {
  organization: "acme",
  repository: "widgets",
  state: "SUCCEEDED",
  removed: false,
  exists: true,
};

test("links a successful migration to its repository on the target host", () => {
  assert.equal(targetUrl("https://acme.ghe.com", succeeded), "https://acme.ghe.com/acme/widgets");
});

test("tolerates a trailing slash on the server URL", () => {
  assert.equal(targetUrl("https://github.com/", succeeded), "https://github.com/acme/widgets");
});

// An aborted or expired live migration can still leave the repository on the
// target, so what the action observed outranks how the migration ended.
test("links a failed migration whose repository is there anyway", () => {
  const live = { ...succeeded, state: "FAILED", exists: true };
  assert.equal(targetUrl("https://acme.ghe.com", live), "https://acme.ghe.com/acme/widgets");
});

test("does not link a repository the action could not find", () => {
  assert.equal(targetUrl("https://github.com", { ...succeeded, exists: false }), null);
});

test("does not link a repository that was removed after migrating", () => {
  assert.equal(
    targetUrl("https://github.com", { ...succeeded, removed: true, exists: false }),
    null,
  );
});

// Rows written before the action reported `exists` still have to resolve.
test("older rows fall back to the migration state", () => {
  const legacy = { organization: "acme", repository: "widgets", state: "SUCCEEDED" };
  assert.equal(targetUrl("https://github.com", legacy), "https://github.com/acme/widgets");
  assert.equal(targetUrl("https://github.com", { ...legacy, removed: true }), null);
  for (const state of ["FAILED", "SUPERSEDED", "IN_PROGRESS", "QUEUED"]) {
    assert.equal(targetUrl("https://github.com", { ...legacy, state }), null);
  }
});

test("does not link when the payload carries no server URL", () => {
  assert.equal(targetUrl(null, succeeded), null);
  assert.equal(targetUrl("", succeeded), null);
});

test("does not link an incomplete row", () => {
  assert.equal(targetUrl("https://github.com", null), null);
  assert.equal(targetUrl("https://github.com", { ...succeeded, organization: "" }), null);
  assert.equal(targetUrl("https://github.com", { ...succeeded, repository: null }), null);
});

test("escapes segments so an odd name cannot break out of the path", () => {
  assert.equal(
    targetUrl("https://github.com", { ...succeeded, repository: "a b/../c" }),
    "https://github.com/acme/a%20b%2F..%2Fc",
  );
});
