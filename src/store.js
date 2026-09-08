import fs from "node:fs";
import path from "node:path";

// Reads and writes the sharded data store. The layout separates an immutable
// event log from mutable current state so a run only rewrites what it touched:
//
//   state.json              cursors and bookkeeping
//   migrations/YYYY-MM.json append-only migration events, frozen once the month
//                           closes and every row in it is terminal
//   repos/<00-ff>.json      current repository state (team, size, workflows)
//   summary.json            precomputed aggregates for the dashboard
//   rows.json               denormalized rows the dashboard tables read

const SCHEMA = 2;
const REPO_BUCKETS = 256;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// One record per line: Git still diffs it line by line, but it is roughly half
// the size of indented JSON, which matters once the log runs to millions of rows.
function writeRecordsPerLine(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = records.map((record) => JSON.stringify(record)).join(",\n");
  fs.writeFileSync(file, records.length === 0 ? "[]\n" : `[\n${body}\n]\n`);
}

function writeEntriesPerLine(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = entries
    .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
    .join(",\n");
  fs.writeFileSync(file, entries.length === 0 ? "{}\n" : `{\n${body}\n}\n`);
}

// The published payload is rewritten every run but rarely differs. Comparing
// first turns a full rewrite into a read, which matters once the detail buckets
// run to hundreds of megabytes.
function writeIfChanged(file, body) {
  try {
    if (fs.readFileSync(file, "utf8") === body) return false;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return true;
}

// Drops files the current payload no longer contains, which a plain overwrite
// would leave behind for the dashboard to fetch.
function pruneDir(dir, keep) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!keep.has(name)) fs.rmSync(path.join(dir, name), { force: true });
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

// FNV-1a keeps bucketing stable across runs and platforms without a crypto dep.
//
// The repository store's own shard count must never change: a record is only
// ever looked up in the bucket its key hashes to, so re-hashing would read every
// repository as new and lose its workflow history. The dashboard's detail
// buckets are rebuilt from scratch every run, so those may be tuned freely.
function bucketOf(key, buckets = REPO_BUCKETS) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % buckets).toString(16).padStart(2, "0");
}

function monthOf(createdAt) {
  return String(createdAt).slice(0, 7);
}

// Rows arrive sorted by date, so the months come out in order and concatenating
// the chunks in index order reproduces that order in the browser.
function groupByMonth(rows) {
  const months = new Map();
  for (const row of rows) {
    const month = monthOf(row.createdAt) || "unknown";
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(row);
  }
  return months;
}

