import * as core from "@actions/core";
import { readConfig } from "./config.js";
import { createClient } from "./octokit.js";
import {
  fetchEnterpriseOrganizations,
  fetchViewerEnterprises,
  findEnterprisesOwningOrganization,
  classifyOrgFailure,
} from "./organizations.js";
import { fetchLiveMigrations } from "./liveMigrations.js";
import { fetchAuditEvents, RUN_ACTIONS, RARE_ACTIONS } from "./auditFeed.js";
import { onboardingWindowMs, isTerminal } from "./apply.js";
import {
  recordLiveMigrations,
  syncOrganization,
  applyAuditEvents,
  earliestMigrationMs,
  earliestInventoryMs,
  migratedOrgs,
} from "./sync.js";
import { Store } from "./store.js";
import { Budget } from "./budget.js";
import { buildRows, buildSummary } from "./summary.js";
import { commitData } from "./git.js";
import { assembleSite } from "./site.js";

// How long an organization the token cannot read is left alone before asking
// again. The remedy is a person authorizing the token, not time passing.
const ORG_BACKOFF_MS = 24 * 60 * 60 * 1000;

async function run() {
  const config = readConfig();
  core.setSecret(config.token);

  // The window is what bounds the actively tracked population; without it the
  // workflow re-list never retires a repository and the per-run cost follows the
  // whole estate instead of the migration rate.
  if (config.onboardingWindowDays === 0 && config.inventoryTtlDays > 0) {
    core.warning(
      "onboarding-window-days is 0, so workflow re-listing never stops and each run's cost " +
        "grows with the estate. Set inventory-ttl-days to 0 to inventory each repository once.",
    );
  }

  const store = new Store(config.dataDir);
  const state = store.readState();
  const budget = new Budget(config.budget);
  const octokit = createClient(config.token, config.apiUrl, budget);

  const enterprise = config.enterprise || (await resolveEnterprise(octokit, budget));

  const organizations = await fetchEnterpriseOrganizations(octokit, enterprise, budget);
  core.info(`Enterprise ${enterprise}: ${organizations.length} organization(s).`);

  // Live migrations are reported tenant-wide by the destination, so they are
  // read once rather than once per organization.
  const live = config.liveMigrations
    ? await fetchLiveMigrations(octokit, budget, { settledIds: settledLiveIds(store) })
    : { byOrg: new Map(), count: 0, unavailable: null };
  if (live.unavailable) core.info(`Live migrations skipped: ${live.unavailable}.`);
  else if (config.liveMigrations) core.info(`Live migrations: ${live.count} repository migration(s).`);

  // A live migration lands in an organization the enterprise already lists, but
  // union anyway so a destination organization the listing missed still gets its
  // repositories enriched rather than silently dropped.
  const orgs = [...new Set([...organizations, ...live.byOrg.keys()])].sort();
  // A shared budget spent partway through a fixed order starves the same tail of
  // the alphabet on every run, and their cursors never advance. Resuming at the
  // organization the last run ran out on gives every one of them a turn.
  const ordered = rotateFrom(orgs, state.nextOrg);
  if (ordered[0] !== orgs[0]) core.info(`Resuming this run's sweep at ${ordered[0]}.`);

  const skipped = [];
  let ranOutAt = null;
  const now = Date.now();
  for (const org of ordered) {
    // Live migrations were already read from the destination, so they are
    // recorded whatever happens next — an organization the token cannot read as
    // an owner still has them.
    recordLiveMigrations(store, org, live.byOrg.get(org) ?? []);

    // An organization the token is not authorized for fails the same way every
    // two hours until a person fixes it. Asking again sooner than daily costs a
    // request and a warning per run for nothing.
    const held = state.orgBackoff?.[org];
    if (held && held.until > now) {
      skipped.push({ org, ...held.failure, deferred: true });
      continue;
    }

    const spentBefore = budget.truncated;
    core.startGroup(`Organization: ${org}`);
    try {
      await syncOrganization({ octokit, org, store, state, budget, config });
      if (state.orgBackoff?.[org]) delete state.orgBackoff[org];
    } catch (err) {
      // GitHub's own rate limit closes a pool and throws out of whatever phase
      // was running. That is the budget stopping, not an organization that
      // cannot be read, and reporting it as the latter sends people to the
      // wrong fix.
      if (!spentBefore && budget.truncated) {
        core.info(`Stopped in ${org}: ${err.message}`);
      } else {
        // One inaccessible org (no owner/migrator access) must not fail the run,
        // but a run that quietly skips the same org every time is
        // indistinguishable from a healthy one unless it is reported.
        const failure = classifyOrgFailure(err);
        skipped.push({ org, ...failure });
        core.warning(`Skipping ${org}: ${failure.reason}`);
        if (failure.kind === "sso" || failure.kind === "access") {
          state.orgBackoff ??= {};
          state.orgBackoff[org] = { until: now + ORG_BACKOFF_MS, failure };
        }
      }
    }
    core.endGroup();
    if (!spentBefore && budget.truncated && ranOutAt === null) ranOutAt = org;
  }

  state.nextOrg = ranOutAt;
  state.runs = (state.runs ?? 0) + 1;
  // Recorded only once every organization was reached, so a sweep the budget
  // cut short is repeated next run rather than leaving the tail on old values.
  if (state.teamProperty !== config.teamProperty) {
    if (ranOutAt === null) state.teamProperty = config.teamProperty;
    else core.info(`team-property changed; the remaining organizations re-read it next run.`);
  }
  if (ranOutAt) {
    core.warning(
      `The call budget ran out at ${ranOutAt}; organizations after it were not read this run. ` +
        `The next run starts there.`,
    );
  }

  // The audit feed maintains workflow status, records deletions, and dates
  // durations. It is read as two streams, each scoped to the organizations that
  // hold migrations, so the cost is their event rate — not the enterprise's, and
  // not that of organizations the token cannot read.
  //
  // The rare events (a repository coming online, a deletion) are read from the
  // earliest migration: one per repository ever, so the whole history is a few
  // pages. Workflow runs are read from the earliest inventory instead — every
  // workflow's history was classified by REST at that point, so older run
  // events cannot change a status, and on a busy organization they are nearly
  // all of the log.
  //
  // It is the last thing read and everything before it is already in memory,
  // so a failure here must not take the run down with it: a token without the
  // scope, or the log's own rate limit, degrades to a run without fresh
  // workflow status rather than one that discards what it collected.
  const auditOrgs = migratedOrgs(store);
  const streams = [
    {
      label: "rare events",
      actions: RARE_ACTIONS,
      cursorKey: "auditCursor",
      floorMs: earliestMigrationMs(store),
      skipped: "no migrations recorded yet",
    },
    {
      label: "workflow runs",
      actions: RUN_ACTIONS,
      cursorKey: "runCursor",
      floorMs: earliestInventoryMs(store),
      skipped: "no repository inventoried yet",
    },
  ];
  for (const stream of streams) {
    // With no floor and no cursor there is nothing an event could apply to, and
    // a read would walk the enterprise's whole retained history for nothing.
    if (stream.floorMs === null && !state[stream.cursorKey]) {
      core.info(`Audit log (${stream.label}): skipped, ${stream.skipped}.`);
      continue;
    }
    try {
      const audit = await fetchAuditEvents(octokit, enterprise, state[stream.cursorKey], budget, {
        floorMs: stream.floorMs,
        orgs: auditOrgs,
        actions: stream.actions,
      });
      state[stream.cursorKey] = audit.cursor;
      const { applied } = applyAuditEvents(store, audit.events);
      core.info(
        `Audit log (${stream.label}): ${audit.events.length} read, ${applied} applied` +
          (audit.truncated ? "; budget reached, the rest is read next run" : ""),
      );
    } catch (err) {
      const status = err?.status ?? err?.response?.status ?? null;
      if (budget.exhausted.has("audit")) {
        core.info(`Audit log (${stream.label}): ${err.message}; resumes next run.`);
      } else if (status === 403 || status === 404) {
        core.warning(
          `The audit log could not be read (HTTP ${status}), so workflow status and durations were ` +
            `not refreshed. The token needs the read:audit_log scope and its owner must be an enterprise owner.`,
        );
        break;
      } else {
        throw err;
      }
    }
  }

  const written = store.flush();
  const stateChanged = store.writeState(state);

  const migrations = store.allMigrations();
  const repos = store.allRepos();
  const windowMs = onboardingWindowMs(config.onboardingWindowDays);
  const { rows, detail } = buildRows(migrations, repos, {
    windowMs,
    detailBuckets: config.detailBuckets,
  });
  const generatedAt = new Date().toISOString();
  // An organization the run could not read contributes no data, so counting it
  // as covered would overstate the dashboard's reach. Being unreadable is not
  // necessarily a fault — an organization can be left out on purpose — so the
  // names stay in the run log rather than on the dashboard.
  const skippedOrgs = new Set(skipped.map((s) => s.org));
  const syncedOrgs = orgs.filter((org) => !skippedOrgs.has(org));
  const meta = {
    generatedAt,
    enterprise,
    organizations: syncedOrgs,
    onboardingWindowDays: config.onboardingWindowDays,
    teamLabel: config.teamLabel,
    serverUrl: config.serverUrl,
  };
  const summary = { ...meta, ...buildSummary(rows, syncedOrgs) };

  store.writeSummary(summary);
  const rowsWritten = store.writeRowChunks(meta, rows, config.rowChunkSize);
  const detailWritten = store.writeDetail(detail);

  // Cursors and backoffs live in state.json, and a cursor that is never
  // committed makes the next run re-read the same window. So state counts as a
  // change even when no shard did.
  const changed = written.length > 0 || stateChanged;
  core.info(
    `${migrations.length} migrations across ${rows.length} repositories. ` +
      `Shards written: ${written.length}, ` +
      `row chunks: ${rowsWritten.written}/${rowsWritten.chunks} changed, ` +
      `detail buckets: ${detailWritten.written}/${detailWritten.buckets} changed. ` +
      `API requests: ${budget.describe()}.`,
  );

  if (skipped.length > 0) {
    core.warning(
      `${skipped.length} organization(s) could not be synced: ${skipped.map((s) => s.org).join(", ")}.`,
    );
    // One line per remedy rather than per organization, so a token that needs
    // authorizing reads as one action instead of ten identical warnings.
    for (const [hint, orgs] of groupByHint(skipped)) {
      core.warning(`${orgs.join(", ")} — ${hint}`);
    }
  }

  // The dashboard is assembled before anything is pushed, so a data store that
  // cannot be committed still publishes the run it just collected.
  assembleSite(config.outputPath, config.dataDir);
  core.info(`Assembled dashboard at ${config.outputPath}.`);

  let committed = false;
  if (config.commitData && changed) {
    committed = await commitData(config.dataDir, config.commitMessage, config.committer);
  }

  core.setOutput("changed", String(changed));
  core.setOutput("committed", String(committed));
  core.setOutput("total", String(rows.length));
  core.setOutput("truncated", String(budget.truncated));
  core.setOutput("skipped-organizations", String(skipped.length));
  core.setOutput("site-path", config.outputPath);
  await writeRunSummary(rows, summary, budget, written.length, skipped);
}

