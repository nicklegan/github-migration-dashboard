import { activeFilterList } from "../crossFilter.js";
import Icon from "./Icon.jsx";

// Active chart selections as Primer Tokens — the same shape as labels on an
// issue — each removable on its own, plus a clear-all.
export default function CrossFilterBar({ filters, labels, onRemove, onClear }) {
  const active = activeFilterList(filters, labels);
  if (active.length === 0) return null;

  return (
    <div className="token-bar" role="status" aria-live="polite">
      <span className="token-bar-label">Filtered by</span>
      {active.map(({ dimension, value, label }) => (
        <span key={`${dimension}:${value}`} className="token">
          <span className="token-dim">{label}:</span>
          <span className="token-value">{value}</span>
          <button
            type="button"
            className="token-remove"
            onClick={() => onRemove(dimension, value)}
            aria-label={`Remove ${label} filter: ${value}`}
          >
            <Icon name="x" size={12} />
          </button>
        </span>
      ))}
      <button type="button" className="btn-link" onClick={onClear}>
        Clear all
      </button>
    </div>
  );
}
