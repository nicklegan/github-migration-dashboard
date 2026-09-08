import { useCallback, useEffect, useMemo, useState } from "react";
import { loadSummary, loadRows } from "./api.js";
import {
  filterByRange,
  computeKpis,
  stateBreakdown,
  teamBreakdown,
  orgBreakdown,
  onboardingBreakdown,
  workflowTotals,
  workflowTeamBreakdown,
  workflowOrgBreakdown,
} from "./kpis.js";
import {
  applyFilters,
  toggleSelections,
  toggleCombination,
  removeFilter,
  selectedValues,
  DIMENSION_LABELS,
} from "./crossFilter.js";
import { workflowGroups, workflowCount } from "./groupWorkflows.js";
import KpiCards from "./components/KpiCards.jsx";
import TabBar from "./components/TabBar.jsx";
import DonutChart from "./components/DonutChart.jsx";
import CategoryBarChart from "./components/CategoryBarChart.jsx";
import TimeFilter from "./components/TimeFilter.jsx";
import CrossFilterBar from "./components/CrossFilterBar.jsx";
import MigrationsTable from "./components/MigrationsTable.jsx";
import WorkflowsTable from "./components/WorkflowsTable.jsx";
import TimelineChart from "./components/TimelineChart.jsx";
import AppHeader from "./components/AppHeader.jsx";
import Blankslate, { TableSkeleton } from "./components/Blankslate.jsx";
import Icon from "./components/Icon.jsx";
import { useChartTheme } from "./ThemeProvider.jsx";

function repoTimelineCounts(row) {
  return {
    succeeded: row.state === "SUCCEEDED" ? 1 : 0,
    failed: row.state === "FAILED" ? 1 : 0,
  };
}

// Workflows carry no migration date of their own, so a repository's workflows
// are plotted at the date its repository migrated.
function workflowTimelineCounts(row) {
  if (!row.workflows) return null;
  return {
    succeeded: row.workflows.succeeded ?? 0,
    failing: row.workflows.failing ?? 0,
    idle: row.workflows.idle ?? 0,
  };
}

