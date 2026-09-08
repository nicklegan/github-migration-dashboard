// Turns table rows into CSV text. Pure logic, no DOM, so it unit-tests directly.

// A spreadsheet reads a leading =, +, -, @, tab, or carriage return as the start
// of a formula, which turns a repository or team name someone chose into
// something that executes when the export is opened. Prefixing an apostrophe
// makes the cell literal text; it is applied to strings only, so a negative
// number still reads as a number.
const FORMULA_START = /^[=+\-@\t\r]/;

function escapeCell(value) {
  if (value == null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";

  const text = FORMULA_START.test(value) ? `'${value}` : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// RFC 4180: CRLF line endings, and a trailing newline so appending is safe.
function toCsv(headers, rows) {
  const lines = [headers, ...rows].map((cells) => cells.map(escapeCell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

function csvFilename(prefix, now = new Date()) {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `${prefix}-${stamp}.csv`;
}

// The value a spreadsheet sorts on, rather than the reader's locale format the
// table shows.
function isoDate(value) {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

export { toCsv, escapeCell, csvFilename, isoDate };
