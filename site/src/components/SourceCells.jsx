import { parseSourceUrl } from "../sourceUrl.js";

// Kept in step with SOURCE_TYPE in src/liveMigrations.js.
const LIVE_SOURCE_TYPE = "Enterprise Live Migration";

// A live migration is read from the destination, whose migration record models
// where the data landed rather than where it came from. The blank is a property
// of the API, not of the migration, so it says so instead of reading as data
// the dashboard failed to load.
const NO_LIVE_SOURCE =
  "The destination does not report the source for a live migration; only the source appliance holds it";

// Only http(s) may become a link: the source URL is set by whoever created the
// migration, so any other scheme is shown as text rather than made clickable.
function safeHref(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

// The source repository name links back to the origin it was migrated from.
export default function SourceCells({ url, sourceType }) {
  const source = parseSourceUrl(url);
  if (!source) {
    const title = sourceType === LIVE_SOURCE_TYPE ? NO_LIVE_SOURCE : undefined;
    return (
      <>
        <td className="fg-muted" title={title}>—</td>
        <td className="fg-muted" title={title}>—</td>
      </>
    );
  }
  const href = safeHref(url);
  return (
    <>
      <td className="fg-muted">{source.namespace || "—"}</td>
      <td>
        {href ? (
          <a href={href} target="_blank" rel="noreferrer">
            {source.repository}
          </a>
        ) : (
          source.repository
        )}
      </td>
    </>
  );
}

export { safeHref };
