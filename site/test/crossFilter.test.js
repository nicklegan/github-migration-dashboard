import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyFilters,
  toggleSelections,
  toggleCombination,
  removeFilter,
  activeFilterList,
  selectedValues,
  isSelected,
  DIMENSION_LABELS,
} from "../src/crossFilter.js";

const rows = [
  { repository: "a", organization: "org-a", state: "SUCCEEDED", team: "A", workflows: { succeeded: 2, failing: 1, idle: 0 } },
  { repository: "b", organization: "org-a", state: "FAILED", team: "B", workflows: { succeeded: 0, failing: 0, idle: 3 } },
  { repository: "c", organization: "org-b", state: "SUCCEEDED", team: "A", workflows: null },
  { repository: "d", organization: "org-b", state: "FAILED", team: null, workflows: { succeeded: 1, failing: 0, idle: 0 } },
];

test("applyFilters returns every row when nothing is selected", () => {
  assert.equal(applyFilters(rows, {}).length, 4);
  assert.equal(applyFilters(rows, null).length, 4);
});

test("applyFilters combines dimensions with AND", () => {
  const result = applyFilters(rows, { team: "A", state: "SUCCEEDED" });
  assert.deepEqual(result.map((r) => r.repository), ["a", "c"]);

  const narrower = applyFilters(rows, { team: "A", org: "org-b" });
  assert.deepEqual(narrower.map((r) => r.repository), ["c"]);
});

test("applyFilters skips the excluded dimension so a chart keeps its own breakdown", () => {
  const result = applyFilters(rows, { team: "A", state: "SUCCEEDED" }, "state");
  assert.deepEqual(result.map((r) => r.repository), ["a", "c"]);

  const teamExcluded = applyFilters(rows, { team: "A", state: "FAILED" }, "team");
  assert.deepEqual(teamExcluded.map((r) => r.repository), ["b", "d"]);
});

test("applyFilters excludes every dimension a chart can select on", () => {
  const result = applyFilters(rows, { team: "A", state: "SUCCEEDED", org: "org-b" }, [
    "team",
    "state",
  ]);
  assert.deepEqual(result.map((r) => r.repository), ["c", "d"]);
});

test("applyFilters maps missing team and organization to their fallback labels", () => {
  assert.deepEqual(
    applyFilters(rows, { team: "Unassigned" }).map((r) => r.repository),
    ["d"],
  );
});

test("applyFilters matches rows contributing at least one workflow to a workflow state", () => {
  assert.deepEqual(
    applyFilters(rows, { workflowState: "Failing" }).map((r) => r.repository),
    ["a"],
  );
  assert.deepEqual(
    applyFilters(rows, { workflowState: "Idle" }).map((r) => r.repository),
    ["b"],
  );
  assert.deepEqual(
    applyFilters(rows, { workflowState: "Succeeded" }).map((r) => r.repository),
    ["a", "d"],
  );
});

test("toggleSelections adds, accumulates, and removes values within a dimension", () => {
  const one = toggleSelections({}, [{ dimension: "team", value: "A" }]);
  assert.deepEqual(one, { team: ["A"] });

  // A second organization or team joins the first instead of replacing it.
  const two = toggleSelections(one, [{ dimension: "team", value: "B" }]);
  assert.deepEqual(two, { team: ["A", "B"] });

  const back = toggleSelections(two, [{ dimension: "team", value: "A" }]);
  assert.deepEqual(back, { team: ["B"] });

  // Dropping the last value removes the dimension so nothing lingers as [].
  assert.deepEqual(toggleSelections(back, [{ dimension: "team", value: "B" }]), {});
});

test("applyFilters ORs the values within a dimension and ANDs across dimensions", () => {
  assert.deepEqual(
    applyFilters(rows, { org: ["org-a", "org-b"] }).map((r) => r.repository),
    ["a", "b", "c", "d"],
  );
  assert.deepEqual(
    applyFilters(rows, { team: ["A", "B"], state: ["FAILED"] }).map((r) => r.repository),
    ["b"],
  );
});

test("applyFilters accepts a bare value for backwards compatibility", () => {
  assert.deepEqual(applyFilters(rows, { team: "A" }).map((r) => r.repository), ["a", "c"]);
});

