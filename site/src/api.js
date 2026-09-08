// Loads the dashboard payload. summary.json holds precomputed aggregates and
// paints immediately; rows stream in as chunks so a large estate shows progress
// instead of blocking on one multi-megabyte download; per-repository detail is
// fetched only when a row is expanded.

// How many chunk requests are in flight at once. Fetching them one after another
// meant a large estate paid a full round trip per chunk before any of it showed.
const CHUNK_CONCURRENCY = 6;

// summary.json and the chunk index decide what is current, so they are never
// served from cache. Chunk and detail bodies are revalidated instead: their
// names are stable but their contents are not, and a conditional request costs
// a round trip rather than the payload.
async function fetchJson(pathname, cache = "no-store") {
  const url = `${import.meta.env.BASE_URL}data/${pathname}`;
  const res = await fetch(url, { cache });
  if (!res.ok) throw new Error(`Failed to load ${pathname} (${res.status}).`);
  return res.json();
}

// Fills in what the dashboard needs when the payload is missing it. The spread
// comes first on purpose: an allowlist here silently dropped `removed` and the
// whole onboarding section, which failed by rendering nothing rather than by
// raising anything, so a field added to the summary must reach the dashboard
// without a change to this function.
function normalizeSummary(payload) {
  return {
    ...payload,
    generatedAt: payload.generatedAt ?? null,
    organizations: payload.organizations ?? [],
    kpis: payload.kpis ?? null,
    workflows: payload.workflows ?? null,
    states: payload.states ?? [],
    teams: payload.teams ?? [],
    orgs: payload.orgs ?? [],
    removed: payload.removed ?? 0,
    onboardingWindowDays: payload.onboardingWindowDays ?? 0,
    teamLabel: payload.teamLabel || "Team",
    serverUrl: payload.serverUrl ?? null,
    enterprise: payload.enterprise ?? null,
  };}

async function loadSummary() {
  return normalizeSummary(await fetchJson("summary.json"));
}

// Streams every row chunk, reporting progress as each arrives so the UI can show
// how much of a large estate is in. Chunks land out of order but are written
// back to their own slot, so the rows stay in the order the action wrote them.
async function loadRows(onProgress) {
  const index = await fetchJson("rows/index.json");
  const chunks = Array.isArray(index.chunks) ? index.chunks : [];
  const parts = new Array(chunks.length);
  let loaded = 0;
  let next = 0;

  async function worker() {
    while (next < chunks.length) {
      const slot = next++;
      parts[slot] = await fetchJson(`rows/${chunks[slot]}`, "no-cache");
      loaded += parts[slot].length;
      onProgress?.(loaded, index.total ?? loaded);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CHUNK_CONCURRENCY, chunks.length) }, worker),
  );

  const rows = parts.flat();
  return { rows, total: index.total ?? rows.length };
}

const detailCache = new Map();

// Detail is bucketed, so expanding one repository warms every repository that
// hashes alongside it.
async function loadDetail(bucket) {
  if (!detailCache.has(bucket)) {
    detailCache.set(
      bucket,
      fetchJson(`detail/${bucket}.json`, "no-cache").catch(() => ({})),
    );
  }
  return detailCache.get(bucket);
}

export { loadSummary, loadRows, loadDetail, normalizeSummary };
