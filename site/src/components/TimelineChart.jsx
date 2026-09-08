import { useId, useMemo, useState } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceArea,
  ReferenceLine,
} from "recharts";
import { useChartTheme } from "../ThemeProvider.jsx";
import {
  timelinePlan,
  buildTimeline,
  maxOf,
  niceScale,
  groupValues,
  inGroup,
  stepLabel,
  formatBucket,
} from "../timeline.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Progress over time, one thin line per state with a faint fill beneath it. The
// x-axis window follows the tab's time filter and the y-axis follows the data,
// so neither has to be configured.
//
// `countsOf` maps a row to what it contributes to each series, which is what
// lets one chart plot repositories (one per row) and another plot workflows (a
// workflow tally per row).
export default function TimelineChart({
  title,
  subtitle,
  rows,
  range,
  nowMs,
  series,
  countsOf,
  teamLabel = "Team",
  windowDays = 0,
}) {
  const { tooltipProps, legendProps, AXIS_TICK, AXIS_LINE, GRID, CURSOR, ATTENTION } = useChartTheme();
  // Gradient ids must be unique per chart and valid as ids; a title-derived id
  // broke on any title with a space, leaving the fill black.
  const gradientId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const fillId = (key) => `fill-${gradientId}-${key}`;
  const [groupBy, setGroupBy] = useState("all");
  const [groupValue, setGroupValue] = useState(null);
  // Per-bucket by default: a running total only ever climbs, so the rate is what
  // shows the pulse of a migration programme.
  const [cumulative, setCumulative] = useState(false);

  const groups = [
    ["all", "All"],
    ["org", "Organization"],
    ["team", teamLabel],
  ];

  const options = useMemo(() => groupValues(rows, groupBy), [rows, groupBy]);
  // A cross-filter can remove whatever was selected here; falling back to the
  // first remaining option beats rendering an empty chart with no explanation.
  const selected =
    groupBy === "all" ? null : options.includes(groupValue) ? groupValue : (options[0] ?? null);

  const scoped = useMemo(
    () => (groupBy === "all" ? rows : rows.filter((row) => inGroup(row, groupBy, selected))),
    [rows, groupBy, selected],
  );

  // The window comes from every row in view, not the scoped subset, so switching
  // organization moves the lines without moving the axis under them. Only the
  // y-axis follows the selection.
  const plan = useMemo(() => timelinePlan(range, rows, nowMs), [range, rows, nowMs]);

  const keys = series.map((s) => s.key);
  const data = useMemo(() => {
    const points = buildTimeline(scoped, { plan, keys, countsOf, cumulative });
    return points.map((point) => ({ ...point, label: formatBucket(point.at, plan) }));
    // `keys` and `countsOf` are stable module constants supplied by the caller.
  }, [scoped, plan, cumulative]);

  const scale = useMemo(() => niceScale(maxOf(data, keys)), [data]);

  // Repositories migrated inside the last `windowDays` are still onboarding, so
  // that band of the axis is tinted: lines inside it are expected to still be
  // moving. Only drawn when the band is a proper sub-range of what is shown.
  const onboarding = useMemo(() => {
    if (!windowDays || data.length < 2) return null;
    const opensAt = nowMs - windowDays * DAY_MS;
    const first = data.find((p) => p.at + plan.step > opensAt);
    if (!first || first === data[0]) return null;
    return { from: first.label, to: data[data.length - 1].label };
  }, [data, plan, nowMs, windowDays]);

  const todayLabel = useMemo(() => {
    const point = data.find((p) => nowMs >= p.at && nowMs < p.at + plan.step);
    return point?.label ?? null;
  }, [data, plan, nowMs]);

  return (
    <div className="chart-card">
      <div className="chart-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p className="chart-subtitle">{subtitle}</p>}
        </div>
        <div className="chart-controls">
          <div className="segmented segmented-sm" role="group" aria-label={`${title} grouping`}>
            {groups.map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`segment${groupBy === key ? " is-active" : ""}`}
                aria-pressed={groupBy === key}
                onClick={() => setGroupBy(key)}
              >
                {label}
              </button>
            ))}
          </div>
          {groupBy !== "all" && options.length > 0 && (
            <select
              className="select-sm"
              aria-label={groupBy === "org" ? "Organization" : teamLabel}
              value={selected ?? ""}
              onChange={(event) => setGroupValue(event.target.value)}
            >
              {options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          )}
          <div className="segmented segmented-sm" role="group" aria-label={`${title} totals`}>
            <button
              type="button"
              className={`segment${cumulative ? "" : " is-active"}`}
              aria-pressed={!cumulative}
              onClick={() => setCumulative(false)}
            >
              Per {stepLabel(plan)}
            </button>
            <button
              type="button"
              className={`segment${cumulative ? " is-active" : ""}`}
              aria-pressed={cumulative}
              onClick={() => setCumulative(true)}
            >
              Cumulative
            </button>
          </div>
        </div>
      </div>

      {data.length === 0 ? (
        <p className="chart-empty">No data</p>
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: -8 }}>
            <defs>
              {series.map((s) => (
                <linearGradient key={s.key} id={fillId(s.key)} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity={0.18} />
                  <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid vertical={false} stroke={GRID} />
            {onboarding && (
              <ReferenceArea
                x1={onboarding.from}
                x2={onboarding.to}
                fill={ATTENTION}
                fillOpacity={0.035}
                stroke={ATTENTION}
                strokeOpacity={0.25}
                strokeDasharray="2 4"
                label={{ value: "Onboarding window", position: "insideTopRight", fill: AXIS_TICK, fontSize: 11, dx: -4, dy: 4 }}
              />
            )}
            {todayLabel && (
              <ReferenceLine x={todayLabel} stroke={AXIS_TICK} strokeDasharray="3 3" strokeOpacity={0.6} />
            )}
            <XAxis
              dataKey="label"
              tick={{ fontSize: 12, fill: AXIS_TICK }}
              stroke={AXIS_LINE}
              tickLine={false}
              interval="preserveStartEnd"
              minTickGap={24}
            />
            <YAxis
              allowDecimals={false}
              domain={[0, scale.max]}
              ticks={scale.ticks}
              width={44}
              tick={{ fontSize: 12, fill: AXIS_TICK }}
              stroke="transparent"
              tickLine={false}
              axisLine={false}
            />
            <Tooltip cursor={{ stroke: CURSOR, strokeWidth: 1 }} {...tooltipProps} />
            <Legend verticalAlign="top" height={28} iconType="circle" iconSize={8} {...legendProps} />
            {series.map((s) => (
              <Area
                key={s.key}
                // Linear, not monotone: these are counts, and spline smoothing
                // would draw a gentle ramp through buckets where nothing landed.
                type="linear"
                dataKey={s.key}
                name={s.name}
                stroke={s.color}
                strokeWidth={1.5}
                fill={`url(#${fillId(s.key)})`}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0 }}
                animationDuration={200}
                animationEasing="ease-out"
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