// github.com puts no enterprise slug in the workflow context, so it comes from
// the token instead. One administered enterprise settles it outright; several
// are narrowed to whichever owns the organization this workflow runs in.
async function resolveEnterprise(octokit, budget) {
  budget.take("graphql");
  const slugs = await fetchViewerEnterprises(octokit);

  if (slugs.length === 1) {
    core.info(`Enterprise resolved from the token: ${slugs[0]}.`);
    return slugs[0];
  }

  const hint = "Set the 'enterprise' input to the slug in github.com/enterprises/<slug>.";
  if (slugs.length === 0) {
    throw new Error(`The token's owner administers no enterprise. ${hint}`);
  }

  const owner = process.env.GITHUB_REPOSITORY_OWNER;
  if (owner) {
    budget.take("graphql");
    const owning = await findEnterprisesOwningOrganization(octokit, slugs, owner);
    if (owning.length === 1) {
      core.info(`Enterprise resolved from the ${owner} organization: ${owning[0]}.`);
      return owning[0];
    }
  }

  throw new Error(
    `The token's owner administers ${slugs.length} enterprises (${slugs.join(", ")}) and ` +
      `none could be matched to the '${owner ?? ""}' organization. ${hint}`,
  );
}

// Starts the sweep at `startAt`, wrapping round, so a run that could not reach
// every organization does not leave the same ones unread every time.
function rotateFrom(orgs, startAt) {
  const index = startAt ? orgs.indexOf(startAt) : -1;
  return index <= 0 ? orgs : [...orgs.slice(index), ...orgs.slice(0, index)];
}

