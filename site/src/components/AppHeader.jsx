import Icon from "./Icon.jsx";
import ThemeToggle from "./ThemeToggle.jsx";
import { dateTime } from "../format.js";

// A slim app header and a Primer Subhead, in place of a hero. The header carries
// identity and the theme switch; the subhead carries the page title, a line of
// context, and the run's provenance as labels.
export default function AppHeader({ summary }) {
  return (
    <>
      <div className="app-header">
        <a className="app-header-brand" href="./" aria-label="Migration dashboard home">
          <Icon name="mark-github" size={32} />
        </a>
        <nav className="app-header-context" aria-label="Breadcrumb">
          <span className="app-header-crumb">{summary.enterprise ?? "Enterprise"}</span>
          <span className="app-header-sep" aria-hidden="true">/</span>
          <span className="app-header-crumb is-current">Migration dashboard</span>
        </nav>
        <div className="app-header-actions">
          <ThemeToggle />
        </div>
      </div>

      <div className="subhead-wrap">
        <div className="subhead">
          <div className="subhead-heading">
            <h1>Migration dashboard</h1>
            <p className="subhead-description">
              Repository and Actions workflow migrations across GitHub Enterprise Cloud
            </p>
          </div>
          <div className="subhead-actions">
            <span className="subhead-meta">
              <Icon name="organization" />
              <strong>{summary.organizations.length.toLocaleString()}</strong> organizations
            </span>
            {summary.generatedAt && (
              <span className="subhead-meta" title={new Date(summary.generatedAt).toISOString()}>
                <Icon name="clock" />
                Updated <strong>{dateTime(summary.generatedAt)}</strong>
              </span>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
