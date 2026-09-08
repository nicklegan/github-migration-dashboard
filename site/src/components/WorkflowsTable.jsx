import { Fragment, useMemo, useState } from "react";
import { dateTime } from "../format.js";
import { workflowGroups, workflowCount } from "../groupWorkflows.js";
import { workflowCsv, exportPlan } from "../exportRows.js";
import { loadDetail } from "../api.js";
import { safeHref } from "./SourceCells.jsx";
import SourceCells from "./SourceCells.jsx";
import ExportCsvButton from "./ExportCsvButton.jsx";
import Blankslate from "./Blankslate.jsx";
import Icon from "./Icon.jsx";
import { useSort, SortableTh, OrgCell } from "./table.jsx";

const STATUS_LABEL = {
  succeeded: "Succeeded",
  failing: "Failing",
  idle: "Idle",
  manual: "Manual",
  "post-onboarding": "Added later",
};

// Data captured before the action recorded workflow URLs has no link target.
function WorkflowName({ workflow }) {
  const href = workflow.url ? safeHref(workflow.url) : null;
  const name = href ? (
    <a href={href} target="_blank" rel="noreferrer">
      {workflow.name}
    </a>
  ) : (
    workflow.name
  );
  return (
    <span className="cell-inline">
      <Icon name="workflow" className="fg-muted" />
      {name}
    </span>
  );
}

// A manual workflow that has run is scored on that run; only a never-run one is
// unmeasurable.
const unmeasurable = (workflow) => workflow.manual && workflow.status === "idle";

function StatusCell({ workflow }) {
  const manual = unmeasurable(workflow);
  return (
    <td>
      <span className={`status status-${manual ? "manual" : workflow.status}`}>
        {manual ? "Manual" : STATUS_LABEL[workflow.status] || workflow.status}
      </span>
    </td>
  );
}

function WorkflowCell({ workflow }) {
  return (
    <td>
      <WorkflowName workflow={workflow} />
      {workflow.manual && !unmeasurable(workflow) && (
        <span className="label" title="Only runs when dispatched by hand, but it has run — so this result counts">
          manual
        </span>
      )}
      {workflow.onboarding === false && (
        <span className="label" title="Added after the onboarding window closed — not counted as part of the migration">
          Added later
        </span>
      )}
    </td>
  );
}

const COLUMNS = {
  status: (g) => g.status,
  organization: (g) => g.organization,
  repository: (g) => g.repository,
  sourceType: (g) => g.sourceType,
  team: (g) => g.team,
  count: (g) => g.count,
  migratedAt: (g) => g.migratedAt,
};

