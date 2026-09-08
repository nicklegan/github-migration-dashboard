// The migration state vocabulary, shared by the action and the dashboard so the
// two cannot disagree about what counts as still running. The dashboard
// recomputes its own KPIs for cross-filtering rather than reading the action's
// summary, which is exactly how the two would otherwise drift.

// Everything the destination reports that has not settled yet.
const ONGOING_STATES = new Set([
  "PENDING",
  "QUEUED",
  "IN_PROGRESS",
  "PENDING_VALIDATION",
  "PAUSED",
]);

// Migration facts freeze once a migration reaches one of these.
const TERMINAL_STATES = new Set(["SUCCEEDED", "FAILED"]);

function isOngoing(state) {
  return ONGOING_STATES.has(state);
}

function isTerminal(state) {
  return TERMINAL_STATES.has(state);
}

export { ONGOING_STATES, TERMINAL_STATES, isOngoing, isTerminal };
