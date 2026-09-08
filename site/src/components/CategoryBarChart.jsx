import { useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { useChartTheme } from "../ThemeProvider.jsx";
import { limitCategories, DEFAULT_LIMIT } from "../topCategories.js";

// Horizontal categorical bar chart: one row per category, so long names read
// at full size and the chart grows with the data instead of squeezing it. Only
// the top `limit` categories are drawn; the rest roll into an "Other" row that
// stands for all of them, and a header link expands the full list.
//
// `series` is [{ key, name, color, filterValue }]; pass `stacked` to stack the
// series instead of grouping them. With `onSelect` there are three click
// targets, each cross-filtering the dashboard: a segment selects its category
// (`xKey` doubles as the filter dimension) AND its series; the category name on
// the axis selects the whole bar; a legend entry selects just that series.
// Selections accumulate so several organizations or teams can be compared.
const ROW_HEIGHT = 28;
const LEGEND_HEIGHT = 28;
const AXIS_HEIGHT = 24;
const MAX_LABEL_WIDTH = 150;
const LABEL_CHARS = 22;
// Average glyph advance at 12px in the system font stack, plus tick padding.
const PX_PER_CHAR = 6.4;
const LABEL_PADDING = 14;

function truncate(value) {
  const text = String(value ?? "");
  return text.length > LABEL_CHARS ? `${text.slice(0, LABEL_CHARS - 1)}…` : text;
}

// The label column is sized to the longest visible name, so a chart of short
// organization names does not carry the dead space a long team name needs.
function labelWidth(rows, xKey) {
  const longest = Math.max(0, ...rows.map((row) => truncate(row[xKey]).length));
  return Math.min(MAX_LABEL_WIDTH, Math.ceil(longest * PX_PER_CHAR) + LABEL_PADDING);
}

export default function CategoryBarChart({
  title,
  subtitle,
  data,
  xKey,
  series,
  stacked,
  limit = DEFAULT_LIMIT,
  activeValues = [],
  seriesDimension,
  activeSeriesValues = [],
  onSelect,
  onSelectCombination,
}) {
  const { tooltipProps, legendProps, AXIS_TICK, AXIS_LINE, LABEL, GRID, CURSOR } = useChartTheme();
  const [expanded, setExpanded] = useState(false);

  const { rows, hidden } = useMemo(
    () => limitCategories(data, xKey, { limit, expanded }),
    [data, xKey, limit, expanded],
  );
  const total = data.length;
  const canToggle = hidden > 0 || (expanded && total > limit);

  // The values a row stands for: itself, or everything folded into "Other".
  const valuesOf = (row) => (row?.rolledUp ? row.rolledUp : row ? [row[xKey]] : []);
  const rowSelected = (row) => valuesOf(row).some((value) => activeValues.includes(value));

  const handleSegmentClick = (s) => (entry) => {
    if (!onSelect) return;
    const row = entry?.payload ?? entry;
    const values = valuesOf(row);
    if (values.length === 0) return;
    const selections = values.map((value) => ({ dimension: xKey, value }));
    if (seriesDimension && s.filterValue != null) {
      selections.push({ dimension: seriesDimension, value: s.filterValue });
    }
    (onSelectCombination ?? onSelect)(selections);
  };

  // "Other" selects every value it stands for as one unit, so a second click
  // clears them all rather than toggling each independently.
  const handleCategoryClick = (row) => {
    if (!onSelect) return;
    const values = valuesOf(row);
    if (values.length === 0) return;
    const selections = values.map((value) => ({ dimension: xKey, value }));
    (row.rolledUp ? (onSelectCombination ?? onSelect) : onSelect)(selections);
  };

  const handleLegendClick = (entry) => {
    if (!onSelect || !seriesDimension) return;
    const s = series.find((candidate) => candidate.key === entry?.dataKey);
    if (s?.filterValue != null) onSelect([{ dimension: seriesDimension, value: s.filterValue }]);
  };

  const isDimmed = (row, s) =>
    (activeValues.length > 0 && !rowSelected(row)) ||
    (activeSeriesValues.length > 0 && s.filterValue != null && !activeSeriesValues.includes(s.filterValue));

  const isSeriesDimmed = (s) =>
    activeSeriesValues.length > 0 && s.filterValue != null && !activeSeriesValues.includes(s.filterValue);

  const legendFormatter = (value, entry) => {
    const s = series.find((candidate) => candidate.key === entry?.dataKey);
    return legendProps.formatter
      ? legendProps.formatter(value, entry, s && isSeriesDimmed(s))
      : value;
  };

  // Recharts' own tick, re-rendered so the category name is a click target;
  // selected names are emphasised, excluded ones faded like their bars.
  const rowByLabel = new Map(rows.map((row) => [row[xKey], row]));
  const CategoryTick = ({ x, y, payload }) => {
    const row = rowByLabel.get(payload?.value);
    const value = payload?.value;
    const selected = rowSelected(row);
    const dimmed = activeValues.length > 0 && !selected;
    return (
      <text
        x={x}
        y={y}
        dy="0.32em"
        textAnchor="end"
        fontSize={12}
        fontWeight={selected ? 600 : 400}
        fill={selected ? LABEL : AXIS_TICK}
        fillOpacity={dimmed ? 0.5 : 1}
        className={onSelect ? "axis-category" : undefined}
        onClick={onSelect && row ? () => handleCategoryClick(row) : undefined}
      >
        <title>{onSelect ? `Select all of ${value}` : value}</title>
        {truncate(value)}
      </text>
    );
  };

  // Height follows the row count so rows sit at the same pitch in every chart;
  // a chart with three rows is short and top-aligned, not stretched.
  const height = rows.length * ROW_HEIGHT + LEGEND_HEIGHT + AXIS_HEIGHT + 16;

  return (
    <div className="chart-card">
      <div className="chart-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p className="chart-subtitle">{subtitle}</p>}
        </div>
        {canToggle && (
          <button type="button" className="link-button" onClick={() => setExpanded((v) => !v)}>
            {expanded ? `Show top ${limit}` : `Show all ${total}`}
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="chart-empty">No data</p>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <BarChart
            data={rows}
            layout="vertical"
            margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
            barCategoryGap="30%"
          >
            <CartesianGrid horizontal={false} stroke={GRID} />
            <XAxis
              type="number"
              allowDecimals={false}
              tick={{ fontSize: 12, fill: AXIS_TICK }}
              stroke="transparent"
              tickLine={false}
              axisLine={false}
              height={AXIS_HEIGHT}
            />
            <YAxis
              type="category"
              dataKey={xKey}
              tick={CategoryTick}
              stroke={AXIS_LINE}
              tickLine={false}
              axisLine={false}
              interval={0}
              width={labelWidth(rows, xKey)}
            />
            <Tooltip cursor={{ fill: CURSOR }} {...tooltipProps} />
            <Legend
              verticalAlign="top"
              height={LEGEND_HEIGHT}
              iconType="circle"
              iconSize={8}
              {...legendProps}
              formatter={legendFormatter}
              onClick={onSelect && seriesDimension ? handleLegendClick : undefined}
              wrapperStyle={{
                ...legendProps.wrapperStyle,
                cursor: onSelect && seriesDimension ? "pointer" : undefined,
              }}
            />
            {series.map((s, index) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.name}
                fill={s.color}
                stackId={stacked ? "a" : undefined}
                // Round the end of whichever series sits at the end of the stack.
                radius={!stacked || index === series.length - 1 ? [0, 3, 3, 0] : undefined}
                maxBarSize={18}
                onClick={handleSegmentClick(s)}
                cursor={onSelect ? "pointer" : undefined}
                animationDuration={200}
                animationEasing="ease-out"
              >
                {rows.map((row) => (
                  <Cell
                    key={row[xKey]}
                    fill={s.color}
                    fillOpacity={isDimmed(row, s) ? 0.25 : 1}
                  />
                ))}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
