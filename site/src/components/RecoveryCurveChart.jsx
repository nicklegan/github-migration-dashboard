import { useMemo } from "react";
import {
  AreaChart,
  Area,
  ReferenceDot,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import { useChartTheme } from "../ThemeProvider.jsx";
import { recoveryCurve, lateRecoveries } from "../recovery.js";

const percent = (value) => `${Math.round(value * 100)}%`;

// How far into its own onboarding window a repository gets before it is running
// again. The x-axis is days since *that repository's* migration, so cohorts
// migrated months apart lie on top of each other and can be compared.
//
// The bands stack to the whole population, so nothing has to be inferred from
// empty space: what is running, what is half running, and what has not started.
// Repositories with no workflow to run are left out entirely — they have no
// recovery to chart, and as a band they only ever pushed the rest down.
export default function RecoveryCurveChart({ title, subtitle, rows, windowDays, nowMs, overall }) {
  const { tooltipProps, legendProps, AXIS_TICK, AXIS_LINE, GRID, CURSOR, SUCCESS, ATTENTION, DANGER, LABEL } =
    useChartTheme();

  // The days the summary quotes, so each figure can be pointed at on the line.
  const checkpoints = useMemo(() => Object.keys(overall?.by ?? {}).map(Number), [overall]);
  const { points, population, undated } = useMemo(
    () => recoveryCurve(rows, { windowDays, nowMs, extraDays: checkpoints }),
    [rows, windowDays, nowMs, checkpoints],
  );
  const late = useMemo(() => lateRecoveries(rows, windowDays), [rows, windowDays]);

  const reached = points.at(-1)?.day ?? 0;
  // The window edge is only worth drawing once some repositories have lived through it.
  const showWindow = windowDays > 0 && reached >= windowDays - 1e-9;
  // Leaving out the repositories that cannot be dated removes successes without
  // removing failures, so until most of them are dated the line reads far too
  // low. Better to say how far along the dating is than to draw that.
  const dated = population + undated > 0 ? population / (population + undated) : 1;
  const tooFewDated = points.length > 0 && dated < 0.75;

  const markers = checkpoints
    .map((day) => ({ day, point: points.find((p) => p.day === day) }))
    .filter((m) => m.point);
  const median = overall?.median;
  const medianOnChart = median?.days != null && median.days <= reached;

  return (
    <div className="chart-card">
      <div className="chart-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p className="chart-subtitle">{subtitle}</p>}
        </div>
      </div>
      {!tooFewDated && (
        <div className="figure-chips">
          {markers.map(({ day, point }) => (
            <div key={day} className="figure-chip">
              <span className="figure-chip-value">{percent(point.allGreen)}</span>
              <span className="figure-chip-label">fully green {day === 7 ? "within a week" : `within ${day} days`}</span>
            </div>
          ))}
          {median && (median.days != null || median.over != null) && (
            <div className="figure-chip">
              <span className="figure-chip-value">
                {median.days != null ? `day ${Math.round(median.days)}` : `> day ${median.over}`}
              </span>
              <span className="figure-chip-label">
                half fully green
                {median.days != null && windowDays > 0
                  ? median.days > windowDays
                    ? ` — after the ${windowDays}-day window`
                    : ` — inside the ${windowDays}-day window`
                  : ""}
              </span>
            </div>
          )}
        </div>
      )}
      {points.length === 0 || tooFewDated ? (
        <p className="chart-empty">
          {tooFewDated
            ? `Dated ${population.toLocaleString()} of ${(population + undated).toLocaleString()} repositories so far. ` +
              `The curve appears once most of them are dated — drawn now it would count the rest as never recovered.`
            : "No data"}
        </p>
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={points} margin={{ top: 22, right: 12, bottom: 0, left: -18 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis
              dataKey="day"
              type="number"
              domain={[0, Math.max(1, reached)]}
              tick={{ fill: AXIS_TICK, fontSize: 12 }}
              axisLine={{ stroke: AXIS_LINE }}
              tickLine={false}
              tickFormatter={(day) => `day ${Math.round(day)}`}
            />
            <YAxis
              domain={[0, 1]}
              tick={{ fill: AXIS_TICK, fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={percent}
            />
            <Tooltip
              cursor={{ stroke: CURSOR }}
              {...tooltipProps}
              formatter={(value, name) => [percent(value), name]}
              labelFormatter={(day) => `${Math.round(day)} days after migrating`}
            />
            {/* recharts sorts legend labels alphabetically by default, which
                scrambles a stack whose order is the point. */}
            <Legend
              verticalAlign="top"
              height={28}
              iconType="circle"
              iconSize={8}
              itemSorter={null}
              {...legendProps}
              formatter={(value) => legendProps.formatter?.(value, null, false) ?? value}
            />
            {showWindow && (
              <ReferenceLine
                x={windowDays}
                stroke={ATTENTION}
                strokeDasharray="4 4"
                label={{
                  value: "window closes",
                  fill: ATTENTION,
                  fontSize: 11,
                  position: "insideTopRight",
                  dy: -18,
                }}
              />
            )}
            {medianOnChart && (
              <ReferenceLine
                x={median.days}
                stroke={LABEL}
                strokeDasharray="2 3"
                label={{ value: "half fully green", fill: LABEL, fontSize: 11, position: "insideTopLeft", dy: -18 }}
              />
            )}
            <Area
              type="monotone"
              dataKey="allGreen"
              name="Every workflow green"
              stackId="onboarding"
              stroke={SUCCESS}
              fill={SUCCESS}
              fillOpacity={0.24}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="partlyGreen"
              name="Some workflows green"
              stackId="onboarding"
              stroke={ATTENTION}
              fill={ATTENTION}
              fillOpacity={0.14}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="notRunning"
              name="No workflow green yet"
              stackId="onboarding"
              stroke={DANGER}
              fill={DANGER}
              fillOpacity={0.14}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            {markers.map(({ day, point }) => (
              <ReferenceDot
                key={day}
                x={day}
                y={point.allGreen}
                r={4}
                fill={SUCCESS}
                stroke={LABEL}
                strokeWidth={1.5}
                label={{ value: percent(point.allGreen), position: "top", fill: LABEL, fontSize: 12, fontWeight: 600 }}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      )}
      {!tooFewDated && (
        <p className="chart-footnote">
          {population.toLocaleString()} repositories with workflows to run, each measured from its own
          migration. Day N counts only repositories migrated at least N days ago, so recent arrivals do
          not drag it down.
          {late > 0 && (
            <>
              {" "}
              A further {late.toLocaleString()} had every workflow green only after their window closed.
            </>
          )}
        </p>
      )}
    </div>
  );
}
