import { percent, oneDecimal, count } from "../format.js";
import Icon from "./Icon.jsx";

// Periods side by side — the latest quarters, or months for a young estate — so
// "is onboarding getting faster?" is one glance across a row. Every figure is censored the same way as the charts (see recovery.js),
// and each cell says how it moved against the period to its left.
export default function OnboardingPeriodTable({ title, subtitle, periods, windowDays }) {
  const checkpoints = Object.keys(periods[0]?.by ?? {});
  const metrics = [
    {
      key: "repositories",
      label: "Repositories with workflows",
      value: (p) => p.repositories,
      format: count,
    },
    {
      key: "median",
      label: "Median days to fully green",
      value: (p) => p.median?.days ?? null,
      format: (v, p) => (v != null ? oneDecimal(v) : p.median?.over != null ? `>${p.median.over}` : "—"),
      better: "lower",
      unit: "days",
      title: (p) => (p.median == null ? "Fewer than five repositories to measure" : undefined),
    },
    ...checkpoints.map((day) => ({
      key: `by${day}`,
      label: Number(day) === 7 ? "Fully green within a week" : `Fully green within ${day} days`,
      value: (p) => p.by?.[day]?.share ?? null,
      format: (v) => percent(v),
      better: "higher",
      unit: "pts",
      title: (p) =>
        p.by?.[day]
          ? `${p.by[day].green.toLocaleString()} of ${p.by[day].atRisk.toLocaleString()} repositories migrated at least ${day} days ago`
          : `Fewer than five repositories in this period have had ${day} days yet`,
    })),
    {
      key: "onTime",
      label: `Fully green within the window (${windowDays} days)`,
      value: (p) => p.onTime?.share ?? null,
      format: (v) => percent(v),
      better: "higher",
      unit: "pts",
      title: (p) =>
        p.onTime
          ? `${p.onTime.green.toLocaleString()} of ${p.onTime.atRisk.toLocaleString()} repositories whose window has closed`
          : "Fewer than five repositories in this period have had their window close yet",
    },
  ];

  return (
    <div className={title ? "chart-card" : "period-table-bare"}>
      {title && (
        <div className="chart-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="chart-subtitle">{subtitle}</p>}
          </div>
        </div>
      )}
      {periods.length === 0 ? (
        <p className="chart-empty">No data</p>
      ) : (
        <div className="period-table-wrap">
          <table className="period-table">
            <thead>
              <tr>
                <th scope="col">Migrated</th>
                {periods.map((p) => (
                  <th key={p.key} scope="col">
                    <span className="period-name">{p.label}</span>
                    <span className="period-range">{p.range}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {metrics.map((metric) => (
                <tr key={metric.key}>
                  <th scope="row">{metric.label}</th>
                  {periods.map((p, i) => {
                    const value = metric.value(p);
                    const previous = i > 0 ? metric.value(periods[i - 1]) : null;
                    return (
                      <td key={p.key} title={metric.title?.(p)}>
                        <span className="period-value">{metric.format(value, p)}</span>
                        {metric.better && <Change value={value} previous={previous} metric={metric} />}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="chart-footnote">
        Repositories grouped by when they migrated, each column compared with the one before it. A
        dash means too few repositories in that period have had that many days yet.
        {periods[0]?.key === "earlier" && " Earlier combines the older periods into one group."}
      </p>
    </div>
  );
}

// The movement against the column to the left, coloured by whether it is
// better: fewer days, or a higher share.
function Change({ value, previous, metric }) {
  if (value == null || previous == null) return null;
  const diff = value - previous;
  const shown = metric.unit === "pts" ? Math.round(diff * 100) : Math.round(diff * 10) / 10;
  if (shown === 0) return <span className="period-change">±0</span>;
  const better = metric.better === "lower" ? diff < 0 : diff > 0;
  return (
    <span className={`period-change ${better ? "is-better" : "is-worse"}`}>
      <Icon name={diff > 0 ? "arrow-up" : "arrow-down"} size={12} />
      {Math.abs(shown)}
      {metric.unit === "pts" ? " pts" : "d"}
    </span>
  );
}
