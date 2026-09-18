import { useMemo } from "react";
import {
  AreaChart,
  Area,
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
// The two lines are meant to cross: repositories climb into the part-way line
// first and out of it as they finish, so a healthy programme shows the amber
// falling as the green rises. Amber left standing at the window edge is the
// population that never finished.
export default function RecoveryCurveChart({ title, subtitle, rows, windowDays, nowMs }) {
  const { tooltipProps, legendProps, AXIS_TICK, AXIS_LINE, GRID, CURSOR, SUCCESS, ATTENTION } =
    useChartTheme();

  const { points, population, undated } = useMemo(
    () => recoveryCurve(rows, { windowDays, nowMs }),
    [rows, windowDays, nowMs],
  );
  const late = useMemo(() => lateRecoveries(rows, windowDays), [rows, windowDays]);

  const reached = points.at(-1)?.day ?? 0;
  // The window edge is only worth drawing once some cohort has lived through it.
  const showWindow = windowDays > 0 && reached >= windowDays - 1e-9;
  // Leaving out the repositories that cannot be dated removes successes without
  // removing failures, so until most of them are dated the line reads far too
  // low. Better to say how far along the dating is than to draw that.
  const dated = population + undated > 0 ? population / (population + undated) : 1;
  const tooFewDated = points.length > 0 && dated < 0.75;

  return (
    <div className="chart-card">
      <div className="chart-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p className="chart-subtitle">{subtitle}</p>}
        </div>
      </div>
      {points.length === 0 || tooFewDated ? (
        <p className="chart-empty">
          {tooFewDated
            ? `Dated ${population.toLocaleString()} of ${(population + undated).toLocaleString()} repositories so far. ` +
              `The curve appears once most of them are dated — drawn now it would count the rest as never recovered.`
            : "No data"}
        </p>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis
              dataKey="day"
              type="number"
              domain={[0, Math.max(1, reached)]}
              tick={{ fill: AXIS_TICK, fontSize: 12 }}
              axisLine={{ stroke: AXIS_LINE }}
              tickLine={false}
              tickFormatter={(day) => `${Math.round(day)}d`}
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
            <Legend verticalAlign="top" height={28} iconType="circle" iconSize={8} {...legendProps} />
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
                }}
              />
            )}
            <Area
              type="monotone"
              dataKey="partlyGreen"
              name="Partly onboarded"
              stroke={ATTENTION}
              fill={ATTENTION}
              fillOpacity={0.08}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="allGreen"
              name="Onboarded"
              stroke={SUCCESS}
              fill={SUCCESS}
              fillOpacity={0.16}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
      {!tooFewDated && (
        <p className="chart-footnote">
          {population.toLocaleString()} migrated repositories. Each day counts only the repositories
          that have had that long since migrating, so the curve is not dragged down by this week's
          arrivals.
          {late > 0 && (
            <>
              {" "}
              A further {late.toLocaleString()} came back only after their window closed. The cards
              above count them as onboarded, because they measure where repositories stand today;
              this curve does not, because it measures what happened inside the window.
            </>
          )}
        </p>
      )}
    </div>
  );
}
