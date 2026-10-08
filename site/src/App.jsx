import { useCallback, useEffect, useMemo, useState } from "react";
import { loadSummary, loadRows } from "./api.js";
import { inferSourceKinds } from "./sourcePlatform.js";
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
  workflowPlatformBreakdown,
} from "./kpis.js";
import {
  attemptBreakdown,
  warningBreakdown,
  durationBreakdown,
  platformBreakdown,
  onboardingTeamBreakdown,
  onboardingOrgBreakdown,
  onboardingPlatformBreakdown,
  platformLabelOf,
  sizeDurationSeries,
  usesTeams,
} from "./distributions.js";
import { medianDaysToOnboard, comparePeriods, onboardingStats, checkpointsFor } from "./recovery.js";
import {
  applyFilters,
  toggleSelections,
  toggleCombination,
  removeFilter,
  selectedValues,
  DIMENSION_LABELS,
} from "./crossFilter.js";
import { workflowGroups, workflowCount } from "./groupWorkflows.js";
import { RepositoryCards, WorkflowCards } from "./components/KpiCards.jsx";
import TabBar from "./components/TabBar.jsx";
import DonutChart from "./components/DonutChart.jsx";
import CategoryBarChart from "./components/CategoryBarChart.jsx";
import SizeDurationChart from "./components/SizeDurationChart.jsx";
import TimeFilter from "./components/TimeFilter.jsx";
import CrossFilterBar from "./components/CrossFilterBar.jsx";
import MigrationsTable from "./components/MigrationsTable.jsx";
import WorkflowsTable from "./components/WorkflowsTable.jsx";
import TimelineChart from "./components/TimelineChart.jsx";
import RecoveryCurveChart from "./components/RecoveryCurveChart.jsx";
import RecoveryPulseChart from "./components/RecoveryPulseChart.jsx";
import CohortTrendChart from "./components/CohortTrendChart.jsx";
import OnboardingPeriodTable from "./components/OnboardingPeriodTable.jsx";
import OnboardingExplainer from "./components/OnboardingExplainer.jsx";
import OnboardingStatus from "./components/OnboardingStatus.jsx";
import OnboardingSummary from "./components/OnboardingSummary.jsx";
import { onboardingSummary } from "./onboardingSummary.js";
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

// The states a migration can be in against its window. One set of words for
// them everywhere on the tab — cards, curve, breakdown, and the explainer — so
// nothing has to be translated between charts.
const ONBOARDING_SERIES = (green, red, amber, late, gray) => [
  { key: "complete", name: "On time", color: green, filterValue: "On time" },
  { key: "late", name: "Late", color: late, filterValue: "Late" },
  { key: "inProgress", name: "Still onboarding", color: amber, filterValue: "Still onboarding" },
  { key: "incomplete", name: "Not onboarded", color: red, filterValue: "Not onboarded" },
  { key: "noWorkflows", name: "No workflows", color: gray, filterValue: "No workflows" },
];