export default function App() {
  const { SUCCESS: GREEN, DANGER: RED, NEUTRAL: GRAY, stateColors } = useChartTheme();
  const [summary, setSummary] = useState(null);
  const [data, setData] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [range, setRange] = useState("all");
  const [filters, setFilters] = useState({});
  const [showRemoved, setShowRemoved] = useState(false);
  const [tab, setTab] = useState("overview");

  useEffect(() => {
    loadSummary().then(setSummary).catch((err) => setError(err.message));
    loadRows((loaded, total) => setProgress({ loaded, total }))
      .then(setData)
      .catch((err) => setError(err.message));
  }, []);

  const select = useCallback((selections) => {
    setFilters((current) => toggleSelections(current, selections));
  }, []);

  const selectCombination = useCallback((selections) => {
    setFilters((current) => toggleCombination(current, selections));
  }, []);

  const nowMs = useMemo(
    () => (summary?.generatedAt ? Date.parse(summary.generatedAt) : Date.now()),
    [summary],
  );

  // Stable between theme changes, so the timelines' own memos keep working.
  const repoTimelineSeries = useMemo(
    () => [
      { key: "succeeded", name: "Succeeded", color: GREEN },
      { key: "failed", name: "Failed", color: RED },
    ],
    [GREEN, RED],
  );

  const workflowTimelineSeries = useMemo(
    () => [
      { key: "succeeded", name: "Succeeded", color: GREEN },
      { key: "failing", name: "Failing", color: RED },
      { key: "idle", name: "Idle", color: GRAY },
    ],
    [GREEN, RED, GRAY],
  );

  const views = useMemo(() => {
    if (!data) return null;
    // Rows arrive one per target repository, already folded by the action, so
    // no total is inflated by repeated migration attempts. Repositories removed
    // after a successful migration are hidden unless asked for: they are not
    // part of the estate. Failed migrations are never hidden this way, since a
    // failure is precisely a repository that was never created.
    const present = showRemoved ? data.rows : data.rows.filter((r) => !r.removed);
    const inRange = filterByRange(present, range, nowMs);
    // Each visual sees every selection except its own dimension, so it keeps its
    // full breakdown and highlights the selected element instead of collapsing.
    const rowsFor = (except) => applyFilters(inRange, filters, except);
    const migrations = rowsFor();
    const workflows = workflowTotals(migrations);
    const byState = rowsFor("state");
    const byWorkflowState = workflowTotals(rowsFor("workflowState"));
    // This week's movement, over the same filtered rows, so the stat tiles can
    // say how much of the total is recent. Only meaningful when the range is
    // longer than a week: at "7 days" it repeats the total, and at "24 hours" it
    // would exceed it.
    const showDeltas = range === "all" || range === "quarter" || range === "month";
    const week = showDeltas ? filterByRange(applyFilters(present, filters), "week", nowMs) : [];
    const weekKpis = computeKpis(week);
    const weekWorkflows = workflowTotals(week);
    return {
      migrations,
      deltas: showDeltas
        ? {
            succeeded: weekKpis.succeeded,
            failed: weekKpis.failed,
            workflowsSucceeded: weekWorkflows.succeeded,
            workflowsFailing: weekWorkflows.failing,
          }
        : null,
      // What the workflow table will actually list, for its tab count.
      workflowCount: workflowCount(workflowGroups(migrations)),
      kpis: computeKpis(migrations),
      workflows,
      onboarding: onboardingBreakdown(migrations),
      repoState: stateBreakdown(byState)
        .filter((s) => s.state === "SUCCEEDED" || s.state === "FAILED" || s.state === "SUPERSEDED")
        .map((s) => ({ name: s.state, value: s.count, color: stateColors[s.state] || GRAY })),
      repoStateAll: stateBreakdown(byState).map((s) => ({
        name: s.state,
        value: s.count,
        color: stateColors[s.state] || GRAY,
      })),
      repoTeams: teamBreakdown(rowsFor(["team", "state"])),
      repoOrgs: orgBreakdown(rowsFor(["org", "state"])),
      workflowTeams: workflowTeamBreakdown(rowsFor(["team", "workflowState"])),
      workflowOrgs: workflowOrgBreakdown(rowsFor(["org", "workflowState"])),
      workflowState: [
        { name: "Succeeded", value: byWorkflowState.succeeded, color: GREEN },
        { name: "Failing", value: byWorkflowState.failing, color: RED },
        { name: "Idle", value: byWorkflowState.idle, color: GRAY },
      ],
    };
  }, [data, range, nowMs, filters, showRemoved, stateColors, GREEN, RED, GRAY]);

  if (error) return <main className="app"><p className="error">{error}</p></main>;
  if (!summary) {
    return (
      <main className="app">
        <Blankslate spinner heading="Loading dashboard" />
      </main>
    );
  }

  const kpis = views ? views.kpis : summary.kpis;
  const workflowTotalsView = views ? views.workflows : summary.workflows;
  const teamLabel = summary.teamLabel || "Team";
  const teamWord = teamLabel.toLowerCase();
  const dimensionLabels = { ...DIMENSION_LABELS, team: teamLabel };
  const repoStateData = views
    ? (views.repoState.length ? views.repoState : views.repoStateAll)
    : summaryStates(summary, stateColors, GRAY);
  const hasFilters = Object.keys(filters).length > 0;
  const windowDays = summary.onboardingWindowDays ?? 0;
  const clearFilters = () => setFilters({});
  const selected = (dimension) => selectedValues(filters, dimension);

  return (
    <>
      <AppHeader summary={summary} />
      <main className="app">
      <TabBar
        tabs={[
          { key: "overview", label: "Overview", icon: <Icon name="mark-github" /> },
          {
            key: "repositories",
            label: "Repositories",
            icon: <Icon name="repo" />,
            count: views ? views.migrations.length : null,
          },
          {
            key: "workflows",
            label: "Actions workflows",
            icon: <Icon name="workflow" />,
            count: views ? views.workflowCount : null,
          },
        ]}
        value={tab}
        onChange={setTab}
      >
        <TimeFilter value={range} onChange={setRange} />
        {summary.removed > 0 && (
          <button
            type="button"
            className={`removed-toggle${showRemoved ? " is-active" : ""}`}
            aria-pressed={showRemoved}
            onClick={() => setShowRemoved((on) => !on)}
            title="Repositories that migrated successfully but have since been deleted on the target"
          >
            {showRemoved ? "Hide" : "Show"} {summary.removed} removed
          </button>
        )}
      </TabBar>

      {hasFilters && (
        <div className="filters-row">
          <CrossFilterBar
            filters={filters}
            labels={dimensionLabels}
            onRemove={(dimension, value) => setFilters((current) => removeFilter(current, dimension, value))}
            onClear={clearFilters}
          />
        </div>
      )}

      <KpiCards
        kpis={kpis}
        workflows={workflowTotalsView}
        onboarding={views ? views.onboarding : summary.onboarding}
        windowDays={windowDays}
        deltas={views?.deltas}
      />

      {tab === "overview" && (
      <div role="tabpanel" id="panel-overview" aria-labelledby="tab-overview">
      <h2 className="section-title">Repositories</h2>
      <section className="charts">
        <CategoryBarChart
          title="By organization"
          subtitle="Repositories migrated per organization"
          data={views ? views.repoOrgs : summaryGroups(summary.orgs, "org")}
          xKey="org"
          stacked
          activeValues={selected("org")}
          seriesDimension="state"
          activeSeriesValues={selected("state")}
          onSelect={views ? select : undefined}
          onSelectCombination={views ? selectCombination : undefined}
          series={[
            { key: "succeeded", name: "Successful", color: GREEN, filterValue: "SUCCEEDED" },
            { key: "failed", name: "Failed", color: RED, filterValue: "FAILED" },
          ]}
        />
        <DonutChart
          title="By state"
          subtitle="Succeeded versus failed"
          data={repoStateData}
          activeValues={selected("state")}
          onSelect={views ? (value) => select([{ dimension: "state", value }]) : undefined}
        />
        <CategoryBarChart
          title={`By ${teamWord}`}
          subtitle={`Repositories migrated per ${teamWord}`}
          data={views ? views.repoTeams : summaryGroups(summary.teams, "team")}
          xKey="team"
          stacked
          activeValues={selected("team")}
          seriesDimension="state"
          activeSeriesValues={selected("state")}
          onSelect={views ? select : undefined}
          onSelectCombination={views ? selectCombination : undefined}
          series={[
            { key: "succeeded", name: "Successful", color: GREEN, filterValue: "SUCCEEDED" },
            { key: "failed", name: "Failed", color: RED, filterValue: "FAILED" },
          ]}
        />
      </section>

      <h2 className="section-title">Actions workflows</h2>
      <section className="charts">
        <CategoryBarChart
          title="By organization"
          subtitle="Workflow health per organization"
          data={views ? views.workflowOrgs : summaryWorkflowGroups(summary.orgs, "org")}
          xKey="org"
          stacked
          activeValues={selected("org")}
          seriesDimension="workflowState"
          activeSeriesValues={selected("workflowState")}
          onSelect={views ? select : undefined}
          onSelectCombination={views ? selectCombination : undefined}
          series={[
            { key: "succeeded", name: "Succeeded", color: GREEN, filterValue: "Succeeded" },
            { key: "failing", name: "Failing", color: RED, filterValue: "Failing" },
            { key: "idle", name: "Idle", color: GRAY, filterValue: "Idle" },
          ]}
        />
        <DonutChart
          title="By status"
          subtitle="Workflows by run status"
          data={views ? views.workflowState : workflowStateSlices(summary.workflows, GREEN, RED, GRAY)}
          activeValues={selected("workflowState")}
          onSelect={views ? (value) => select([{ dimension: "workflowState", value }]) : undefined}
        />
        <CategoryBarChart
          title={`By ${teamWord}`}
          subtitle={`Workflow health per ${teamWord}`}
          data={views ? views.workflowTeams : summaryWorkflowGroups(summary.teams, "team")}
          xKey="team"
          stacked
          activeValues={selected("team")}
          seriesDimension="workflowState"
          activeSeriesValues={selected("workflowState")}
          onSelect={views ? select : undefined}
          onSelectCombination={views ? selectCombination : undefined}
          series={[
            { key: "succeeded", name: "Succeeded", color: GREEN, filterValue: "Succeeded" },
            { key: "failing", name: "Failing", color: RED, filterValue: "Failing" },
            { key: "idle", name: "Idle", color: GRAY, filterValue: "Idle" },
          ]}
        />
      </section>

      <h2 className="section-title">Progress over time</h2>
      {views ? (
        <section className="charts charts-full">
          <TimelineChart
            title="Repositories"
            subtitle="Migrations by state"
            rows={views.migrations}
            range={range}
            nowMs={nowMs}
            series={repoTimelineSeries}
            countsOf={repoTimelineCounts}
            teamLabel={teamLabel}
            windowDays={windowDays}
          />
          <TimelineChart
            title="Actions workflows"
            subtitle="Workflow health, dated by repository migration"
            rows={views.migrations}
            range={range}
            nowMs={nowMs}
            series={workflowTimelineSeries}
            countsOf={workflowTimelineCounts}
            teamLabel={teamLabel}
            windowDays={windowDays}
          />
        </section>
      ) : (
        <RowsLoading progress={progress} />
      )}
      </div>
      )}

      {tab === "repositories" && (
        <div role="tabpanel" id="panel-repositories" aria-labelledby="tab-repositories">
          {views ? (
            <MigrationsTable
              repositories={views.migrations}
              teamLabel={teamLabel}
              serverUrl={summary.serverUrl}
              hasFilters={hasFilters}
              onClearFilters={clearFilters}
            />
          ) : (
            <RowsLoading progress={progress} table />
          )}
        </div>
      )}

      {tab === "workflows" && (
        <div role="tabpanel" id="panel-workflows" aria-labelledby="tab-workflows">
          {views ? (
            <WorkflowsTable
              repositories={views.migrations}
              teamLabel={teamLabel}
              serverUrl={summary.serverUrl}
              hasFilters={hasFilters}
              onClearFilters={clearFilters}
            />
          ) : (
            <RowsLoading progress={progress} table />
          )}
        </div>
      )}
      </main>
    </>
  );
}

