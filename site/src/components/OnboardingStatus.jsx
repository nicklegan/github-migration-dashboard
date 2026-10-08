import { count, percent } from "../format.js";

// Where every repository stands against its window, as one bar that adds up to
// the whole estate. It is split first by whether the window has closed, because
// that is what the on-time rate is out of: the reader can see the rate is the
// green part of the left-hand group, rather than having to know it.
export default function OnboardingStatus({ status, windowDays, colors }) {
  const greenOpen = Math.max(0, status.complete - status.onTimeSettled);
  const groups = [
    {
      key: "closed",
      label: "Window closed",
      segments: [
        { key: "onTime", label: "On time", value: status.onTimeSettled, color: colors.green, hint: `Every workflow green within ${windowDays} days` },
        { key: "late", label: "Late", value: status.late, color: colors.late, hint: "Every workflow green, but after the window closed" },
        { key: "incomplete", label: "Not onboarded", value: status.incomplete, color: colors.red, hint: "A workflow still failing or never run" },
      ],
    },
    {
      key: "open",
      label: "Window still open",
      segments: [
        { key: "greenOpen", label: "Already fully green", value: greenOpen, color: colors.green, faded: true, hint: "Every workflow green; counts as on time when the window closes" },
        { key: "inProgress", label: "Still onboarding", value: status.inProgress, color: colors.amber, hint: "Not every workflow green yet" },
      ],
    },
    {
      key: "none",
      label: "Nothing to onboard",
      segments: [
        { key: "noWorkflows", label: "No workflows", value: status.noWorkflows, color: colors.gray, hint: "Window closed with no workflow to run. Left out of every rate." },
      ],
    },
  ]
    .map((g) => ({ ...g, total: g.segments.reduce((sum, s) => sum + s.value, 0) }))
    .filter((g) => g.total > 0);
  const total = groups.reduce((sum, g) => sum + g.total, 0);
  if (total === 0) return null;

  return (
    <div className="onboarding-status">
      <div className="onboarding-rate">
        <span className="onboarding-rate-value">{percent(status.onTimeRate)}</span>
        <span className="onboarding-rate-label">
          <strong>on time</strong>
          {status.settled > 0
            ? ` — ${count(status.onTimeSettled)} of the ${count(status.settled)} repositories whose window has closed had every workflow green within ${windowDays} days`
            : " — no repository's window has closed yet"}
        </span>
      </div>

      <div className="status-bar" role="img" aria-label={groups.map((g) => g.segments.map((s) => `${s.label} ${s.value}`).join(", ")).join("; ")}>
        {groups.map((g) => (
          <div key={g.key} className="status-bar-group" style={{ flexGrow: g.total }}>
            {g.segments
              .filter((s) => s.value > 0)
              .map((s) => (
                <span
                  key={s.key}
                  className="status-bar-segment"
                  style={{ flexGrow: s.value, background: s.color, opacity: s.faded ? 0.45 : 1 }}
                  title={`${s.label}: ${count(s.value)} — ${s.hint}`}
                />
              ))}
          </div>
        ))}
      </div>

      <div className="status-legend">
        {groups.map((g) => (
          <div key={g.key} className="status-legend-group">
            <div className="status-legend-head">
              {g.label} <span className="status-legend-total">{count(g.total)}</span>
            </div>
            {g.segments.map((s) => (
              <div key={s.key} className="status-legend-item" title={s.hint}>
                <span className="status-swatch" style={{ background: s.color, opacity: s.faded ? 0.45 : 1 }} />
                <span className="status-legend-label">{s.label}</span>
                <span className="status-legend-value">{count(s.value)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
