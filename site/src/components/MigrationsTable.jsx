import { Fragment, useMemo, useState } from "react";
import { oneDecimal, dateTime } from "../format.js";
import { targetUrl } from "../targetUrl.js";
import { platformOf } from "../sourcePlatform.js";
import { migrationCsv } from "../exportRows.js";
import { loadDetail } from "../api.js";
import SourceCells from "./SourceCells.jsx";
import ExportCsvButton from "./ExportCsvButton.jsx";
import Blankslate from "./Blankslate.jsx";
import Icon from "./Icon.jsx";
import { useSort, SortableTh, OrgCell } from "./table.jsx";
import { useFillViewport } from "../useFillViewport.js";

// Only a repository that exists on the target is linked; targetUrl decides.
function TargetRepository({ row, serverUrl }) {
  const href = targetUrl(serverUrl, row);
  const name = href ? (
    <a href={href} target="_blank" rel="noreferrer">
      {row.repository}
    </a>
  ) : (
    row.repository
  );
  return (
    <span className="cell-inline">
      <Icon name="repo" className="fg-muted" />
      <span className="text-bold">{name}</span>
    </span>
  );
}

function StateLabel({ state }) {
  return <span className={`state state-${String(state).toLowerCase()}`}>{state}</span>;
}

// Every attempt at a repository, oldest first, as rows under the repository's
// own columns. The toggle column carries a timeline dot and connector so the
// sequence still reads as one, without giving up the column alignment.
function AttemptRows({ attempts }) {
  const ordered = [...attempts].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return ordered.map((attempt, index) => (
    <tr key={attempt.id} className="nested-row attempt-row">
      <td className="toggle-col">
        <span
          className={`timeline-dot state-${String(attempt.state).toLowerCase()}${index === 0 ? " is-first" : ""}${index === ordered.length - 1 ? " is-last" : ""}`}
          aria-hidden="true"
        >
          <Icon name="dot-fill" size={12} />
        </span>
      </td>
      <td>
        <StateLabel state={attempt.state} />
      </td>
      <td />
      <td>
        <span className="fg-muted">Attempt {index + 1}</span>
        {attempt.failureReason && <span className="label label-danger" title={attempt.failureReason}>{attempt.failureReason}</span>}
      </td>
      <td className="fg-muted" title={attempt.sourceType || undefined}>{platformOf(attempt)}</td>
      <SourceCells url={attempt.sourceUrl} sourceType={attempt.sourceType} />
      <td>{attempt.team || <span className="fg-muted">—</span>}</td>
      <td className="fg-muted">{dateTime(attempt.createdAt)}</td>
      <td className="num">{oneDecimal(attempt.durationMinutes)}</td>
      <td className="num">{attempt.warningsCount ?? 0}</td>
      <td className="num">{oneDecimal(attempt.repoSizeMB)}</td>
    </tr>
  ));
}

const COLUMNS = {
  state: (r) => r.state,
  organization: (r) => r.organization,
  repository: (r) => r.repository,
  sourceType: (r) => platformOf(r),
  team: (r) => r.team,
  createdAt: (r) => r.createdAt,
  durationMinutes: (r) => r.durationMinutes,
  warningsCount: (r) => r.warningsCount ?? 0,
  repoSizeMB: (r) => r.repoSizeMB,
};