test("toggleSelections applies several dimensions in one call", () => {
  const applied = toggleSelections({}, [
    { dimension: "team", value: "A" },
    { dimension: "state", value: "FAILED" },
  ]);
  assert.deepEqual(applied, { team: ["A"], state: ["FAILED"] });
});

test("toggleCombination selects a segment's category and series together", () => {
  const failedA = [
    { dimension: "team", value: "A" },
    { dimension: "state", value: "FAILED" },
  ];
  const applied = toggleCombination({}, failedA);
  assert.deepEqual(applied, { team: ["A"], state: ["FAILED"] });

  // A second team's failed segment widens the team filter and keeps the state.
  const both = toggleCombination(applied, [
    { dimension: "team", value: "B" },
    { dimension: "state", value: "FAILED" },
  ]);
  assert.deepEqual(both, { team: ["A", "B"], state: ["FAILED"] });

  // Re-clicking a fully selected segment removes exactly its parts.
  assert.deepEqual(toggleCombination(both, failedA), { team: ["B"] });
  assert.deepEqual(toggleCombination(applied, failedA), {});
});

test("toggleCombination adds only the missing part of a partial match", () => {
  const current = { team: ["A"], state: ["FAILED"] };
  const result = toggleCombination(current, [
    { dimension: "team", value: "A" },
    { dimension: "state", value: "SUCCEEDED" },
  ]);
  assert.deepEqual(result, { team: ["A"], state: ["FAILED", "SUCCEEDED"] });
  assert.deepEqual(current, { team: ["A"], state: ["FAILED"] });
});

test("toggleSelections ignores empty and unknown selections", () => {
  const current = { team: ["A"] };
  assert.deepEqual(toggleSelections(current, []), current);
  assert.deepEqual(toggleSelections(current, [{ dimension: "nonsense", value: "x" }]), current);
  assert.deepEqual(toggleSelections(current, [{ dimension: "org", value: null }]), current);
});

test("toggleSelections and removeFilter do not mutate the input", () => {
  const filters = { team: ["A"] };
  toggleSelections(filters, [{ dimension: "org", value: "org-a" }]);
  toggleSelections(filters, [{ dimension: "team", value: "B" }]);
  removeFilter(filters, "team");
  removeFilter(filters, "team", "A");
  assert.deepEqual(filters, { team: ["A"] });
});

test("removeFilter drops one value, or the whole dimension without a value", () => {
  const filters = { team: ["A", "B"], org: ["org-a"] };
  assert.deepEqual(removeFilter(filters, "team", "A"), { team: ["B"], org: ["org-a"] });
  assert.deepEqual(removeFilter(filters, "team", "B"), { team: ["A"], org: ["org-a"] });
  assert.deepEqual(removeFilter(filters, "org", "org-a"), { team: ["A", "B"] });
  assert.deepEqual(removeFilter(filters, "team"), { org: ["org-a"] });
});

test("selectedValues and isSelected read either shape", () => {
  assert.deepEqual(selectedValues({ team: ["A", "B"] }, "team"), ["A", "B"]);
  assert.deepEqual(selectedValues({ team: "A" }, "team"), ["A"]);
  assert.deepEqual(selectedValues({}, "team"), []);
  assert.equal(isSelected({ team: ["A", "B"] }, "team", "B"), true);
  assert.equal(isSelected({ team: ["A"] }, "team", "B"), false);
});

test("activeFilterList lists one chip per selected value and ignores unknown dimensions", () => {
  const list = activeFilterList({ team: ["A", "B"], nonsense: ["x"], org: [] });
  assert.deepEqual(list, [
    { dimension: "team", value: "A", label: "Team" },
    { dimension: "team", value: "B", label: "Team" },
  ]);
});

test("filter chips use the organization's own word for the grouping", () => {
  // The property may be called business_unit, group, or tribe; the chip must
  // not insist on calling it Team.
  const filters = { team: ["Retail"], org: ["acme"] };
  const labels = { ...DIMENSION_LABELS, team: "Business unit" };

  assert.deepEqual(activeFilterList(filters, labels), [
    { dimension: "team", value: "Retail", label: "Business unit" },
    { dimension: "org", value: "acme", label: "Organization" },
  ]);
});

test("without an override the built-in labels are used", () => {
  assert.deepEqual(activeFilterList({ team: ["Payments"] }), [
    { dimension: "team", value: "Payments", label: "Team" },
  ]);
});
