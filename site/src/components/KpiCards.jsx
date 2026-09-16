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

// A bank sits under its section's heading, so `title` is usually left out. With
// `columns` the tiles form a single full-width row; without it they wrap in a
// three-column grid.
function Bank({ title, description, children, columns }) {
  return (
    <section className={`stat-bank${columns ? " stat-bank-row" : ""}`}>
      {title && (
        <header className="stat-bank-head">
          <h2>{title}</h2>
          {description && <span className="stat-bank-desc">{description}</span>}
        </header>
      )}
      <div className="stat-grid" style={columns ? { "--stat-columns": columns } : undefined}>
        {children}
      </div>
    </section>
  );
}

// How many of the repositories whose window has closed came back healthy. Those
// still inside their window are not counted either way: they have not been
// asked the question yet.
function onboardingRate({ complete = 0, incomplete = 0 }) {
  const settled = complete + incomplete;
  return settled ? complete / settled : null;
}

function settledHint({ complete = 0, incomplete = 0 }) {
  const settled = complete + incomplete;
  return settled ? `From ${count(settled)} settled` : "No window has closed yet";
}

// `deltas` carries this week's movement, computed by the caller over the same
// filtered rows, so a tile can say "+12 this week" without a second data path.
export function RepositoryCards({ kpis, deltas }) {
  return (
    <div className="stat-banks">
      <Bank columns={6}>
        <Stat tone="success" value={count(kpis.succeeded)} label="Succeeded" delta={deltas?.succeeded} deltaTone="success" />
        <Stat tone="danger" value={count(kpis.failed)} label="Failed" delta={deltas?.failed} deltaTone="danger" />
        <Stat
          value={oneDecimal(kpis.avgDurationMinutes)}
          label="Avg duration (min)"
          hint={sampleHint(kpis.durationSamples, kpis.total, "durations")}
        />
        <Stat
          value={oneDecimal(kpis.avgWarnings)}
          label="Avg warnings"
          hint={`${count(kpis.withWarnings)} repositories had any`}
        />
        <Stat
          value={oneDecimal(kpis.avgRepoSizeMB)}
          label="Avg size (MB)"
          hint={sampleHint(kpis.repoSizeSamples, kpis.total, "sizes")}
        />
        <Stat value={percent1(kpis.successRate)} label="Success rate" hint="Of succeeded and failed" />
      </Bank>
    </div>
  );
}

export function WorkflowCards({ workflows, windowDays, deltas }) {
  const hasWindow = windowDays > 0;
  return (
    <div className="stat-banks">
      <Bank columns={6}>
        <Stat tone="success" value={count(workflows.succeeded)} label="Succeeded" delta={deltas?.workflowsSucceeded} deltaTone="success" />
        <Stat tone="danger" value={count(workflows.failing)} label="Failing" delta={deltas?.workflowsFailing} deltaTone="danger" />
        <Stat tone="idle" value={count(workflows.idle)} label="Idle" hint="No run succeeded or failed" />
        <Stat
          tone="idle"
          value={count(workflows.manual)}
          label="Manual-only"
          hint="Run on demand, so unscored"
        />
        {hasWindow ? (
          <Stat
            tone="idle"
            value={count(workflows.postOnboarding)}
            label="Added later"
            hint="After the window closed"
          />
        ) : (
          <Stat tone="danger" value={count(workflows.failingRepos)} label="Repos with failures" hint="At least one failing workflow" />
        )}
        <Stat value={percent1(workflows.successRate)} label="Success rate" hint="Of succeeded and failing" />
      </Bank>
    </div>
  );
}

// Kept apart from the banks above because it is measured differently: these
// count every migration against its own window rather than the selected time
// range, so they belong with the onboarding chart rather than beside numbers
// the range filter moves.
export function OnboardingCards({ scope, windowDays }) {
  if (!(windowDays > 0)) return null;
  return (
    <div className="stat-banks">
      <Bank columns={5}>
        <Stat value={count(scope.inProgress)} label="Still in window" hint="Too early to judge" />
        <Stat tone="success" value={count(scope.complete)} label="Onboarded" hint="Every workflow succeeded" />
        <Stat
          tone="danger"
          value={count(scope.incomplete)}
          label="Window closed, not onboarded"
          hint="Workflows failing or never run"
        />
        <Stat
          value={percent1(onboardingRate(scope))}
          label="Onboarding rate"
          hint={settledHint(scope)}
        />
        <Stat
          tone="danger"
          value={count(scope.failingRepos)}
          label="Repos with failing workflows"
          hint="At any stage of the window"
        />
      </Bank>
    </div>
  );
}