function byCreatedAtThenId(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

class Store {
  constructor(root) {
    this.root = root;
    this.months = new Map(); // "YYYY-MM" -> rows
    this.monthIndex = new Map(); // "YYYY-MM" -> Map(id -> position in rows)
    this.buckets = new Map(); // "ff" -> { "org/repo": record }
    this.orgIndex = null; // org -> Map(id -> row), built on first use
    this.dirtyMonths = new Set();
    this.dirtyBuckets = new Set();
  }

  // Cursors survive a schema bump. Audit history is only retained for 180 days,
  // so discarding them would not just cost a re-read — anything older than that
  // window could never be recovered. Each cursor's own shape is versioned where
  // it is read instead.
  readState() {
    const state = readJson(path.join(this.root, "state.json"), null) ?? {};
    return {
      schema: SCHEMA,
      migrationCursors: state.migrationCursors ?? {},
      // The enterprise stream has one cursor. Data written when the feed was
      // read per organization is handed over as-is; auditFeed folds it.
      auditCursor: state.auditCursor ?? state.auditCursors ?? null,
      // Where the next run starts its sweep, so a spent budget does not starve
      // the same organizations every time.
      nextOrg: state.nextOrg ?? null,
      runs: Number.isInteger(state.runs) ? state.runs : 0,
      orgBackoff: state.orgBackoff ?? {},
    };
  }

  // Returns whether anything changed. A run that reads events but touches no
  // shard still moved the audit cursor, and a cursor that is never committed
  // makes the next run re-read the same window — growing by a run each time.
  writeState(state) {
    const { auditCursors, ...rest } = state;
    const body = `${JSON.stringify({ ...rest, schema: SCHEMA }, null, 2)}\n`;
    return writeIfChanged(path.join(this.root, "state.json"), body);
  }

  monthFile(month) {
    return path.join(this.root, "migrations", `${month}.json`);
  }

  loadMonth(month) {
    if (!this.months.has(month)) {
      const rows = readJson(this.monthFile(month), []);
      this.months.set(month, rows);
      // Looked up by id on every put, so a first-run import of a busy month
      // would otherwise scan the array once per row.
      this.monthIndex.set(month, new Map(rows.map((row, i) => [row.id, i])));
    }
    return this.months.get(month);
  }

  // Unions what is on disk with shards this run created, so a first run can read
  // back what it just collected before anything has been flushed.
  listMonths() {
    const months = new Set(this.months.keys());
    try {
      for (const name of fs.readdirSync(path.join(this.root, "migrations"))) {
        if (name.endsWith(".json")) months.add(name.slice(0, -5));
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    return [...months].sort();
  }

  allMigrations() {
    return this.listMonths().flatMap((month) => this.loadMonth(month));
  }

  // One organization's migrations. Syncing an organization needs these several
  // times, and filtering the whole log for each would make a run cost
  // O(organizations x log) — 11 seconds at 300k migrations across 200 orgs.
  migrationsFor(org) {
    if (!this.orgIndex) {
      this.orgIndex = new Map();
      for (const row of this.allMigrations()) this.indexMigration(row);
    }
    const byId = this.orgIndex.get(org);
    return byId ? [...byId.values()] : [];
  }

  indexMigration(row) {
    if (!this.orgIndex) return; // not built yet; it will pick this row up
    let byId = this.orgIndex.get(row.org);
    if (!byId) this.orgIndex.set(row.org, (byId = new Map()));
    byId.set(row.id, row);
  }

  getMigration(id, createdAt) {
    const month = monthOf(createdAt);
    const rows = this.loadMonth(month);
    const index = this.monthIndex.get(month).get(id);
    return index === undefined ? null : rows[index];
  }

  putMigration(row) {
    const month = monthOf(row.createdAt);
    const rows = this.loadMonth(month);
    const ids = this.monthIndex.get(month);
    const index = ids.get(row.id);
    if (index === undefined) {
      ids.set(row.id, rows.length);
      rows.push(row);
    } else {
      rows[index] = row;
    }
    this.indexMigration(row);
    this.dirtyMonths.add(month);
  }

  bucketFile(bucket) {
    return path.join(this.root, "repos", `${bucket}.json`);
  }

  loadBucket(bucket) {
    if (!this.buckets.has(bucket)) {
      this.buckets.set(bucket, readJson(this.bucketFile(bucket), {}));
    }
    return this.buckets.get(bucket);
  }

  getRepo(key) {
    return this.loadBucket(bucketOf(key))[key] ?? null;
  }

  putRepo(key, record) {
    const bucket = bucketOf(key);
    this.loadBucket(bucket)[key] = record;
    this.dirtyBuckets.add(bucket);
  }

  allRepos() {
    const buckets = new Set(this.buckets.keys());
    try {
      for (const name of fs.readdirSync(path.join(this.root, "repos"))) {
        if (name.endsWith(".json")) buckets.add(name.slice(0, -5));
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    const all = {};
    for (const bucket of buckets) Object.assign(all, this.loadBucket(bucket));
    return all;
  }

  // Writes only the shards this run touched, so closed months and untouched
  // repository buckets stay byte-identical in Git.
  flush() {
    const written = [];
    for (const month of this.dirtyMonths) {
      writeRecordsPerLine(this.monthFile(month), [...this.loadMonth(month)].sort(byCreatedAtThenId));
      written.push(`migrations/${month}.json`);
    }
    for (const bucket of this.dirtyBuckets) {
      const entries = Object.entries(this.loadBucket(bucket)).sort(([a], [b]) => (a < b ? -1 : 1));
      writeEntriesPerLine(this.bucketFile(bucket), entries);
      written.push(`repos/${bucket}.json`);
    }
    this.dirtyMonths.clear();
    this.dirtyBuckets.clear();
    return written;
  }

  writeSummary(summary) {
    writeJson(path.join(this.root, "summary.json"), summary);
  }

  // Rows are chunked so the browser can stream them in and show progress rather
  // than blocking on one multi-megabyte download.
  //
  // Chunking by month rather than by position keeps a chunk's contents stable:
  // indexing a list sorted by date means one migration discovered out of order
  // shifts every chunk after it, and a rewrite of half the payload lands in the
  // commit even though almost nothing changed.
  writeRowChunks(meta, rows, chunkSize = 2000) {
    const dir = path.join(this.root, "rows");
    fs.mkdirSync(dir, { recursive: true });

    const chunks = [];
    let written = 0;
    for (const [month, monthRows] of groupByMonth(rows)) {
      for (let i = 0; i < monthRows.length; i += chunkSize) {
        const name = `${month}.${i / chunkSize}.json`;
        const body = `${JSON.stringify(monthRows.slice(i, i + chunkSize))}\n`;
        if (writeIfChanged(path.join(dir, name), body)) written += 1;
        chunks.push(name);
      }
    }

    pruneDir(dir, new Set([...chunks, "index.json"]));
    writeJson(path.join(dir, "index.json"), { ...meta, total: rows.length, chunkSize, chunks });
    return { chunks: chunks.length, written };
  }

  // One file per repository bucket, fetched only when a row is expanded.
  writeDetail(detail) {
    const dir = path.join(this.root, "detail");
    fs.mkdirSync(dir, { recursive: true });

    const keep = new Set();
    let written = 0;
    for (const [bucket, records] of detail) {
      const name = `${bucket}.json`;
      keep.add(name);
      if (writeIfChanged(path.join(dir, name), `${JSON.stringify(records)}\n`)) written += 1;
    }

    pruneDir(dir, keep);
    return { buckets: detail.size, written };
  }
}

export { Store, bucketOf, monthOf, groupByMonth, SCHEMA, REPO_BUCKETS };
