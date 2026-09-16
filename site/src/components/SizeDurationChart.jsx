import { useMemo } from "react";
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { useChartTheme } from "../ThemeProvider.jsx";
import { oneDecimal } from "../format.js";

// Repository size against how long it took to migrate, one series per source
// platform. Sizes span five orders of magnitude on a real estate, so the size
// axis is logarithmic — on a linear one every repository but the largest would
// sit on the y-axis.
const HEIGHT = 300;
const LEGEND_HEIGHT = 44;
const DECADES = [0.01, 0.1, 1, 10, 100, 1000, 10000, 100000];

// Ticks at the powers of ten the data actually spans, so the axis reads as
// 1 · 10 · 100 rather than at whatever interval recharts picks for a log scale.
function logTicks(min, max) {
  const ticks = DECADES.filter((t) => t >= min && t <= max);
  return ticks.length >= 2 ? ticks : [min, max];
}

function axisLabel(value) {
  if (value >= 1000) return `${Math.round(value / 1000)} GB`;
  if (value >= 1) return `${Math.round(value)} MB`;
  return `${value} MB`;
}

export default function SizeDurationChart({ title, subtitle, series, footnote, wide }) {
  const { tooltipProps, legendProps, AXIS_TICK, AXIS_LINE, GRID, CURSOR } = useChartTheme();

  const { domain, ticks } = useMemo(() => {
    const sizes = series.flatMap((s) => s.points.map((p) => p.sizeMB));
    if (sizes.length === 0) return { domain: [1, 10], ticks: [1, 10] };
    // Pad by a decade edge either side so points never sit on the axis line.
    const low = Math.min(...sizes);
    const high = Math.max(...sizes);
    const min = DECADES.filter((d) => d <= low).pop() ?? low;
    const max = DECADES.find((d) => d >= high) ?? high;
    return { domain: [min, max], ticks: logTicks(min, max) };
  }, [series]);

  const renderTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const point = payload[0].payload;
    return (
      <div style={tooltipProps.contentStyle}>
        <div style={tooltipProps.labelStyle}>
          {point.organization}/{point.repository}
        </div>
        <div style={tooltipProps.itemStyle}>
          {oneDecimal(point.sizeMB)} MB · {point.minutes} min
        </div>
      </div>
    );
  };

  const empty = series.every((s) => s.points.length === 0);

  return (
    <div className={`chart-card${wide ? " chart-card-wide" : ""}`}>
      <h2>{title}</h2>
      {subtitle && <p className="chart-subtitle">{subtitle}</p>}
      {empty ? (
        <p className="chart-empty">No repository has both a size and a duration recorded</p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={HEIGHT}>
            <ScatterChart margin={{ top: 16, right: 16, bottom: 20, left: 0 }}>
              <CartesianGrid stroke={GRID} />
              <XAxis
                type="number"
                dataKey="sizeMB"
                scale="log"
                domain={domain}
                ticks={ticks}
                tickFormatter={axisLabel}
                tick={{ fill: AXIS_TICK, fontSize: 12 }}
                axisLine={{ stroke: AXIS_LINE }}
                tickLine={false}
                name="Size"
              />
              <YAxis
                type="number"
                dataKey="minutes"
                allowDecimals={false}
                tick={{ fill: AXIS_TICK, fontSize: 12 }}
                axisLine={{ stroke: AXIS_LINE }}
                tickLine={false}
                width={56}
                name="Minutes"
                unit=" min"
              />
              <Tooltip content={renderTooltip} cursor={{ stroke: CURSOR }} />
              {series.length > 1 && (
                <Legend
                  verticalAlign="bottom"
                  height={LEGEND_HEIGHT}
                  iconType="circle"
                  {...legendProps}
                  // recharts passes the entry's index as the third argument,
                  // which the theme's formatter reads as "dimmed"; nothing is
                  // dimmed here, so it is passed explicitly.
                  formatter={(value) => legendProps.formatter?.(value, null, false) ?? value}
                />
              )}
              {series.map((s) => (
                <Scatter
                  key={s.platform}
                  name={s.platform}
                  data={s.points}
                  fill={s.color}
                  fillOpacity={0.75}
                  isAnimationActive={false}
                />
              ))}
            </ScatterChart>
          </ResponsiveContainer>
          {footnote && <p className="chart-footnote">{footnote}</p>}
        </>
      )}
    </div>
  );
}