// Live migrations that will never change again, so the list read can stop once
// it reaches them.
function settledLiveIds(store) {
  const ids = new Set();
  for (const row of store.allMigrations()) {
    if (row.live && isTerminal(row.state)) ids.add(String(row.id).split(":")[1] ?? "");
  }
  ids.delete("");
  return ids;
}

// Groups skipped organizations by remedy, so ten organizations needing the same
// token authorized read as one action rather than ten warnings.
function groupByHint(skipped) {
  const byHint = new Map();
  for (const { org, reason, hint } of skipped) {
    const key = hint ?? reason;
    if (!byHint.has(key)) byHint.set(key, []);
    byHint.get(key).push(org);
  }
  return [...byHint.entries()];
}

function writeRunSummary(rows, summary, budget, shards, skipped = []) {
  const byState = {};
  for (const row of rows) byState[row.state] = (byState[row.state] ?? 0) + 1;

  core.summary
    .addHeading("GitHub migration dashboard", 2)
    .addRaw(
      `${rows.length} repositories, ${summary.workflows.total} workflows, ${shards} shard(s) written.`,
    )
    .addTable([
      [
        { data: "State", header: true },
        { data: "Repositories", header: true },
      ],
      ...Object.entries(byState).map(([state, count]) => [state, String(count)]),
    ]);

  if (skipped.length > 0) {
    core.summary.addHeading("Organizations skipped", 3).addTable([
      [
        { data: "Organization", header: true },
        { data: "Reason", header: true },
        { data: "How to fix", header: true },
      ],
      ...skipped.map(({ org, reason, hint }) => [org, reason, hint ?? "—"]),
    ]);
  }

  core.summary.addHeading("API requests", 3).addTable([
    [
      { data: "Pool", header: true },
      { data: "Used", header: true },
      { data: "Budget", header: true },
      { data: "Rate limit left", header: true },
    ],
    ...POOLS.map(([pool, label]) => [
      label,
      String(budget.spent[pool]),
      budgetLabel(budget, pool),
      rateLimitLabel(budget, pool),
    ]),
  ]);
  // Nothing reaches the job page until the buffer is written.
  return core.summary.write();
}

const POOLS = [
  ["rest", "REST"],
  ["graphql", "GraphQL"],
  ["audit", "Audit log"],
];

function budgetLabel(budget, pool) {
  const limit = budget.limits[pool];
  const cap = limit === Infinity ? "unlimited" : String(limit);
  return budget.exhausted.has(pool) ? `${cap} (reached)` : cap;
}

// What GitHub said was left after the last response in that pool; a pool the
// run never called has nothing to report.
function rateLimitLabel(budget, pool) {
  const rate = budget.rateLimits[pool];
  if (!rate) return "—";
  const reset = rate.resetAt ? ` (resets ${new Date(rate.resetAt).toISOString().slice(11, 16)}Z)` : "";
  return `${rate.remaining.toLocaleString()} of ${rate.limit.toLocaleString()}${reset}`;
}

run().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
