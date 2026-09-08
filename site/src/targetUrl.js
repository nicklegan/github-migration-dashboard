// Builds the link to a migrated repository on the destination instance.
// Pure logic, no React, so it unit-tests directly.
//
// A link is only offered for a repository that is there to be visited, which
// the action reports as `exists` from what it actually observed. Migration
// state alone is not that answer: an aborted or expired live migration can
// leave the repository on the target, and a GEI success can be deleted later.
// Data written before the action reported `exists` falls back to the state.
function targetUrl(serverUrl, row) {
  if (!serverUrl || !row) return null;

  const exists = row.exists ?? (row.state === "SUCCEEDED" && !row.removed);
  if (!exists) return null;

  const org = String(row.organization ?? "").trim();
  const repo = String(row.repository ?? "").trim();
  if (!org || !repo) return null;

  const base = String(serverUrl).replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
}

export { targetUrl };
