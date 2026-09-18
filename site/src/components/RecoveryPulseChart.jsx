import { useMemo } from "react";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { useChartTheme } from "../ThemeProvider.jsx";
import { recoveryPulse } from "../recovery.js";
import { timelinePlan, formatBucket } from "../timeline.js";

// Arrivals against recoveries, in calendar time. Bars are repositories landing;
// the line is repositories reaching fully green. While the line keeps up with
// the bars the programme is absorbing its own migrations — when the bars run
// ahead, a backlog is building, and the gap is its size.
export default function RecoveryPulseChart({ title, subtitle, rows, range, nowMs }) {
  const { tooltipProps, legendProps, AXIS_TICK, AXIS_LINE, GRID, CURSOR, SUCCESS, NEUTRAL } =
    useChartTheme();

  const { data, empty } = useMemo(() => {
    const plan = timelinePlan(range, rows, nowMs);
    if (!plan) return { data: [], empty: true };
    const series = recoveryPulse(rows, plan);
    return {
      data: series.map((point) => ({ ...point, label: formatBucket(point.at, plan) })),
      empty: series.every((point) => point.migrated === 0 && point.backOnline === 0),
    };
  }, [rows, range, nowMs]);

  return (
    <div className="chart-card">
      <div className="chart-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p className="chart-subtitle">{subtitle}</p>}
        </div>
      </div>
      {empty ? (
        <p className="chart-empty">No data</p>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: AXIS_TICK, fontSize: 12 }}
              axisLine={{ stroke: AXIS_LINE }}
              tickLine={false}
              minTickGap={24}
            />
            <YAxis
              tick={{ fill: AXIS_TICK, fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
            />
            <Tooltip cursor={{ fill: CURSOR }} {...tooltipProps} />
            {/* Recharts orders a composed chart's legend by series type, which
                puts the line first; the chart reads arrivals then recoveries. */}
            <Legend
              verticalAlign="top"
              height={28}
              iconType="circle"
              iconSize={8}
              {...legendProps}
              payload={[
                { value: "Migrated", type: "circle", color: NEUTRAL, id: "migrated" },
                { value: "Back online", type: "circle", color: SUCCESS, id: "backOnline" },
              ]}
            />
            <Bar dataKey="migrated" name="Migrated" fill={NEUTRAL} isAnimationActive={false} />
            <Line
              type="monotone"
              dataKey="backOnline"
              name="Back online"
              stroke={SUCCESS}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
      <p className="chart-footnote">
        Recoveries are dated when the repository's last workflow first passed, so they land after
        the migration that produced them — often well after.
      </p>
    </div>
  );
}