export default function App() {
  const { SUCCESS: GREEN, DANGER: RED, NEUTRAL: GRAY, ATTENTION: AMBER, categorical, stateColors } = useChartTheme();
  const [summary, setSummary] = useState(null);
  const [data, setData] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [range, setRange] = useState("all");
  const [filters, setFilters] = useState({});
  const [showRemoved, setShowRemoved] = useState(false);
  // Null until the reader picks one, so the default can depend on data that has
  // not loaded yet rather than being fixed before the summary arrives.
  const [tab, setTab] = useState(null);

  useEffect(() => {
    loadSummary().then(setSummary).catch((err) => setError(err.message));
    loadRows((loaded, total) => setProgress({ loaded, total }))
      .then((loaded) => setData({ ...loaded, rows: inferSourceKinds(loaded.rows) }))
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
    // Onboarding carries its own window, so the time range does not apply to it:
    // a range shorter than the window could hold nothing but repositories still
    // onboarding, and a longer one would hide the oldest repositories that never
    // came back online — the ones most overdue. Cross-filters still apply.
    const scopeFor = (except) => applyFilters(present, filters, except);
    const onboardingWindow = summary?.onboardingWindowDays ?? 0;
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
    // One colour per platform, ranked over the whole selection, so the donut and
    // the scatter agree on what blue means.
    const platforms = platformBreakdown(rowsFor("sourcePlatform"));
    const colorByPlatform = new Map(
      platforms.map((p, i) => [p.sourcePlatform, categorical[i % categorical.length]]),
    );
    const platformColor = (name) => colorByPlatform.get(name) ?? GRAY;
    const scatter = sizeDurationSeries(migrations);
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
      scope: {
        ...onboardingBreakdown(scopeFor(), { windowDays: onboardingWindow, nowMs }),
        ...workflowTotals(scopeFor()),
      },
      // How fast repositories get green overall, and quarter by quarter, for
      // the "is it getting better?" tiles and table.
      onboardingOverall: onboardingStats(scopeFor(), {
        nowMs,
        windowDays: onboardingWindow,
        checkpoints: checkpointsFor(onboardingWindow),
      }),
      onboardingPeriods: comparePeriods(scopeFor(), { nowMs, windowDays: onboardingWindow }),
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
      sourcePlatforms: platformBreakdown(rowsFor(["sourcePlatform", "state"])),
      platformSlices: platforms.map((p) => ({
        name: p.sourcePlatform,
        value: p.succeeded + p.failed + p.other,
        color: platformColor(p.sourcePlatform),
      })),
      sizeDuration: {
        ...scatter,
        series: scatter.series.map((s) => ({ ...s, color: platformColor(s.platform) })),
      },
      attempts: attemptBreakdown(rowsFor(["attempts", "state"])),
      warnings: warningBreakdown(rowsFor("warnings")),
      durations: durationBreakdown(rowsFor("duration")),
      onboardingTeams: onboardingTeamBreakdown(scopeFor(["team", "onboarding"])),
      onboardingOrgs: onboardingOrgBreakdown(scopeFor(["org", "onboarding"])),
      onboardingPlatforms: onboardingPlatformBreakdown(scopeFor(["sourcePlatform", "onboarding"])),
      // The rows the onboarding charts plot, for the same reason: their x-axis
      // is each repository's own window, not the calendar.
      onboardingRows: scopeFor(),
      timeToOnboardOrgs: medianDaysToOnboard(scopeFor(["org"]), {
        groupOf: (row) => row.organization || "Unknown",
        keyName: "org",
        nowMs,
      }),
      timeToOnboardTeams: medianDaysToOnboard(scopeFor(["team"]), {
        groupOf: (row) => row.team || "Unassigned",
        keyName: "team",
        nowMs,
      }),
      timeToOnboardPlatforms: medianDaysToOnboard(scopeFor(["sourcePlatform"]), {
        groupOf: platformLabelOf,
        keyName: "sourcePlatform",
        nowMs,
      }),
      workflowPlatforms: workflowPlatformBreakdown(rowsFor(["sourcePlatform", "workflowState"])),
      workflowTeams: workflowTeamBreakdown(rowsFor(["team", "workflowState"])),
      workflowOrgs: workflowOrgBreakdown(rowsFor(["org", "workflowState"])),
      workflowState: [
        { name: "Succeeded", value: byWorkflowState.succeeded, color: GREEN },
        { name: "Failing", value: byWorkflowState.failing, color: RED },
        { name: "Idle", value: byWorkflowState.idle, color: GRAY },
      ],
    };
  }, [data, summary, range, nowMs, filters, showRemoved, stateColors, GREEN, RED, GRAY, categorical]);

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
  // The charts about who owns what — migrations and workflow health on the
  // overview, and where to act on onboarding — open on the team property when
  // the estate uses one; otherwise on organization.
  const ownerGroup = usesTeams(summary.teams) ? "team" : "org";
  // Onboarding is a tab at all only when there is something in it: no window
  // configured, or nothing measured against one yet, and it is left out.
  const onboardingTotals = summary.onboarding ?? {};
  const hasOnboarding =
    windowDays > 0 &&
    (onboardingTotals.inProgress ?? 0) +
      (onboardingTotals.complete ?? 0) +
      (onboardingTotals.late ?? 0) +
      (onboardingTotals.incomplete ?? 0) +
      (onboardingTotals.noWorkflows ?? 0) >
      0;
  const activeTab = tab ?? "overview";
  const clearFilters = () => setFilters({});
  const selected = (dimension) => selectedValues(filters, dimension);
  // The same measure broken down three ways, for the charts' dimension toggle.
  // A breakdown with no data yet is left out rather than offered as an empty
  // tab: source platform is only known once the rows have streamed in.
  const breakdownGroups = ({ org, team, sourcePlatform }) =>
    [
      { key: "org", label: "Organization", data: org },
      { key: "team", label: teamLabel, data: team },
      { key: "sourcePlatform", label: "Source", data: sourcePlatform },
    ].filter((group) => group.data);

  return (
    <>
      <AppHeader summary={summary} />
      <main className="app">
      <TabBar
        tabs={[
          { key: "overview", label: "Overview", icon: <Icon name="mark-github" /> },
          ...(hasOnboarding
            ? [{ key: "onboarding", label: "Onboarding", icon: <Icon name="pulse" /> }]
            : []),
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
        value={activeTab}
        onChange={setTab}
      >
        {/* Onboarding measures every migration against its own window, so a
            calendar range would only ever mislead there — and a repository that
            has since been deleted has no onboarding to report either way. */}
        {activeTab !== "onboarding" && (
          <>
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
          </>
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

      {activeTab === "overview" && (
      <div role="tabpanel" id="panel-overview" aria-labelledby="tab-overview">
      <h2 className="section-title">What moved</h2>
      <RepositoryCards kpis={kpis} deltas={views?.deltas} />
      <section className="charts">
        <CategoryBarChart
          title="Migrations"
          defaultGroup={ownerGroup}
          subtitle="Repositories migrated, and how they ended"
          groups={breakdownGroups({
            org: views ? views.repoOrgs : summaryGroups(summary.orgs, "org"),
            team: views ? views.repoTeams : summaryGroups(summary.teams, "team"),
            sourcePlatform: views?.sourcePlatforms,
          })}
          activeValuesFor={selected}
          stacked
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
        {views && (
          <DonutChart
            title="By source platform"
            subtitle="Where the repositories came from"
            data={views.platformSlices}
            activeValues={selected("sourcePlatform")}
            onSelect={(value) => select([{ dimension: "sourcePlatform", value }])}
          />
        )}
      </section>

      {views && (
        <>
          <section className="charts">
            <CategoryBarChart
              title="By attempts"
              subtitle="How many runs it took to migrate a repository"
              data={views.attempts}
              xKey="attempts"
              stacked
              ordered
              activeValues={selected("attempts")}
              seriesDimension="state"
              activeSeriesValues={selected("state")}
              onSelect={select}
              onSelectCombination={selectCombination}
              series={[
                { key: "succeeded", name: "Successful", color: GREEN, filterValue: "SUCCEEDED" },
                { key: "failed", name: "Failed", color: RED, filterValue: "FAILED" },
                { key: "other", name: "Other", color: GRAY },
              ]}
            />
            <CategoryBarChart
              title="By warnings"
              subtitle="Repositories whose migration reported items to review"
              data={views.warnings}
              xKey="warnings"
              ordered
              activeValues={selected("warnings")}
              onSelect={select}
              series={[{ key: "repositories", name: "Repositories", color: AMBER }]}
            />
            <CategoryBarChart
              title="By duration"
              subtitle={`How long migrations ran (${kpis.durationSamples.toLocaleString()} of ${kpis.total.toLocaleString()} recorded)`}
              data={views.durations}
              xKey="duration"
              ordered
              activeValues={selected("duration")}
              onSelect={select}
              series={[{ key: "repositories", name: "Repositories", color: GREEN }]}
            />
          </section>

          <section className="charts">
            <SizeDurationChart
              title="Size and duration"
              subtitle="How long a repository took, against how big it is"
              series={views.sizeDuration.series}
              footnote={`${views.sizeDuration.plotted.toLocaleString()} of ${views.sizeDuration.total.toLocaleString()} repositories have both a size and a duration recorded.`}
            />
          </section>
        </>
      )}

      {views ? (
        <section className="charts charts-full">
          <TimelineChart
            title="Over time"
            subtitle="Migrations by state"
            rows={views.migrations}
            range={range}
            nowMs={nowMs}
            series={repoTimelineSeries}
            countsOf={repoTimelineCounts}
            teamLabel={teamLabel}
            windowDays={windowDays}
          />
        </section>
      ) : (
        <RowsLoading progress={progress} />
      )}

      <h2 className="section-title">What still runs</h2>
      <WorkflowCards workflows={workflowTotalsView} windowDays={windowDays} deltas={views?.deltas} />
      <section className="charts">
        <CategoryBarChart
          title="Workflow health"
          defaultGroup={ownerGroup}
          subtitle="Whether the workflows that came over still run"
          groups={breakdownGroups({
            org: views ? views.workflowOrgs : summaryWorkflowGroups(summary.orgs, "org"),
            team: views ? views.workflowTeams : summaryWorkflowGroups(summary.teams, "team"),
            sourcePlatform: views?.workflowPlatforms,
          })}
          activeValuesFor={selected}
          stacked
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
      </section>

      {views && (
        <section className="charts charts-full">
          <TimelineChart
            title="Over time"
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
      )}

      </div>
      )}

      {activeTab === "onboarding" && (
        <div role="tabpanel" id="panel-onboarding" aria-labelledby="tab-onboarding">
          <h2 className="section-title">
            Onboarding
            <span className="section-note">
              How long migrated repositories take to get every workflow green, measured against a{" "}
              {windowDays}-day window from each repository's own migration
            </span>
          </h2>
          {views ? (
            <>
              <OnboardingSummary
                sentences={onboardingSummary({
                  status: views.scope,
                  overall: views.onboardingOverall,
                  periods: views.onboardingPeriods,
                  windowDays,
                })}
              />
              <OnboardingExplainer windowDays={windowDays} generatedAt={summary.generatedAt} />

              <section className="onboarding-section" aria-labelledby="onb-where">
                <h3 className="onboarding-section-title" id="onb-where">
                  <span className="onboarding-section-step">1</span>
                  Where things stand
                </h3>
                <div className="chart-card">
                  <OnboardingStatus
                    status={views.scope}
                    windowDays={windowDays}
                    colors={{ green: GREEN, red: RED, amber: AMBER, late: categorical[3], gray: GRAY }}
                  />
                </div>
              </section>

              <section className="onboarding-section" aria-labelledby="onb-how-long">
                <h3 className="onboarding-section-title" id="onb-how-long">
                  <span className="onboarding-section-step">2</span>
                  How long it takes
                </h3>
                <RecoveryCurveChart
                  title="Days from migration until every workflow is green"
                  subtitle="Share of repositories at each day after their own migration"
                  rows={views.onboardingRows}
                  windowDays={windowDays}
                  nowMs={nowMs}
                  overall={views.onboardingOverall}
                />
              </section>

              <section className="onboarding-section" aria-labelledby="onb-better">
                <h3 className="onboarding-section-title" id="onb-better">
                  <span className="onboarding-section-step">3</span>
                  Is it getting better?
                </h3>
                <CohortTrendChart
                  title="Fully green, by when repositories migrated"
                  subtitle="Of the repositories migrated in each period, the share with every workflow green in time"
                  rows={views.onboardingRows}
                  windowDays={windowDays}
                  nowMs={nowMs}
                />
                <details className="disclosure">
                  <summary>Compare periods side by side</summary>
                  <OnboardingPeriodTable periods={views.onboardingPeriods} windowDays={windowDays} />
                </details>
              </section>

              <section className="onboarding-section" aria-labelledby="onb-act">
                <h3 className="onboarding-section-title" id="onb-act">
                  <span className="onboarding-section-step">4</span>
                  Where to act
                </h3>
                <div className="charts">
                  <CategoryBarChart
                    title="Status by group"
                    defaultGroup={ownerGroup}
                    subtitle="Select a bar to filter the dashboard, then list those repositories on the Repositories tab"
                    groups={breakdownGroups({
                      org: views.onboardingOrgs,
                      team: views.onboardingTeams,
                      sourcePlatform: views.onboardingPlatforms,
                    })}
                    activeValuesFor={selected}
                    stacked
                    seriesDimension="onboarding"
                    activeSeriesValues={selected("onboarding")}
                    onSelect={select}
                    onSelectCombination={selectCombination}
                    series={ONBOARDING_SERIES(GREEN, RED, AMBER, categorical[3], GRAY)}
                  />
                  <CategoryBarChart
                    title="Median days to fully green, by group"
                    defaultGroup={ownerGroup}
                    subtitle="Counted the same way as the summary; groups too small or too new to measure are left out"
                    groups={breakdownGroups({
                      org: views.timeToOnboardOrgs,
                      team: views.timeToOnboardTeams,
                      sourcePlatform: views.timeToOnboardPlatforms,
                    })}
                    activeValuesFor={selected}
                    onSelect={select}
                    series={[{ key: "days", name: "Median days", color: categorical[0] }]}
                  />
                </div>
              </section>

              <section className="onboarding-section" aria-labelledby="onb-keeping-up">
                <h3 className="onboarding-section-title" id="onb-keeping-up">
                  <span className="onboarding-section-step">5</span>
                  Keeping up
                </h3>
                <RecoveryPulseChart
                  title="Migrated against fully green, per period"
                  subtitle="While the line keeps up with the bars, repositories are getting green as fast as they arrive"
                  rows={views.onboardingRows}
                  range="all"
                  nowMs={nowMs}
                />
              </section>
            </>
          ) : (
            <RowsLoading progress={progress} />
          )}
        </div>
      )}

      {activeTab === "repositories" && (
        <div role="tabpanel" id="panel-repositories" aria-labelledby="tab-repositories">
          <RepositoryCards kpis={kpis} deltas={views?.deltas} />
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

      {activeTab === "workflows" && (
        <div role="tabpanel" id="panel-workflows" aria-labelledby="tab-workflows">
          <WorkflowCards workflows={workflowTotalsView} windowDays={windowDays} deltas={views?.deltas} />
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
