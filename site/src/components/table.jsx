import { useMemo, useState } from "react";
import Icon from "./Icon.jsx";
import { dateTime } from "../format.js";
import { compareWithBlanksLast } from "../sortRows.js";

// Column sorting shared by both tables. `columns` maps a key to an accessor; the
// hook returns the sorted rows and a header cell that toggles direction.
export function useSort(rows, columns, initial = null) {
  const [sort, setSort] = useState(initial);

  const sorted = useMemo(() => {
    if (!sort || !columns[sort.key]) return rows;
    const accessor = columns[sort.key];
    const dir = sort.dir === "desc" ? -1 : 1;
    return [...rows].sort((x, y) => compareWithBlanksLast(accessor(x), accessor(y), dir));
  }, [rows, sort, columns]);

  // A plain two-state toggle. There is no unsorted state to cycle back to:
  // both tables open on a default sort, so "unsorted" would just be a dead
  // click on whichever column already holds it.
  const toggle = (key) =>
    setSort((current) => {
      if (current?.key !== key) return { key, dir: "asc" };
      return { key, dir: current.dir === "asc" ? "desc" : "asc" };
    });

  return { sorted, sort, toggle };
}

export function SortableTh({ column, sort, onToggle, children, className }) {
  const active = sort?.key === column;
  const dir = active ? sort.dir : null;
  return (
    <th
      className={`${className ?? ""}${active ? " is-sorted" : ""}`.trim() || undefined}
      aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
    >
      <button type="button" className="th-sort" onClick={() => onToggle(column)}>
        {children}
        <Icon name={dir === "desc" ? "sort-desc" : "sort-asc"} size={14} className={`th-sort-icon${active ? " is-active" : ""}`} />
      </button>
    </th>
  );
}

// Organizations have an avatar on every GitHub host at /<login>.png; a broken
// image falls back to the initial so the row never shows a missing-image glyph.
export function OrgAvatar({ serverUrl, org, size = 20 }) {
  const [failed, setFailed] = useState(false);
  if (!serverUrl || failed) {
    return (
      <span className="avatar avatar-fallback" style={{ width: size, height: size, fontSize: size * 0.5 }} aria-hidden="true">
        {String(org ?? "?").charAt(0).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      className="avatar"
      src={`${String(serverUrl).replace(/\/+$/, "")}/${encodeURIComponent(org)}.png?size=${size * 2}`}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

export function OrgCell({ serverUrl, org }) {
  return (
    <td>
      <span className="cell-inline">
        <OrgAvatar serverUrl={serverUrl} org={org} />
        {org}
      </span>
    </td>
  );
}

// A repository renamed or transferred after migrating is listed where it lives
// now, so the name it was migrated under is worth saying — it is what the
// migration records, the source system, and any runbook still call it.
export function MovedLabel({ row }) {
  if (!row?.movedFrom) return null;
  const slash = row.movedFrom.indexOf("/");
  const sameOrg = row.movedFrom.slice(0, slash) === row.organization;
  const when = row.movedAt ? ` Noticed ${dateTime(row.movedAt)}.` : "";
  return (
    <span className="label" title={`Migrated as ${row.movedFrom}.${when}`}>
      {/* A rename within the organization repeats it otherwise. */}
      was {sameOrg ? row.movedFrom.slice(slash + 1) : row.movedFrom}
    </span>
  );
}
