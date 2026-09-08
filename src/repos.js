// Fetches repository size (diskUsage) and the owning-team custom property for a
// specific set of repositories, batched into aliased GraphQL lookups.
//
// This polls rather than following `custom_property_value.*` audit events on
// purpose: a repository with the property unset emits no event, and "unset" is
// a legitimate value rather than a missing observation. Polling a due subset
// keeps every repository covered while making the per-run cost proportional to
// how stale the data is allowed to get, not to the size of the estate.
//
// A batch costs one rate-limit point regardless of how many repositories it
// carries, so the batch size is bounded by query size rather than by cost.

const BATCH_SIZE = 100;

const REPO_FIELDS = `
fragment RepoFields on Repository {
  name
  diskUsage
  repositoryCustomPropertyValues(first: 100) {
    nodes { propertyName value }
  }
}`;

// Names are passed as GraphQL variables rather than interpolated, so a repo
// name can never alter the query.
function buildQuery(count) {
  const declarations = ["$owner: String!"];
  const selections = [];
  for (let i = 0; i < count; i += 1) {
    declarations.push(`$n${i}: String!`);
    selections.push(`  r${i}: repository(owner: $owner, name: $n${i}) { ...RepoFields }`);
  }
  return `query (${declarations.join(", ")}) {\n${selections.join("\n")}\n}\n${REPO_FIELDS}`;
}

// Returns a Map keyed by repo name -> { repoSizeMB, team }. Repositories that
// no longer resolve are simply absent; the caller keeps their stored values,
// because a missing lookup is not proof of deletion.
async function fetchRepoDetails(octokit, org, names, teamProperty, budget) {
  const details = new Map();

  for (let start = 0; start < names.length; start += BATCH_SIZE) {
    if (budget && !budget.take("graphql")) break;
    const batch = names.slice(start, start + BATCH_SIZE);

    const variables = { owner: org };
    batch.forEach((name, i) => {
      variables[`n${i}`] = name;
    });

    let data;
    try {
      data = await octokit.graphql(buildQuery(batch.length), variables);
    } catch (err) {
      // A missing repository makes the whole response an error even though the
      // surviving aliases resolved, so keep the partial data.
      if (!err?.data) throw err;
      data = err.data;
    }

    batch.forEach((name, i) => {
      const node = data?.[`r${i}`];
      if (!node) return;
      details.set(name, {
        // diskUsage is in KB; report MB. Absent for repos with no content.
        repoSizeMB: typeof node.diskUsage === "number" ? node.diskUsage / 1024 : null,
        team: teamValue(node.repositoryCustomPropertyValues?.nodes, teamProperty),
      });
    });
  }

  return details;
}

// Property names are matched case-insensitively: GitHub shows them as typed
// (`Area`), and an input of `area` should still find them. A multi-select
// property returns an array, which is flattened so it groups as one label.
function teamValue(propertyNodes, teamProperty) {
  if (!Array.isArray(propertyNodes)) return null;
  const wanted = teamProperty.toLowerCase();
  const match = propertyNodes.find((p) => p.propertyName?.toLowerCase() === wanted);
  if (match?.value == null) return null;
  if (Array.isArray(match.value)) return match.value.length > 0 ? match.value.join(", ") : null;
  return String(match.value);
}

export { fetchRepoDetails, buildQuery, BATCH_SIZE };
