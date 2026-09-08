import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assembleSite } from "../src/site.js";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "site-"));
}

// Stands in for the action checkout, so GITHUB_ACTION_PATH resolves to it.
function withPrebuiltWeb(files) {
  const root = tmpdir();
  const web = path.join(root, "dist", "web");
  fs.mkdirSync(web, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(web, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return root;
}

function withDataDir(files) {
  const dir = tmpdir();
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return dir;
}

test("the published site carries the prebuilt assets and the current data", (t) => {
  const actionPath = withPrebuiltWeb({
    "index.html": "<html></html>",
    "assets/app.js": "console.log(1)",
  });
  const dataDir = withDataDir({
    "summary.json": '{"total":5}',
    "rows/0001.json": "[]",
    "detail/ab.json": "{}",
    // Part of the store, not the payload.
    "state.json": "{}",
    "migrations/2026-01.json": "[]",
  });
  t.after(() => process.env.GITHUB_ACTION_PATH === actionPath && delete process.env.GITHUB_ACTION_PATH);
  process.env.GITHUB_ACTION_PATH = actionPath;

  const out = path.join(tmpdir(), "_site");
  assembleSite(out, dataDir);

  assert.equal(fs.readFileSync(path.join(out, "index.html"), "utf8"), "<html></html>");
  assert.equal(fs.readFileSync(path.join(out, "data/summary.json"), "utf8"), '{"total":5}');
  assert.ok(fs.existsSync(path.join(out, "data/rows/0001.json")));
  assert.ok(fs.existsSync(path.join(out, "data/detail/ab.json")));

  // The event log and repository state are the store, not the payload.
  assert.equal(fs.existsSync(path.join(out, "data/state.json")), false);
  assert.equal(fs.existsSync(path.join(out, "data/migrations")), false);
});

test("data left inside the prebuilt bundle never reaches the published site", (t) => {
  // A local run writes into dist/web/data, and copying merges rather than
  // replaces — so a stale chunk could otherwise outlive the data it came from.
  const actionPath = withPrebuiltWeb({
    "index.html": "<html></html>",
    "data/summary.json": '{"total":12,"stale":true}',
    "data/detail/ff.json": '{"gone":true}',
  });
  const dataDir = withDataDir({ "summary.json": '{"total":5}' });
  t.after(() => process.env.GITHUB_ACTION_PATH === actionPath && delete process.env.GITHUB_ACTION_PATH);
  process.env.GITHUB_ACTION_PATH = actionPath;

  const out = path.join(tmpdir(), "_site");
  assembleSite(out, dataDir);

  assert.equal(fs.readFileSync(path.join(out, "data/summary.json"), "utf8"), '{"total":5}');
  assert.equal(fs.existsSync(path.join(out, "data/detail/ff.json")), false);
});

test("a missing prebuilt bundle fails loudly", (t) => {
  const actionPath = tmpdir();
  t.after(() => process.env.GITHUB_ACTION_PATH === actionPath && delete process.env.GITHUB_ACTION_PATH);
  process.env.GITHUB_ACTION_PATH = actionPath;

  assert.throws(() => assembleSite(path.join(tmpdir(), "_site"), tmpdir()), /assets not found/);
});
