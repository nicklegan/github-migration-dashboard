// Reads a migration's own log for the exact time it started and finished. The
// importer writes one line per phase:
//
//   [2026-09-10T20:10:27Z] INFO -- Migration started by n from <source> to <target>
//   [2026-09-10T20:10:31Z] INFO -- Git source migration started
//   [2026-09-10T20:11:33Z] INFO -- Git source migration completed
//   ...extraction, transformation, import...
//   [2026-09-10T20:12:58Z] INFO -- Migration complete
//
// This is the only record of when a migration actually finished: the GraphQL
// object carries just createdAt, and the audit log's last trace (Actions being
// enabled) is not emitted on every migration path. The URL is presigned and
// expires five days after the migration, so a log is fetched the first time a
// migration is seen SUCCEEDED and the result kept; nothing older can be dated
// this way and falls back to the audit log.
//
// Fetching the log is a plain object-storage download, not an API request, so
// it counts against no rate limit.

const LINE = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\]\s+\w+\s+--\s+(.*)$/;

const MARKERS = {
  startedAt: /^Migration started\b/,
  gitStartedAt: /^Git source migration started$/,
  gitCompletedAt: /^Git source migration completed$/,
  completedAt: /^Migration complete$/,
  failedAt: /^Migration failed$/,
};

// Pure. Returns the phase timestamps found, as epoch milliseconds, or null when
// the text is not a migration log at all.
function parseMigrationLog(text) {
  const found = {};
  let any = false;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = LINE.exec(line.trim());
    if (!match) continue;
    any = true;
    const [, stamp, message] = match;
    for (const [key, pattern] of Object.entries(MARKERS)) {
      if (found[key] == null && pattern.test(message)) found[key] = Date.parse(stamp);
    }
  }
  return any ? found : null;
}

// Pure. Turns parsed phases into the fields stored on a migration row. A log
// without a completion line (still running, or failed) yields nothing.
function durationFromLog(phases) {
  if (!phases?.startedAt || !phases.completedAt) return null;
  const total = phases.completedAt - phases.startedAt;
  if (total < 0) return null;
  const result = {
    durationMinutes: Math.round(total / 60000),
    durationSource: "log",
  };
  if (phases.gitStartedAt && phases.gitCompletedAt) {
    result.gitMinutes = Math.round((phases.gitCompletedAt - phases.gitStartedAt) / 60000);
  }
  return result;
}

// Downloads and parses one log. The URL is presigned, so no credentials are
// sent. An expired URL answers 403/404; that, and any network trouble, means
// "no exact duration for this one", not a failed run.
async function fetchMigrationLogDuration(url, { fetchImpl = globalThis.fetch } = {}) {
  if (!url) return null;
  let response;
  try {
    response = await fetchImpl(url);
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const phases = parseMigrationLog(await response.text());
  return durationFromLog(phases);
}

export { parseMigrationLog, durationFromLog, fetchMigrationLogDuration };
