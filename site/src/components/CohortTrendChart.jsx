import { useMemo, useState } from "react";
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceArea,
} from "recharts";
import { useChartTheme } from "../ThemeProvider.jsx";
import { cohortTrend, pendingFrom, trimUnmeasured } from "../recovery.js";

const GRANULARITIES = [
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "quarter", label: "Quarter" },
];

const percent = (value) => `${Math.round(value * 100)}%`;

// Is it getting better: of the repositories migrated in each month (or week, or
// quarter), the share fully green within a week, within 30 days, and within the
// window. Each group is still measured on its own repositories' clocks (see
// recovery.js), so the newest are not penalised for being new; the ones too
// young to have reached a day are shaded rather than left blank.
export default function CohortTrendChart({ title, subtitle, rows, windowDays, nowMs }) {
  const { tooltipProps, legendProps, AXIS_TICK, AXIS_LINE, GRID, CURSOR, NEUTRAL, categorical, SUCCESS } =
    useChartTheme();
  // Weekly by default: the finest view, where a change in tooling shows first.
  const [granularity, setGranularity] = useState("week");

  const { points: allPoints, checkpoints } = useMemo(
    () => cohortTrend(rows, { granularity, nowMs, windowDays }),
    [rows, granularity, nowMs, windowDays],
  );

  // Shortest first, so the lines read first week, first month, then the window.
  const lines = useMemo(
    () => [
      ...(checkpoints ?? []).map((day, i) => ({
        key: `by${day}`,
        atRisk: `by${day}AtRisk`,
        name: day === 7 ? "Within a week" : `Within ${day} days`,
        color: categorical[i % categorical.length],
      })),
      { key: "onTime", atRisk: "onTimeAtRisk", name: `Within the window (${windowDays} days)`, color: SUCCESS },
    ],
    [checkpoints, categorical, windowDays, SUCCESS],
  );
  const points = useMemo(() => trimUnmeasured(allPoints, lines.map((line) => line.key)), [allPoints, lines]);

  const pending = pendingFrom(points, "onTime");
  const hasValues = points.some((p) => lines.some((line) => p[line.key] != null));

  const tooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const point = payload[0].payload;
    return (
      <div style={tooltipProps.contentStyle}>
        <div style={tooltipProps.labelStyle}>
          Migrated {granularity === "week" ? "week of " : "in "}
          {label} · {point.repositories.toLocaleString()} repositories
        </div>
        {lines.map((line) => (
          <div key={line.key} style={tooltipProps.itemStyle}>
            Fully green {line.name.toLowerCase()}:{" "}
            <strong>
              {point[line.key] != null
                ? `${percent(point[line.key])} of ${point[line.atRisk].toLocaleString()}`
                : "too early to tell"}
            </strong>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="chart-card">
      <div className="chart-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p className="chart-subtitle">{subtitle}</p>}
        </div>
        <div className="chart-controls">
          <div className="segmented segmented-sm" role="group" aria-label={`${title} grouping`}>
            {GRANULARITIES.map((g) => (
              <button
                key={g.key}
                type="button"
                className={`segment${g.key === granularity ? " is-active" : ""}`}
                aria-pressed={g.key === granularity}
                onClick={() => setGranularity(g.key)}
              >
                {g.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {!hasValues ? (
        <p className="chart-empty">
          {allPoints.length === 0
            ? "No data"
            : "No group has enough repositories old enough to measure yet. Try a coarser grouping."}
        </p>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            {/* Band scale, so each group is a column of its own and the shading
                covers whole groups, even a single one. */}
            <XAxis
              dataKey="label"
              scale="band"
              tick={{ fill: AXIS_TICK, fontSize: 12 }}
              axisLine={{ stroke: AXIS_LINE }}
              tickLine={false}
              minTickGap={24}
            />
            <YAxis
              domain={[0, 1]}
              tick={{ fill: AXIS_TICK, fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={percent}
            />
            {pending && (
              <ReferenceArea
                x1={pending.label}
                x2={points.at(-1).label}
                fill={NEUTRAL}
                fillOpacity={0.12}
                stroke="none"
                ifOverflow="extendDomain"
                label={{ value: "Window still open", position: "insideTop", fill: AXIS_TICK, fontSize: 11 }}
              />
            )}
            <Tooltip cursor={{ fill: CURSOR }} content={tooltip} />
            <Legend
              verticalAlign="top"
              height={28}
              iconType="circle"
              iconSize={8}
              itemSorter={null}
              {...legendProps}
              formatter={(value) => legendProps.formatter?.(value, null, false) ?? value}
            />
            {lines.map((line) => (
              <Line
                key={line.key}
                type="monotone"
                dataKey={line.key}
                name={line.name}
                stroke={line.color}
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      )}
      <p className="chart-footnote">
        Higher is better. Each line counts only repositories that have had that many days, so the
        newest groups gain the longer lines as they age; shaded groups are too young for the window.
      </p>
    </div>
  );
}
