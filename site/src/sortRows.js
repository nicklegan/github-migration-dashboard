// Comparator behind the tables' column sort. Pure, so it unit-tests directly.

function compare(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

// Rows without a value sink to the bottom in both directions. Applying the
// direction to the blank check as well would flip every blank duration to the
// top of a descending sort, above the longest migration.
function compareWithBlanksLast(a, b, dir = 1) {
  const aBlank = a == null || a === "";
  const bBlank = b == null || b === "";
  if (aBlank && bBlank) return 0;
  if (aBlank) return 1;
  if (bBlank) return -1;
  return dir * compare(a, b);
}

export { compare, compareWithBlanksLast };