// The tables need every row, so a tab that shows one waits for the stream the
// charts do not. A table keeps its shape with skeleton rows; a chart section
// shows a spinner with the count so far.
function RowsLoading({ progress, table = false }) {
  const text = progress
    ? `${progress.loaded.toLocaleString()} of ${progress.total.toLocaleString()} repositories`
    : "Fetching repositories";
  if (table) {
    return (
      <section className="table-section">
        <div className="table-header">
          <h2>
            <span className="spinner" style={{ width: 14, height: 14, margin: 0 }} aria-hidden="true" />
            <span className="fg-muted">{text}</span>
          </h2>
        </div>
        <TableSkeleton />
      </section>
    );
  }
  return (
    <div className="chart-card">
      <Blankslate spinner heading="Loading repository details">
        {text}
      </Blankslate>
    </div>
  );
}

// Adapters that let the precomputed summary drive the charts before rows.json
// arrives. They are only used for that first paint; once rows load, everything
// is recomputed client-side so cross-filtering stays live.
function summaryStates(summary, stateColors, fallback) {
  return (summary.states ?? [])
    .filter((s) => s.state === "SUCCEEDED" || s.state === "FAILED" || s.state === "SUPERSEDED")
    .map((s) => ({ name: s.state, value: s.count, color: stateColors[s.state] || fallback }));
}

function summaryGroups(groups, key) {
  return (groups ?? []).map((g) => ({ [key]: g.key, succeeded: g.succeeded, failed: g.failed }));
}

function summaryWorkflowGroups(groups, key) {
  return (groups ?? []).map((g) => ({ [key]: g.key, ...g.workflows }));
}

function workflowStateSlices(workflows, green, red, gray) {
  if (!workflows) return [];
  return [
    { name: "Succeeded", value: workflows.succeeded, color: green },
    { name: "Failing", value: workflows.failing, color: red },
    { name: "Idle", value: workflows.idle, color: gray },
  ];
}
