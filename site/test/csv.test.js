import { test } from "node:test";
import assert from "node:assert/strict";
import { toCsv, escapeCell, csvFilename, isoDate } from "../src/csv.js";

test("a plain value is written unquoted", () => {
  assert.equal(escapeCell("octo-repo"), "octo-repo");
  assert.equal(escapeCell(42), "42");
  assert.equal(escapeCell(2.5), "2.5");
});

test("an absent value is an empty cell, not the word null", () => {
  assert.equal(escapeCell(null), "");
  assert.equal(escapeCell(undefined), "");
  assert.equal(escapeCell(Number.NaN), "");
});

test("a boolean reads as true or false", () => {
  assert.equal(escapeCell(true), "true");
  assert.equal(escapeCell(false), "false");
});

test("separators and newlines are quoted, and quotes are doubled", () => {
  assert.equal(escapeCell("Payments, EU"), '"Payments, EU"');
  assert.equal(escapeCell('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCell("two\nlines"), '"two\nlines"');
});

// A repository or team name someone chose must not execute when the export is
// opened in a spreadsheet.
test("a value that would start a formula is neutralised", () => {
  assert.equal(escapeCell("=1+1"), "'=1+1");
  assert.equal(escapeCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(escapeCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
});

test("a negative number is still a number", () => {
  assert.equal(escapeCell(-3), "-3");
});

test("toCsv writes a header row and CRLF endings", () => {
  const csv = toCsv(["Repo", "State"], [["api", "SUCCEEDED"], ["web", "FAILED"]]);
  assert.equal(csv, "Repo,State\r\napi,SUCCEEDED\r\nweb,FAILED\r\n");
});

test("a header-only export is still valid CSV", () => {
  assert.equal(toCsv(["Repo"], []), "Repo\r\n");
});

test("the filename carries when the export was taken", () => {
  const at = new Date("2026-09-08T14:30:05.000Z");
  assert.equal(csvFilename("repository-migrations", at), "repository-migrations-2026-09-08-14-30-05.csv");
});

test("dates export as ISO so a spreadsheet can sort them", () => {
  assert.equal(isoDate("2026-01-03T00:00:00Z"), "2026-01-03T00:00:00.000Z");
  assert.equal(isoDate(null), "");
  assert.equal(isoDate("not a date"), "");
});
