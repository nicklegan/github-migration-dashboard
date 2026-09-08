// Groups a repository's workflows so the workflow table can fold them under one
// row. Pure logic, no React, so it unit-tests directly.

// A repository is only as healthy as its least healthy workflow: one failure
// makes the whole repo failing, and a workflow that never ran holds it at idle
// even when the others succeeded.
function worstStatus(statuses) {
  if (statuses.includes("failing")) return "failing";
  if (statuses.includes("idle")) return "idle";
  if (statuses.includes("succeeded")) return "succeeded";
  return statuses[0];
}

// The same rule expressed over the counts a row carries, so a folded row renders
// before its workflow detail has been fetched. A repository whose only workflows
// are manual has no measurable status, so it reports as manual rather than idle;
// one whose only workflows arrived after the window is not scored at all, since
// those counts record that they exist, not how they ran.
function statusFromCounts(counts) {
  if (!counts) return null;
  if (counts.failing > 0) return "failing";
  if (counts.idle > 0) return "idle";
  if (counts.succeeded > 0) return "succeeded";
  if (counts.manual > 0) return "manual";
  if (counts.postOnboarding > 0) return "post-onboarding";
  return null;
}

function workflowGroups(repositories) {
  const groups = [];
  for (const repo of repositories) {
    const counts = repo.workflows;
    // Manual workflows are listed even though nothing can be inferred from them,
    // and so are workflows added after the onboarding window: they do not move
    // migration metrics, but a repository whose only workflows arrived late
    // would otherwise vanish from the table that exists to list them.
    const total = counts
      ? counts.succeeded +
        counts.failing +
        counts.idle +
        (counts.manual ?? 0) +
        (counts.postOnboarding ?? 0)
      : 0;
    if (total === 0) continue;

    groups.push({
      key: repo.id,
      bucket: repo.d,
      organization: repo.organization,
      repository: repo.repository,
      // Carried from the repository's migration so the workflow table can show
      // where the code came from and who owns it without a second lookup.
      sourceType: repo.sourceType ?? null,
      sourceUrl: repo.sourceUrl ?? null,
      team: repo.team ?? null,
      migratedAt: repo.createdAt,
      count: total,
      // Present only when the repository has exactly one workflow, which the
      // table shows inline instead of folding.
      workflow: repo.workflow ?? null,
      status: statusFromCounts(counts),
    });
  }
  return groups;
}

// How many workflows the grouped rows stand for — the table lists repositories,
// so its own length is not the workflow count.
function workflowCount(groups) {
  return groups.reduce((sum, group) => sum + (group.count ?? 0), 0);
}

export { workflowGroups, workflowCount, worstStatus, statusFromCounts };
