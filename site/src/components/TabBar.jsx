// Primer UnderlineNav: plain text items with a 2px accent underline on the
// current one and a Counter beside each. Styled as navigation rather than a
// segmented control so it never reads as another filter — the tabs change what
// you are looking at, the controls narrow it.
export default function TabBar({ tabs, value, onChange, children }) {
  return (
    <div className="underline-nav-row">
      <nav className="underline-nav" role="tablist" aria-label="Dashboard sections">
        {tabs.map(({ key, label, icon, count }) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`tab-${key}`}
            aria-selected={value === key}
            aria-controls={`panel-${key}`}
            className={`underline-nav-item${value === key ? " is-current" : ""}`}
            onClick={() => onChange(key)}
          >
            {icon}
            {label}
            {count != null && <span className="counter">{count.toLocaleString()}</span>}
          </button>
        ))}
      </nav>
      {children && <div className="underline-nav-actions">{children}</div>}
    </div>
  );
}
