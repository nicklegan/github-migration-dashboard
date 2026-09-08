import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { useChartTheme } from "../ThemeProvider.jsx";

// Donut with the total in the centre and one legend row per slice. Percentages
// live in the tooltip rather than around the ring, which keeps the card quiet.
// When `onSelect` is given, clicking a slice cross-filters the dashboard.
//
// The ring is pinned to an explicit centre and the total is an HTML overlay at
// the same point: recharts would otherwise centre the ring above the legend,
// and SVG text boxes carry descender space the digits never use, so the glyphs
// sat visibly high. In HTML the number-plus-caption pair is optically centred
// on the ring (see .donut-center).
const HEIGHT = 260;
const LEGEND = 24;
const CY = (HEIGHT - LEGEND) / 2;

export default function DonutChart({ title, subtitle, data, activeValues = [], onSelect }) {
  const { tooltipProps, legendProps, SLICE_STROKE } = useChartTheme();
  const total = data.reduce((sum, d) => sum + d.value, 0);

  const handleClick = (entry) => {
    if (!onSelect) return;
    const value = entry?.name ?? entry?.payload?.name;
    if (value != null) onSelect(value);
  };

  return (
    <div className="chart-card">
      <h2>{title}</h2>
      {subtitle && <p className="chart-subtitle">{subtitle}</p>}
      {total === 0 ? (
        <p className="chart-empty">No data</p>
      ) : (
        <div className="donut">
          <ResponsiveContainer width="100%" height={HEIGHT}>
          {/* Zero margin so CY is the same pixel for the ring and the overlay. */}
          <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy={CY}
              innerRadius={62}
              outerRadius={86}
              paddingAngle={2}
              cornerRadius={3}
              labelLine={false}
              onClick={handleClick}
              cursor={onSelect ? "pointer" : undefined}
              animationDuration={200}
              animationEasing="ease-out"
              stroke={SLICE_STROKE}
            >
              {data.map((slice) => (
                <Cell
                  key={slice.name}
                  fill={slice.color}
                  fillOpacity={activeValues.length === 0 || activeValues.includes(slice.name) ? 1 : 0.25}
                />
              ))}
            </Pie>
            <Tooltip
              {...tooltipProps}
              formatter={(value, name) => [`${value.toLocaleString()} · ${((value / total) * 100).toFixed(1)}%`, name]}
            />
            <Legend
              verticalAlign="bottom"
              height={LEGEND}
              iconType="circle"
              iconSize={8}
              {...legendProps}
              formatter={(value, entry) =>
                legendProps.formatter?.(value, entry, activeValues.length > 0 && !activeValues.includes(value)) ?? value
              }
              onClick={onSelect ? (entry) => handleClick({ name: entry?.value }) : undefined}
              wrapperStyle={{ ...legendProps.wrapperStyle, cursor: onSelect ? "pointer" : undefined }}
            />
          </PieChart>
          </ResponsiveContainer>
          <div className="donut-center" style={{ top: CY }} aria-hidden="true">
            <span className="donut-total">{total.toLocaleString()}</span>
            <span className="donut-caption">total</span>
          </div>
        </div>
      )}
    </div>
  );
}
