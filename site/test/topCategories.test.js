import { test } from "node:test";
import assert from "node:assert/strict";
import { limitCategories } from "../src/topCategories.js";

const row = (team, succeeded, failed = 0) => ({ team, succeeded, failed });

test("everything fits: sorted by total, catch-all buckets last", () => {
  const { rows, hidden } = limitCategories(
    [row("Unassigned", 40), row("core", 5), row("mobility", 9, 1)],
    "team",
  );
  assert.equal(hidden, 0);
  assert.deepEqual(
    rows.map((r) => r.team),
    ["mobility", "core", "Unassigned"],
  );
});

test("beyond the limit the tail rolls into one Other row that remembers its values", () => {
  const data = Array.from({ length: 13 }, (_, i) => row(`team-${i}`, 20 - i, i % 2));
  const { rows, hidden } = limitCategories(data, "team", { limit: 10 });

  assert.equal(hidden, 3);
  assert.equal(rows.length, 11);
  const other = rows[10];
  assert.equal(other.team, "Other (3 more)");
  assert.deepEqual(other.rolledUp, ["team-10", "team-11", "team-12"]);
  assert.equal(other.succeeded, 10 + 9 + 8);
  assert.equal(other.failed, 0 + 1 + 0);
});

test("one category over the limit is shown rather than folded into Other", () => {
  const data = Array.from({ length: 11 }, (_, i) => row(`team-${i}`, 20 - i));
  const { rows, hidden } = limitCategories(data, "team", { limit: 10 });

  assert.equal(hidden, 0);
  assert.equal(rows.length, 11);
  assert.equal(rows.at(-1).team, "team-10");
});

test("a pinned bucket does not take one of the limited slots and stays last", () => {
  const data = [row("Unassigned", 999), ...Array.from({ length: 12 }, (_, i) => row(`t${i}`, 12 - i))];
  const { rows, hidden } = limitCategories(data, "team", { limit: 10 });

  assert.equal(hidden, 2);
  assert.equal(rows.at(-1).team, "Unassigned");
  assert.equal(rows.at(-2).team, "Other (2 more)");
  assert.equal(rows.length, 12);
});

test("expanded shows every category and still pins the catch-all last", () => {
  const org = (name, succeeded) => ({ org: name, succeeded, failed: 0 });
  const data = [org("Unknown", 1), ...Array.from({ length: 12 }, (_, i) => org(`o${i}`, 12 - i))];
  const { rows, hidden } = limitCategories(data, "org", { limit: 10, expanded: true });

  assert.equal(hidden, 0);
  assert.equal(rows.length, 13);
  assert.equal(rows.at(-1).org, "Unknown");
});
