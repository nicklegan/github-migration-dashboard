// Chart styling, read back from the CSS custom properties so the charts and the
// page around them cannot drift apart. recharts sets colours as SVG attributes,
// which do not resolve var(), so they have to be concrete strings.

import { createElement } from "react";

const TOKENS = [
  "--chart-axis-tick",
  "--chart-axis-line",
  "--chart-grid",
  "--chart-label",
  "--chart-slice-stroke",
  "--chart-cursor",
  "--chart-tooltip-bg",
  "--chart-tooltip-border",
  "--chart-tooltip-fg",
  "--chart-tooltip-muted",
  "--chart-tooltip-shadow",
  "--chart-success",
  "--chart-danger",
  "--chart-neutral",
  "--chart-superseded",
  "--chart-in-progress",
  "--chart-queued",
  "--chart-paused",
  "--chart-pending",
];

// Only reached when there is no document to read from (tests, server rendering).
const FALLBACK = {
  AXIS_TICK: "#768390",
  AXIS_LINE: "#444c56",
  GRID: "#373e47",
  LABEL: "#cdd9e5",
  SLICE_STROKE: "#22272e",
  CURSOR: "rgba(99, 110, 123, 0.15)",
  SUCCESS: "#57ab5a",
  DANGER: "#e5534b",
  NEUTRAL: "#636e7b",
  ATTENTION: "#c69026",
  stateColors: {},
  tooltipProps: {},
  legendProps: {},
};

// A custom property holds an unresolved token stream, so light-dark() only
// collapses when the value is *used* as a colour — reading the variable back
// directly yields the literal "light-dark(a, b)". Assigning it to a real colour
// property on a throwaway element is what forces it to resolve.
function resolveTokens(host) {
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.display = "none";
  host.appendChild(probe);

  const resolved = {};
  try {
    for (const name of TOKENS) {
      probe.style.color = `var(${name})`;
      resolved[name] = getComputedStyle(probe).color;
    }
  } finally {
    probe.remove();
  }
  return resolved;
}

function readChartTheme() {
  if (typeof document === "undefined" || !document.body) return FALLBACK;

  const resolved = resolveTokens(document.body);
  const token = (name) => resolved[name];

  const tooltipFg = token("--chart-tooltip-fg");
  const tooltipMuted = token("--chart-tooltip-muted");

  return {
    AXIS_TICK: token("--chart-axis-tick"),
    AXIS_LINE: token("--chart-axis-line"),
    GRID: token("--chart-grid"),
    LABEL: token("--chart-label"),
    SLICE_STROKE: token("--chart-slice-stroke"),
    CURSOR: token("--chart-cursor"),
    SUCCESS: token("--chart-success"),
    DANGER: token("--chart-danger"),
    NEUTRAL: token("--chart-neutral"),
    ATTENTION: token("--chart-in-progress"),
    stateColors: {
      SUCCEEDED: token("--chart-success"),
      FAILED: token("--chart-danger"),
      SUPERSEDED: token("--chart-superseded"),
      IN_PROGRESS: token("--chart-in-progress"),
      QUEUED: token("--chart-queued"),
      PAUSED: token("--chart-paused"),
      PENDING: token("--chart-pending"),
      PENDING_VALIDATION: token("--chart-pending"),
    },
    tooltipProps: {
      // Primer Popover: 8px radius, large shadow, no separators.
      contentStyle: {
        background: token("--chart-tooltip-bg"),
        border: `1px solid ${token("--chart-tooltip-border")}`,
        borderRadius: 8,
        color: tooltipFg,
        fontSize: 12,
        lineHeight: 1.5,
        padding: "8px 12px",
        boxShadow: `0 8px 24px ${token("--chart-tooltip-shadow")}`,
      },
      itemStyle: { color: tooltipFg, padding: 0 },
      labelStyle: { color: tooltipMuted, marginBottom: 4, fontWeight: 600 },
    },
    legendProps: {
      wrapperStyle: { color: tooltipMuted, fontSize: 12 },
      // recharts tints each label with its series colour, which would put a
      // fill colour behind 12px text; the swatch already carries the mapping.
      // `dimmed` fades entries the current selection excludes.
      formatter: (value, _entry, dimmed = false) =>
        createElement("span", { style: { color: tooltipMuted, opacity: dimmed ? 0.4 : 1 } }, value),
    },
  };
}

export { readChartTheme, FALLBACK, TOKENS };
