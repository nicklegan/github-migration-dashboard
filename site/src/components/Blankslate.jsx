import Icon from "./Icon.jsx";

// Primer Blankslate: an icon, a heading, a line of context, and optionally one
// action. Used for empty results and for loading, so an empty table never
// renders as a bare line of text.
export default function Blankslate({ icon, spinner = false, heading, children, action }) {
  return (
    <div className="blankslate" role={spinner ? "status" : undefined} aria-live={spinner ? "polite" : undefined}>
      {spinner ? <span className="spinner" aria-hidden="true" /> : icon && <Icon name={icon} size={24} className="blankslate-icon" />}
      {heading && <h3 className="blankslate-heading">{heading}</h3>}
      {children && <p className="blankslate-text">{children}</p>}
      {action && <div className="blankslate-action">{action}</div>}
    </div>
  );
}

// Placeholder rows shown while row chunks are still streaming in, so the table
// keeps its shape instead of collapsing to a message and jumping back.
export function TableSkeleton({ columns = 8, rows = 8 }) {
  const widths = [28, 90, 140, 180, 110, 90, 140, 90, 130, 70, 60, 80];
  return (
    <div className="table-scroll">
      <table aria-hidden="true">
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r} className="skeleton-row">
              {Array.from({ length: columns }, (_, c) => (
                <td key={c}>
                  <span className="skeleton" style={{ width: widths[c % widths.length] * (0.7 + ((r * 7 + c * 3) % 5) / 10) }} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
