import { test } from "node:test";
import assert from "node:assert/strict";
import { compareWithBlanksLast } from "../src/sortRows.js";

const sortBy = (values, dir) => [...values].sort((a, b) => compareWithBlanksLast(a, b, dir));

test("numbers sort numerically in both directions", () => {
  assert.deepEqual(sortBy([3, 45, 2, 10], 1), [2, 3, 10, 45]);
  assert.deepEqual(sortBy([3, 45, 2, 10], -1), [45, 10, 3, 2]);
});

// The bug: a plain `dir * compare(a, b)` flipped the null ordering too, so a
// descending sort on duration led with every undated migration.
test("blank values stay at the bottom whichever way the column is sorted", () => {
  assert.deepEqual(sortBy([3, null, 45, undefined, 2], 1), [2, 3, 45, null, undefined]);
  assert.deepEqual(sortBy([3, null, 45, undefined, 2], -1), [45, 3, 2, null, undefined]);
  assert.deepEqual(sortBy(["b", "", "a"], -1), ["b", "a", ""]);
});

test("strings sort naturally and case-insensitively", () => {
  assert.deepEqual(sortBy(["repo-10", "Repo-2", "repo-1"], 1), ["repo-1", "Repo-2", "repo-10"]);
});
