import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, bucketOf, monthOf } from "../src/store.js";

function tempStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "migration-store-"));
  return { store: new Store(root), root };
}

const migration = (id, createdAt) => ({
  id,
  org: "org-a",
  repository: `repo-${id}`,
  state: "SUCCEEDED",
  createdAt,
});

// Row chunks are grouped by migration month, so a row needs a date.
const row = (id, createdAt = "2026-01-01T00:00:00Z") => ({ id, createdAt });

test("shards created this run are readable before any flush", () => {
  const { store } = tempStore();
  store.putMigration(migration("M1", "2026-01-05T00:00:00Z"));
  store.putRepo("org-a/repo-M1", { org: "org-a", repository: "repo-M1", workflows: {} });

  // The first run must be able to read back what it just collected, otherwise
  // later phases see an empty store and skip their work.
  assert.equal(store.allMigrations().length, 1);
  assert.deepEqual(Object.keys(store.allRepos()), ["org-a/repo-M1"]);
});

test("migrations are partitioned by month and round-trip through disk", () => {
  const { store, root } = tempStore();
  store.putMigration(migration("M1", "2026-01-05T00:00:00Z"));
  store.putMigration(migration("M2", "2026-02-05T00:00:00Z"));
  const written = store.flush();

  assert.deepEqual(written.sort(), ["migrations/2026-01.json", "migrations/2026-02.json"].sort());

  const reopened = new Store(root);
  assert.equal(reopened.allMigrations().length, 2);
  assert.deepEqual(reopened.listMonths(), ["2026-01", "2026-02"]);
});

test("only touched shards are rewritten", () => {
  const { store, root } = tempStore();
  store.putMigration(migration("M1", "2026-01-05T00:00:00Z"));
  store.putMigration(migration("M2", "2026-02-05T00:00:00Z"));
  store.flush();

  const januaryBefore = fs.statSync(path.join(root, "migrations", "2026-01.json")).mtimeMs;

  const second = new Store(root);
  second.putMigration(migration("M3", "2026-02-06T00:00:00Z"));
  const written = second.flush();

  assert.deepEqual(written, ["migrations/2026-02.json"]);
  assert.equal(fs.statSync(path.join(root, "migrations", "2026-01.json")).mtimeMs, januaryBefore);
});

test("a re-put migration replaces rather than duplicates", () => {
  const { store } = tempStore();
  store.putMigration(migration("M1", "2026-01-05T00:00:00Z"));
  store.putMigration({ ...migration("M1", "2026-01-05T00:00:00Z"), state: "FAILED" });
  assert.equal(store.allMigrations().length, 1);
  assert.equal(store.getMigration("M1", "2026-01-05T00:00:00Z").state, "FAILED");
});

test("state survives a round trip, and a schema change keeps the cursors", () => {
  const { store, root } = tempStore();
  store.writeState({ migrationCursors: { "org-a": "cursor-1" }, auditCursor: { at: 3 } });
  assert.equal(new Store(root).readState().migrationCursors["org-a"], "cursor-1");
  assert.deepEqual(new Store(root).readState().auditCursor, { at: 3 });

  // Audit history is only retained for 180 days, so discarding a cursor is not
  // just a re-read — anything older than that could never be recovered. Data
  // written with a cursor per organization is handed over for auditFeed to fold.
  fs.writeFileSync(
    path.join(root, "state.json"),
    JSON.stringify({ schema: 1, migrationCursors: { x: "y" }, auditCursors: { "org-a": { at: 7 } } }),
  );
  const migrated = new Store(root).readState();
  assert.deepEqual(migrated.migrationCursors, { x: "y" });
  assert.deepEqual(migrated.auditCursor, { "org-a": { at: 7 } });
  assert.equal(migrated.schema, 2);
});