// Searchable table of every migrated repository. Each row is one target repo;
// repeated attempts fold underneath it as a timeline.
export default function MigrationsTable({ repositories, teamLabel = "Team", serverUrl = null, hasFilters = false, onClearFilters }) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(() => new Set());
  const [details, setDetails] = useState(() => new Map());

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return repositories;
    return repositories.filter(
      (row) =>
        row.repository.toLowerCase().includes(q) ||
        row.organization.toLowerCase().includes(q) ||
        (row.team || "").toLowerCase().includes(q) ||
        (row.sourceType || "").toLowerCase().includes(q) ||
        platformOf(row).toLowerCase().includes(q) ||
        row.state.toLowerCase().includes(q),
    );
  }, [repositories, query]);

  const { sorted: rows, sort, toggle: toggleSort } = useSort(filtered, COLUMNS);
  const scrollRef = useFillViewport([rows.length > 0]);

  const toggle = async (row) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });

    if (!details.has(row.id)) {
      const bucket = await loadDetail(row.d);
      setDetails((current) => new Map(current).set(row.id, bucket[row.id]?.attempts ?? []));
    }
  };

  const columnCount = 12;

  return (
    <section className="table-section">
      <div className="table-header">
        <h2>
          Repositories
          <span className="counter">{rows.length.toLocaleString()}</span>
        </h2>
        <div className="table-tools">
          <label className="input-icon">
            <Icon name="search" className="fg-muted" />
            <input
              type="search"
              placeholder={`Filter by repo, org, ${teamLabel.toLowerCase()}, source, or state`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <ExportCsvButton
            prefix="repository-migrations"
            disabled={rows.length === 0}
            build={() => migrationCsv(rows, { teamLabel, serverUrl })}
          />
        </div>
      </div>

      {rows.length === 0 ? (
        <Blankslate
          icon="inbox"
          heading="No repositories match"
          action={
            (hasFilters || query) && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setQuery("");
                  onClearFilters?.();
                }}
              >
                Clear filters
              </button>
            )
          }
        >
          {query ? "Try a different search, or clear the filters." : "Nothing in this time range matches the current selection."}
        </Blankslate>
      ) : (
        <div className="table-scroll" ref={scrollRef}>
          <table>
            <thead>
              <tr>
                <th className="toggle-col" aria-label="Expand attempts" />
                <SortableTh column="state" sort={sort} onToggle={toggleSort}>State</SortableTh>
                <SortableTh column="organization" sort={sort} onToggle={toggleSort}>Organization</SortableTh>
                <SortableTh column="repository" sort={sort} onToggle={toggleSort}>Repository</SortableTh>
                <SortableTh column="sourceType" sort={sort} onToggle={toggleSort}>Source</SortableTh>
                <th>Source namespace</th>
                <th>Source repository</th>
                <SortableTh column="team" sort={sort} onToggle={toggleSort}>{teamLabel}</SortableTh>
                <SortableTh column="createdAt" sort={sort} onToggle={toggleSort}>Migrated</SortableTh>
                <SortableTh column="durationMinutes" sort={sort} onToggle={toggleSort} className="num">Duration (min)</SortableTh>
                <SortableTh column="warningsCount" sort={sort} onToggle={toggleSort} className="num">Warnings</SortableTh>
                <SortableTh column="repoSizeMB" sort={sort} onToggle={toggleSort} className="num">Size (MB)</SortableTh>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const folded = row.attemptCount > 1;
                const isOpen = folded && expanded.has(row.id);
                return (
                  <Fragment key={row.id}>
                    <tr className={isOpen ? "is-expanded" : undefined}>
                      <td className="toggle-col">
                        {folded && (
                          <button
                            type="button"
                            className="row-toggle"
                            aria-expanded={isOpen}
                            aria-label={`${isOpen ? "Collapse" : "Expand"} ${row.attemptCount} attempts for ${row.id}`}
                            onClick={() => toggle(row)}
                          >
                            <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={12} />
                          </button>
                        )}
                      </td>
                      <td>
                        <StateLabel state={row.state} />
                      </td>
                      <OrgCell serverUrl={serverUrl} org={row.organization} />
                      <td>
                        <TargetRepository row={row} serverUrl={serverUrl} />
                        {folded && <span className="counter counter-sm">{row.attemptCount} attempts</span>}
                        {row.removed && (
                          <span className="label label-danger" title={`Migrated successfully, then deleted on the target ${dateTime(row.deletedAt)}`}>
                            removed
                          </span>
                        )}
                        {row.supersededBy && (
                          <span className="label label-done" title={`Source migrated successfully into ${row.supersededBy}`}>
                            superseded
                          </span>
                        )}
                        {row.onboarding === "incomplete" && (
                          <span className="label label-attention" title="Onboarding window closed with workflows still failing or never run">
                            onboarding incomplete
                          </span>
                        )}
                      </td>
                      <td className="fg-muted" title={row.sourceType || undefined}>{platformOf(row)}</td>
                      <SourceCells url={row.sourceUrl} sourceType={row.sourceType} />
                      <td>{row.team || <span className="fg-muted">—</span>}</td>
                      <td className="fg-muted">{dateTime(row.createdAt)}</td>
                      <td className="num">{oneDecimal(row.durationMinutes)}</td>
                      <td className="num">{row.warningsCount ?? 0}</td>
                      <td className="num">{oneDecimal(row.repoSizeMB)}</td>
                    </tr>
                    {isOpen &&
                      (details.has(row.id) ? (
                        <AttemptRows attempts={details.get(row.id)} />
                      ) : (
                        <tr className="nested-row">
                          <td className="toggle-col" />
                          <td colSpan={columnCount - 1} className="fg-muted">
                            Loading attempts…
                          </td>
                        </tr>
                      ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
