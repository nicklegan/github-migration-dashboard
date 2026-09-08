// Cross-filtering between visuals: selecting an element in one chart filters
// every other chart, the KPIs, and the tables. Pure predicates, no React here,
// so they unit-test directly.

// A row matches a workflow-state selection when it has at least one workflow in
// that status — the same rows that contributed to the slice.
function matchesWorkflowState(migration, value) {
  const key = String(value).toLowerCase();
  return (migration.workflows?.[key] ?? 0) > 0;
}

const MATCHERS = {
  team: (migration, value) => (migration.team || "Unassigned") === value,
  org: (migration, value) => (migration.organization || "Unknown") === value,
  state: (migration, value) => migration.state === value,
  workflowState: matchesWorkflowState,
};

const DIMENSION_LABELS = {
  team: "Team",
  org: "Organization",
  state: "State",
  workflowState: "Workflow",
};

// Filters are `{ dimension: [value, ...] }`. Within a dimension the values are
// OR'd (two organizations means either), across dimensions they are AND'd.
function selectedValues(filters, dimension) {
  const values = filters?.[dimension];
  if (Array.isArray(values)) return values;
  return values != null ? [values] : [];
}

function isSelected(filters, dimension, value) {
  return selectedValues(filters, dimension).includes(value);
}

// Applies every active selection except the dimensions in `except` (a name or a
// list of names). A chart is never filtered by a dimension it can select on, so
// it keeps its whole breakdown and highlights the selection instead of
// collapsing to a single bar or slice.
function applyFilters(migrations, filters, except) {
  const excluded = new Set(Array.isArray(except) ? except : except ? [except] : []);
  const active = Object.keys(filters ?? {})
    .filter((dimension) => !excluded.has(dimension) && MATCHERS[dimension])
    .map((dimension) => [dimension, selectedValues(filters, dimension)])
    .filter(([, values]) => values.length > 0);
  if (active.length === 0) return migrations;
  return migrations.filter((migration) =>
    active.every(([dimension, values]) =>
      values.some((value) => MATCHERS[dimension](migration, value)),
    ),
  );
}

// Toggles each selection's value within its dimension. Values accumulate, so
// clicking two organizations filters to both; clicking a selected value again
// drops it, and a dimension with nothing left is removed entirely.
function toggleSelections(filters, selections) {
  const list = (selections ?? []).filter(
    (selection) => selection?.value != null && MATCHERS[selection.dimension],
  );
  if (list.length === 0) return filters;

  const next = { ...filters };
  for (const { dimension, value } of list) {
    const current = selectedValues(next, dimension);
    const values = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    if (values.length > 0) next[dimension] = values;
    else delete next[dimension];
  }
  return next;
}

// Selects a combination as one unit — a stacked segment is "this organization
// AND this state". Adds whichever parts are missing; only when every part is
// already selected does it remove them all, so clicking a second organization's
// failed segment widens the organization filter without dropping the state.
function toggleCombination(filters, selections) {
  const list = (selections ?? []).filter(
    (selection) => selection?.value != null && MATCHERS[selection.dimension],
  );
  if (list.length === 0) return filters;

  const allSelected = list.every(({ dimension, value }) => isSelected(filters, dimension, value));
  const next = { ...filters };
  for (const { dimension, value } of list) {
    const current = selectedValues(next, dimension);
    const values = allSelected
      ? current.filter((v) => v !== value)
      : current.includes(value)
        ? current
        : [...current, value];
    if (values.length > 0) next[dimension] = values;
    else delete next[dimension];
  }
  return next;
}

// Removes one value from a dimension, or the whole dimension when no value is
// given.
function removeFilter(filters, dimension, value) {
  const next = { ...filters };
  if (value === undefined) {
    delete next[dimension];
    return next;
  }
  const values = selectedValues(next, dimension).filter((v) => v !== value);
  if (values.length > 0) next[dimension] = values;
  else delete next[dimension];
  return next;
}

// One entry per selected value, in selection order within each dimension.
function activeFilterList(filters, labels = DIMENSION_LABELS) {
  return Object.keys(filters ?? {})
    .filter((dimension) => MATCHERS[dimension])
    .flatMap((dimension) =>
      selectedValues(filters, dimension).map((value) => ({
        dimension,
        value,
        label: labels[dimension] ?? DIMENSION_LABELS[dimension],
      })),
    );
}

export {
  applyFilters,
  toggleSelections,
  toggleCombination,
  removeFilter,
  activeFilterList,
  selectedValues,
  isSelected,
  DIMENSION_LABELS,
};