test("the sweep position and run count round trip", () => {
  const { store, root } = tempStore();
  store.writeState({ migrationCursors: {}, nextOrg: "org-m", runs: 4 });

  const state = new Store(root).readState();
  assert.equal(state.nextOrg, "org-m");
  assert.equal(state.runs, 4);

  const fresh = new Store(tempStore().root).readState();
  assert.equal(fresh.nextOrg, null);
  assert.equal(fresh.runs, 0);
});

// A run that touches no shard can still have moved the audit cursor, and a
// cursor that is never committed makes the next run re-read the same window.
test("writeState reports whether the state changed", () => {
  const { store } = tempStore();
  const state = { migrationCursors: {}, auditCursor: { at: 1 } };

  assert.equal(store.writeState(state), true);
  assert.equal(store.writeState(state), false);
  assert.equal(store.writeState({ ...state, auditCursor: { at: 2 } }), true);
});

test("shards are written one record per line for reviewable diffs", () => {
  const { store, root } = tempStore();
  store.putMigration(migration("M1", "2026-01-05T00:00:00Z"));
  store.putMigration(migration("M2", "2026-01-06T00:00:00Z"));
  store.flush();

  const raw = fs.readFileSync(path.join(root, "migrations", "2026-01.json"), "utf8");
  const lines = raw.trim().split("\n");
  assert.equal(lines[0], "[");
  assert.equal(lines.at(-1), "]");
  assert.equal(lines.length, 4); // bracket + one record per line + bracket
  assert.deepEqual(
    JSON.parse(raw).map((row) => row.id),
    ["M1", "M2"],
  );
});

test("bucketing is stable and spreads keys", () => {
  assert.equal(bucketOf("org-a/api"), bucketOf("org-a/api"));
  assert.match(bucketOf("org-a/api"), /^[0-9a-f]{2}$/);
  const buckets = new Set();
  for (let i = 0; i < 500; i += 1) buckets.add(bucketOf(`org/repo-${i}`));
  assert.ok(buckets.size > 100, `expected wide spread, got ${buckets.size}`);
});

test("monthOf partitions on the creation month", () => {
  assert.equal(monthOf("2026-04-08T13:05:17Z"), "2026-04");
});

test("migrationsFor returns one organization's rows without scanning the log", () => {
  const { store } = tempStore();
  store.putMigration({ id: "A", org: "one", repository: "a", state: "SUCCEEDED", createdAt: "2026-01-01T00:00:00Z" });
  store.putMigration({ id: "B", org: "two", repository: "b", state: "FAILED", createdAt: "2026-01-02T00:00:00Z" });
  store.putMigration({ id: "C", org: "one", repository: "c", state: "SUCCEEDED", createdAt: "2026-02-01T00:00:00Z" });

  assert.deepEqual(store.migrationsFor("one").map((r) => r.id).sort(), ["A", "C"]);
  assert.deepEqual(store.migrationsFor("two").map((r) => r.id), ["B"]);
  assert.deepEqual(store.migrationsFor("absent"), []);
});

test("the organization index stays correct as rows are added and replaced", () => {
  const { store } = tempStore();
  store.putMigration({ id: "A", org: "one", repository: "a", state: "QUEUED", createdAt: "2026-01-01T00:00:00Z" });
  assert.equal(store.migrationsFor("one")[0].state, "QUEUED"); // builds the index

  store.putMigration({ id: "A", org: "one", repository: "a", state: "SUCCEEDED", createdAt: "2026-01-01T00:00:00Z" });
  store.putMigration({ id: "D", org: "one", repository: "d", state: "SUCCEEDED", createdAt: "2026-01-03T00:00:00Z" });

  const rows = store.migrationsFor("one");
  assert.equal(rows.length, 2, "an update must not duplicate the row");
  assert.equal(rows.find((r) => r.id === "A").state, "SUCCEEDED");
});

