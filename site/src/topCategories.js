// Trims a categorical breakdown to what a chart can label legibly: the top
// `limit` categories by total, the rest rolled into one "Other" row, and any
// catch-all buckets (Unassigned, Unknown) pinned to the bottom so the largest
// slot is never taken by "nobody owns this".
//
// The "Other" row keeps the values it stands for in `rolledUp`, so clicking it
// can select all of them and dimming can follow whichever of them is selected.
// (`other` is already a series key — the count of in-flight states — so the
// marker is named to avoid it.)

const DEFAULT_LIMIT = 10;
const PINNED = new Set(["Unassigned", "Unknown"]);

function totalOf(row, xKey) {
  let total = 0;
  for (const [key, value] of Object.entries(row)) {
    if (key !== xKey && typeof value === "number") total += value;
  }
  return total;
}

function sumRows(rows, xKey, label) {
  const other = { [xKey]: label, rolledUp: rows.map((row) => row[xKey]) };
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (key !== xKey && typeof value === "number") other[key] = (other[key] ?? 0) + value;
    }
  }
  return other;
}

// Returns { rows, hidden } where `hidden` is how many categories the "Other"
// row stands for (0 when everything fits). `expanded` shows every category
// while still keeping the pinned buckets last.
function limitCategories(data, xKey, { limit = DEFAULT_LIMIT, expanded = false } = {}) {
  const pinned = data.filter((row) => PINNED.has(row[xKey]));
  const named = data
    .filter((row) => !PINNED.has(row[xKey]))
    .sort((a, b) => totalOf(b, xKey) - totalOf(a, xKey));

  // "Other (1 more)" takes the row it would save, so only fold two or more.
  if (expanded || named.length <= limit + 1) {
    return { rows: [...named, ...pinned], hidden: 0 };
  }

  const shown = named.slice(0, limit);
  const rest = named.slice(limit);
  const other = sumRows(rest, xKey, `Other (${rest.length} more)`);
  return { rows: [...shown, other, ...pinned], hidden: rest.length };
}

export { limitCategories, DEFAULT_LIMIT, PINNED };
