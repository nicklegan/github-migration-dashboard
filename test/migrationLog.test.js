import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMigrationLog, durationFromLog, fetchMigrationLogDuration } from "../src/migrationLog.js";

// Verbatim log of a migration run on 2026-09-10 (sandbox/gei-probe-1789070986).
const SUCCEEDED = `[2026-09-10T20:10:27Z] INFO -- Migration started by n from https://nicklegan.ghe.com/gl2gh-migrations/github-org-repo-metrics-action to sandbox/gei-probe-1789070986
[2026-09-10T20:10:27Z] INFO -- Migration ID: 5bea4ddf-d939-429b-b78b-7c3926b33508
[2026-09-10T20:10:28Z] INFO -- -----------------------------
[2026-09-10T20:10:31Z] INFO -- Git source migration started
[2026-09-10T20:11:33Z] INFO -- Git source migration completed
[2026-09-10T20:11:33Z] INFO -- -----------------------------
[2026-09-10T20:11:38Z] INFO -- Extraction started
[2026-09-10T20:12:00Z] INFO -- Extraction complete
[2026-09-10T20:12:00Z] INFO -- -----------------------------
[2026-09-10T20:12:04Z] INFO -- Transformation started
[2026-09-10T20:12:22Z] INFO -- Transformation complete
[2026-09-10T20:12:22Z] INFO -- -----------------------------
[2026-09-10T20:12:26Z] INFO -- Import started
[2026-09-10T20:12:58Z] INFO -- Import complete
[2026-09-10T20:12:58Z] INFO -- -----------------------------
[2026-09-10T20:12:58Z] INFO -- Migration complete
[2026-09-10T20:12:58Z] INFO -- -----------------------------
`;

const FAILED = `[2026-09-10T19:53:49Z] INFO -- Migration started by n from https://github.com/0ctocat/ghec-team-as-code-action to sandbox/gei-probe-1789070023
[2026-09-10T19:53:49Z] INFO -- Migration ID: cad81ed1-1235-40b4-b8d6-e174aa26e4fa
[2026-09-10T19:53:50Z] INFO -- Git source migration started
[2026-09-10T19:57:07Z] ERROR -- Git source migration failed. Error message: the server responded with status 403 Error class: Faraday::ForbiddenError.
[2026-09-10T19:57:07Z] INFO -- Migration failed
`;

test("every phase boundary in a successful log is picked up", () => {
  const phases = parseMigrationLog(SUCCEEDED);
  assert.deepEqual(phases, {
    startedAt: Date.parse("2026-09-10T20:10:27Z"),
    gitStartedAt: Date.parse("2026-09-10T20:10:31Z"),
    gitCompletedAt: Date.parse("2026-09-10T20:11:33Z"),
    completedAt: Date.parse("2026-09-10T20:12:58Z"),
  });
});

test("the duration runs from the log's start to its completion line", () => {
  const result = durationFromLog(parseMigrationLog(SUCCEEDED));
  // 2m31s total, 1m02s of git.
  assert.deepEqual(result, { durationMinutes: 3, durationSource: "log", gitMinutes: 1 });
});

test("a failed or unfinished log yields no duration", () => {
  const failed = parseMigrationLog(FAILED);
  assert.equal(failed.completedAt, undefined);
  assert.ok(failed.failedAt);
  assert.equal(durationFromLog(failed), null);

  const running = SUCCEEDED.split("Import started")[0];
  assert.equal(durationFromLog(parseMigrationLog(running)), null);
});

test("something that is not a migration log is recognised as such", () => {
  assert.equal(parseMigrationLog("<html>AccessDenied</html>"), null);
  assert.equal(parseMigrationLog(""), null);
  assert.equal(durationFromLog(null), null);
});

// The presigned URL is gone after five days; that is expected, not an error.
test("an expired or unreachable log is simply undated", async () => {
  const gone = await fetchMigrationLogDuration("https://x/log", {
    fetchImpl: async () => ({ ok: false, status: 403, text: async () => "" }),
  });
  assert.equal(gone, null);

  const down = await fetchMigrationLogDuration("https://x/log", {
    fetchImpl: async () => {
      throw new Error("ECONNRESET");
    },
  });
  assert.equal(down, null);

  assert.equal(await fetchMigrationLogDuration(null), null);
});

test("a readable log is fetched without credentials and parsed", async () => {
  const asked = [];
  const result = await fetchMigrationLogDuration("https://objects/log?X-Amz-Signature=abc", {
    fetchImpl: async (url, init) => {
      asked.push({ url, init });
      return { ok: true, status: 200, text: async () => SUCCEEDED };
    },
  });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].init, undefined, "no headers, the URL is presigned");
  assert.equal(result.durationMinutes, 3);
  assert.equal(result.durationSource, "log");
});