test("an unchanged payload is not rewritten", () => {
  // The detail buckets run to hundreds of megabytes at scale and rarely differ,
  // so a run that changes nothing must not rewrite them.
  const { store } = tempStore();
  const meta = { generatedAt: "2026-01-01T00:00:00Z" };
  const rows = [row("org/a"), row("org/b")];
  const detail = new Map([["ab", { "org/a": { attempts: [] } }]]);

  assert.deepEqual(store.writeRowChunks(meta, rows, 10), { chunks: 1, written: 1 });
  assert.deepEqual(store.writeDetail(detail), { buckets: 1, written: 1 });

  assert.deepEqual(store.writeRowChunks(meta, rows, 10), { chunks: 1, written: 0 });
  assert.deepEqual(store.writeDetail(detail), { buckets: 1, written: 0 });
});

test("a changed payload is rewritten and stale files are dropped", () => {
  const { store, root } = tempStore();
  const meta = { generatedAt: "2026-01-01T00:00:00Z" };

  store.writeRowChunks(meta, [row("a"), row("b"), row("c")], 1);
  assert.equal(fs.readdirSync(path.join(root, "rows")).length, 4); // 3 chunks + index

  // Fewer rows must not leave an orphan chunk the dashboard would still fetch.
  const after = store.writeRowChunks(meta, [row("a")], 1);
  assert.equal(after.chunks, 1);
  assert.deepEqual(fs.readdirSync(path.join(root, "rows")).sort(), ["2026-01.0.json", "index.json"]);

  store.writeDetail(new Map([["ab", { x: 1 }]]));
  assert.equal(store.writeDetail(new Map([["ab", { x: 2 }]])).written, 1);
  assert.deepEqual(fs.readdirSync(path.join(root, "detail")), ["ab.json"]);
});

// Indexing a date-sorted list meant one migration discovered out of order
// shifted every chunk after it, so a rewrite of half the payload landed in the
// commit even though almost nothing had changed.
test("a row inserted in the past only rewrites its own month", () => {
  const { store } = tempStore();
  const meta = { generatedAt: "2026-01-01T00:00:00Z" };
  const later = [row("b", "2026-02-01T00:00:00Z"), row("c", "2026-03-01T00:00:00Z")];

  store.writeRowChunks(meta, later, 10);
  const after = store.writeRowChunks(meta, [row("a", "2026-01-01T00:00:00Z"), ...later], 10);

  assert.equal(after.chunks, 3, "one chunk per month");
  assert.equal(after.written, 1, "only the new month is written");
});

test("a month larger than the chunk size splits into parts", () => {
  const { store } = tempStore();
  const rows = [row("a"), row("b"), row("c")];

  const { chunks } = store.writeRowChunks({}, rows, 2);
  assert.equal(chunks, 2);
});

// A first-run import of a busy month used to scan the array once per row.
test("putMigration stays linear on a large month", () => {
  const { store } = tempStore();
  const time = (n) => {
    const s = new Store(tempStore().root);
    const t = performance.now();
    for (let i = 0; i < n; i += 1) s.putMigration(migration(`M${i}`, "2026-06-01T00:00:00Z"));
    return performance.now() - t;
  };

  const small = time(5000);
  const large = time(20000);
  assert.ok(large < small * 10, `4x rows took ${(large / small).toFixed(1)}x as long`);
  assert.equal(store.allMigrations().length, 0);
});

test("a replaced migration keeps its position and its lookup", () => {
  const { store } = tempStore();
  store.putMigration(migration("M1", "2026-01-05T00:00:00Z"));
  store.putMigration(migration("M2", "2026-01-06T00:00:00Z"));
  store.putMigration({ ...migration("M1", "2026-01-05T00:00:00Z"), state: "FAILED" });

  assert.equal(store.allMigrations().length, 2);
  assert.equal(store.getMigration("M1", "2026-01-05T00:00:00Z").state, "FAILED");
  assert.equal(store.getMigration("M2", "2026-01-06T00:00:00Z").id, "M2");
  assert.equal(store.getMigration("nope", "2026-01-06T00:00:00Z"), null);
});
