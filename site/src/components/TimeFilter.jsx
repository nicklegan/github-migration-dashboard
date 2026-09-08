const RANGES = [
  ["all", "All time"],
  ["quarter", "3 months"],
  ["month", "Month"],
  ["week", "7 days"],
  ["day", "24 hours"],
];

// Primer SegmentedControl.
export default function TimeFilter({ value, onChange }) {
  return (
    <div className="segmented" role="tablist" aria-label="Time range">
      {RANGES.map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={value === key}
          className={`segment${value === key ? " is-active" : ""}`}
          onClick={() => onChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
