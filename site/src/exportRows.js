import { parseSourceUrl } from "./sourceUrl.js";
import { targetUrl } from "./targetUrl.js";
import { isoDate } from "./csv.js";

// Builds the CSV shape of each table from the rows it is currently showing.
// Pure logic, no React and no fetching, so it unit-tests directly.
//
// The exports carry the URLs the table renders as links, and ISO timestamps
// rather than the reader's locale format, so a spreadsheet can sort and join on
// them.

const STATUS_LABEL = {
  succeeded: "Succeeded",
  failing: "Failing",
  idle: "Idle",
  manual: "Manual",
  "post-onboarding": "Added later",
};

function sourceCells(url) {
  const source = parseSourceUrl(url);
  return [source?.namespace ?? "", source?.repository ?? "", url ?? ""];
}

function migrationCsv(rows, { teamLabel = "Team", serverUrl = null } = {}) {
  const headers = [
    "State",
    "Target organization",
    "Target repository",
    "Target URL",
    "Source type",
    "Source namespace",
    "Source repository",
    "Source URL",
    teamLabel,
    "Migration date",
    "Duration (min)",
    "Warnings",
    "Repo size (MB)",
    "Attempts",
    "Removed",
    "Superseded by",
    "Onboarding",
  ];

  return {
    headers,
    rows: rows.map((row) => [
      row.state,
      row.organization,
      row.repository,
      targetUrl(serverUrl, row) ?? "",
      row.sourceType ?? "",
      ...sourceCells(row.sourceUrl),
      row.team ?? "",
      isoDate(row.createdAt),
      row.durationMinutes ?? null,
      row.warningsCount ?? 0,
      row.repoSizeMB ?? null,
      row.attemptCount ?? 1,
      Boolean(row.removed),
      row.supersededBy ?? "",
      row.onboarding ?? "",
    ]),
  };
}

// A manual workflow that has run is scored on that run; only a never-run one is
// unmeasurable, and that is what the table badges as Manual.
function workflowStatus(workflow) {
  const status = workflow.manual && workflow.status === "idle" ? "manual" : workflow.status;
  return STATUS_LABEL[status] || status || "";
}

// One line per workflow rather than per repository: a rollup would drop the
// names, which is the thing this table exists to show. `workflowsFor` returns a
// group's workflows, already fetched by the caller.
function workflowCsv(groups, workflowsFor, { teamLabel = "Team" } = {}) {
  const headers = [
    "Status",
    "Target organization",
    "Target repository",
    "Source type",
    "Source namespace",
    "Source repository",
    "Source URL",
    teamLabel,
    "Workflow",
    "Workflow URL",
    "Workflow state",
    "Manual",
    "Added after onboarding",
    "Repo migration date",
  ];

  const rows = [];
  for (const group of groups) {
    for (const workflow of workflowsFor(group)) {
      rows.push([
        workflowStatus(workflow),
        group.organization,
        group.repository,
        group.sourceType ?? "",
        ...sourceCells(group.sourceUrl),
        group.team ?? "",
        workflow.name ?? "",
        workflow.url ?? "",
        workflow.state ?? "",
        Boolean(workflow.manual),
        workflow.onboarding === false,
        isoDate(group.migratedAt),
      ]);
    }
  }

  return { headers, rows };
}

// Naming every workflow means fetching the detail bucket behind each group. They
// are cached and shared, but an unfiltered export on a large estate reaches for
// most of the payload at once, so the caller is told the cost before it starts.
const FREE_BUCKETS = 12;

function exportPlan(groups) {
  const buckets = new Set(groups.map((group) => group.bucket)).size;
  return { buckets, confirm: buckets > FREE_BUCKETS };
}

export { migrationCsv, workflowCsv, exportPlan, FREE_BUCKETS };