// Workflows folded under their repository. Each row carries only its workflow
// counts, which is enough for the rolled-up status; the workflow list is fetched
// when the row is expanded. A repository with a single workflow carries it on
// the row instead, so it reads inline with nothing to expand.
export default function WorkflowsTable({ repositories, teamLabel = "Team", serverUrl = null, hasFilters = false, onClearFilters }) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(() => new Set());
  const [details, setDetails] = useState(() => new Map());

  const allGroups = useMemo(() => workflowGroups(repositories), [repositories]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allGroups;
    return allGroups.filter(
      (g) =>
        g.repository.toLowerCase().includes(q) ||
        g.organization.toLowerCase().includes(q) ||
        (g.sourceType ?? "").toLowerCase().includes(q) ||
        (g.team ?? "").toLowerCase().includes(q) ||
        (g.status ?? "").toLowerCase().includes(q),
    );
  }, [allGroups, query]);

  const { sorted: groups, sort, toggle: toggleSort } = useSort(filtered, COLUMNS);

  const toggle = async (group) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(group.key)) next.delete(group.key);
      else next.add(group.key);
      return next;
    });

    if (!details.has(group.key)) {
      const bucket = await loadDetail(group.bucket);
      setDetails((current) => new Map(current).set(group.key, bucket[group.key]?.workflows ?? []));
    }
  };

  // An export names every workflow, but the table only fetches a group's detail
  // when it is expanded. Detail is bucketed and cached, so this costs one
  // request per bucket the shown groups fall into rather than one per group.
  const exportRows = async () => {
    const plan = exportPlan(groups);
    if (
      plan.confirm &&
      !window.confirm(
        `Exporting every workflow for ${groups.length} repositories downloads ${plan.buckets} more ` +
          `data files. Filter the table first to export less. Continue?`,
      )
    ) {
      return null;
    }

    const buckets = new Map();
    for (const bucket of new Set(groups.map((g) => g.bucket))) {
      buckets.set(bucket, await loadDetail(bucket));
    }
    const workflowsFor = (group) =>
      buckets.get(group.bucket)?.[group.key]?.workflows ??
      (group.workflow ? [group.workflow] : []);

    return workflowCsv(groups, workflowsFor, { teamLabel });
  };

  const empty = (
    <Blankslate
      icon="workflow"
      heading={allGroups.length === 0 ? "No workflow data" : "No repositories match"}
      action={
        (hasFilters || query) && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setQuery("");
              onClearFilters?.();
            }}
          >
            Clear filters
          </button>
        )
      }
    >
      {allGroups.length === 0
        ? "None of the repositories in this selection have Actions workflows."
        : query
          ? "Try a different search, or clear the filters."
          : "Nothing in this time range matches the current selection."}
    </Blankslate>
  );

  return (
    <section className="table-section">
      <div className="table-header">
        <h2>
          Workflows
          <span className="counter">{workflowCount(groups).toLocaleString()}</span>
          <span className="table-subcount">in {groups.length.toLocaleString()} repositories</span>
        </h2>
        <div className="table-tools">
          <label className="input-icon">
            <Icon name="search" className="fg-muted" />
            <input
              type="search"
              placeholder={`Filter by repo, org, ${teamLabel.toLowerCase()}, source, or status`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <ExportCsvButton prefix="workflow-migrations" disabled={groups.length === 0} build={exportRows} />
        </div>
      </div>

      {groups.length === 0 ? (
        empty
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th className="toggle-col" aria-label="Expand workflows" />
                <SortableTh column="status" sort={sort} onToggle={toggleSort}>Status</SortableTh>
                <SortableTh column="organization" sort={sort} onToggle={toggleSort}>Organization</SortableTh>
                <SortableTh column="repository" sort={sort} onToggle={toggleSort}>Repository</SortableTh>
                <SortableTh column="sourceType" sort={sort} onToggle={toggleSort}>Source</SortableTh>
                <th>Source namespace</th>
                <th>Source repository</th>
                <SortableTh column="team" sort={sort} onToggle={toggleSort}>{teamLabel}</SortableTh>
                <th>Workflow</th>
                <th>State</th>
                <SortableTh column="migratedAt" sort={sort} onToggle={toggleSort}>Migrated</SortableTh>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => {
                const single = group.workflow;
                const isOpen = !single && expanded.has(group.key);
                const workflows = details.get(group.key);
                return (
                  <Fragment key={group.key}>
                    <tr className={isOpen ? "is-expanded" : undefined}>
                      <td className="toggle-col">
                        {!single && (
                          <button
                            type="button"
                            className="row-toggle"
                            aria-expanded={isOpen}
                            aria-label={`${isOpen ? "Collapse" : "Expand"} ${group.count} workflows for ${group.key}`}
                            onClick={() => toggle(group)}
                          >
                            <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={12} />
                          </button>
                        )}
                      </td>
                      {single ? (
                        <StatusCell workflow={single} />
                      ) : (
                        <td>
                          <span className={`status status-${group.status}`}>
                            {STATUS_LABEL[group.status] || group.status}
                          </span>
                        </td>
                      )}
                      <OrgCell serverUrl={serverUrl} org={group.organization} />
                      <td>
                        <span className="cell-inline">
                          <Icon name="repo" className="fg-muted" />
                          <span className="text-bold">{group.repository}</span>
                        </span>
                        {!single && <span className="counter counter-sm">{group.count} workflows</span>}
                      </td>
                      <td className="fg-muted">{group.sourceType || "—"}</td>
                      <SourceCells url={group.sourceUrl} sourceType={group.sourceType} />
                      <td>{group.team || <span className="fg-muted">—</span>}</td>
                      {single ? (
                        <>
                          <WorkflowCell workflow={single} />
                          <td className="fg-muted">{single.state || "—"}</td>
                        </>
                      ) : (
                        <>
                          <td className="fg-muted">—</td>
                          <td className="fg-muted">—</td>
                        </>
                      )}
                      <td className="fg-muted">{dateTime(group.migratedAt)}</td>
                    </tr>
                    {isOpen &&
                      (workflows ?? []).map((w) => (
                        <tr key={w.id} className="nested-row">
                          <td className="toggle-col" />
                          <StatusCell workflow={w} />
                          <td />
                          <td />
                          <td />
                          <td />
                          <td />
                          <td />
                          <WorkflowCell workflow={w} />
                          <td className="fg-muted">{w.state || "—"}</td>
                          <td className="fg-muted">{dateTime(group.migratedAt)}</td>
                        </tr>
                      ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
