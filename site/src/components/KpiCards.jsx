import { percent1, oneDecimal, count } from "../format.js";
import Icon from "./Icon.jsx";

// A stat tile: label above, the number below in tabular figures, and a third
// line for a delta or a sample hint. The third line is always laid out, empty
// or not, so every row of tiles is the same height and the numbers line up
// across banks.
function Stat({ label, value, tone, hint, delta, deltaTone }) {
  const showDelta = delta != null && delta !== 0;
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ""}`} title={hint}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {showDelta ? (
        <span className={`stat-delta${deltaTone ? ` stat-delta-${deltaTone}` : ""}`}>
          <Icon name="arrow-up" size={12} />
          {count(delta)} this week
        </span>
      ) : (
        <span className="stat-hint">{hint ?? "\u00a0"}</span>
      )}
    </div>
  );
}

// An average over part of the estate reads as if it covered all of it, so the
// tile says what it was measured over whenever some repositories are missing.
function sampleHint(samples, total, noun) {
  if (samples == null || samples >= total) return undefined;
  return samples === 0 ? `No ${noun} recorded` : `From ${count(samples)} of ${count(total)}`;
}

function Bank({ title, description, children, wide }) {
  return (
    <section className={`stat-bank${wide ? " stat-bank-wide" : ""}`}>
      <header className="stat-bank-head">
        <h2>{title}</h2>
        {description && <span className="stat-bank-desc">{description}</span>}
      </header>
      <div className="stat-grid">{children}</div>
    </section>
  );
}

// `deltas` carries this week's movement, computed by the caller over the same
// filtered rows, so a tile can say "+12 this week" without a second data path.
export default function KpiCards({ kpis, workflows, onboarding, windowDays, deltas }) {
  return (
    <div className="stat-banks">
      <Bank title="Repositories">
        <Stat tone="success" value={count(kpis.succeeded)} label="Succeeded" delta={deltas?.succeeded} deltaTone="success" />
        <Stat tone="danger" value={count(kpis.failed)} label="Failed" delta={deltas?.failed} deltaTone="danger" />
        <Stat value={percent1(kpis.successRate)} label="Success rate" />
        <Stat value={oneDecimal(kpis.avgWarnings)} label="Avg warnings" />
        <Stat
          value={oneDecimal(kpis.avgDurationMinutes)}
          label="Avg duration (min)"
          hint={sampleHint(kpis.durationSamples, kpis.total, "durations")}
        />
        <Stat
          value={oneDecimal(kpis.avgRepoSizeMB)}
          label="Avg size (MB)"
          hint={sampleHint(kpis.repoSizeSamples, kpis.total, "sizes")}
        />
      </Bank>

      <Bank title="Actions workflows">
        <Stat tone="success" value={count(workflows.succeeded)} label="Succeeded" delta={deltas?.workflowsSucceeded} deltaTone="success" />
        <Stat tone="danger" value={count(workflows.failing)} label="Failing" delta={deltas?.workflowsFailing} deltaTone="danger" />
        <Stat value={percent1(workflows.successRate)} label="Success rate" />
        <Stat tone="idle" value={count(workflows.idle)} label="Idle" />
        <Stat value={count(workflows.total)} label="Total" />
        <Stat tone="danger" value={count(workflows.failingRepos)} label="Repos with failures" />
      </Bank>

      {(windowDays > 0 || workflows.manual > 0) && (
        <Bank
          title="Migration scope"
          description={windowDays > 0 ? `${windowDays}-day onboarding window` : undefined}
          wide
        >
          {windowDays > 0 && onboarding && (
            <>
              <Stat value={count(onboarding.inProgress)} label="Onboarding" />
              <Stat tone="success" value={count(onboarding.complete)} label="Onboarded" />
              <Stat tone="danger" value={count(onboarding.incomplete)} label="Onboarding incomplete" />
              <Stat tone="idle" value={count(workflows.postOnboarding)} label="Workflows added later" />
            </>
          )}
          <Stat tone="idle" value={count(workflows.manual)} label="Manual-only workflows" />
        </Bank>
      )}
    </div>
  );
}
