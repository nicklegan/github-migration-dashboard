// Fetches every repository migration for an organization via GraphQL,
// following pageInfo.endCursor until exhausted. O(pages), not O(repos).
//
// Unlike other connections, repositoryMigrations treats `after` as inclusive:
// each page repeats the node its cursor points at, so ids are deduplicated here.

const MIGRATIONS_QUERY = `
query ($login: String!, $cursor: String) {
  organization(login: $login) {
    login
    repositoryMigrations(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        repositoryName
        state
        createdAt
        warningsCount
        continueOnError
        sourceUrl
        failureReason
        migrationLogUrl
        migrationSource { name }
      }
    }
  }
}`;

function toRow(node, org) {
  return {
    id: node.id,
    org,
    repository: node.repositoryName,
    state: node.state,
    createdAt: node.createdAt,
    warningsCount: node.warningsCount ?? 0,
    continueOnError: Boolean(node.continueOnError),
    sourceUrl: node.sourceUrl ?? null,
    failureReason: node.failureReason ?? null,
    migrationLogUrl: node.migrationLogUrl ?? null,
    sourceType: node.migrationSource?.name ?? null,
  };
}

// Yields only migrations newer than `cursor`, returning the cursor to store.
async function fetchNewMigrations(octokit, org, cursor, budget) {
  const rows = [];
  const seen = new Set();
  let next = cursor ?? null;
  let hasNextPage = true;

  while (hasNextPage) {
    if (!budget.take("graphql")) break;
    const data = await octokit.graphql(MIGRATIONS_QUERY, { login: org, cursor: next });
    const connection = data.organization?.repositoryMigrations;
    if (!connection) break;

    for (const node of connection.nodes) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      rows.push(toRow(node, org));
    }

    hasNextPage = connection.pageInfo.hasNextPage;
    if (connection.pageInfo.endCursor) next = connection.pageInfo.endCursor;
  }

  return { rows, cursor: next, truncated: hasNextPage };
}

// Ids are passed as GraphQL variables rather than interpolated, so a stored id
// can never alter the query.
function buildRefreshQuery(count) {
  const declarations = [];
  const selections = [];
  for (let i = 0; i < count; i += 1) {
    declarations.push(`$id${i}: ID!`);
    selections.push(
      `  m${i}: node(id: $id${i}) { ... on RepositoryMigration { id repositoryName state createdAt warningsCount failureReason migrationLogUrl } }`,
    );
  }
  return `query (${declarations.join(", ")}) {\n${selections.join("\n")}\n}`;
}

// Re-checks migrations still in flight. Aliased node lookups cost one point for
// the whole batch, so this stays cheap however many are outstanding.
async function refreshMigrations(octokit, rows, budget, batchSize = 50) {
  const refreshed = [];

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    if (!budget.take("graphql")) break;

    const variables = {};
    batch.forEach((row, index) => {
      variables[`id${index}`] = row.id;
    });

    let data;
    try {
      data = await octokit.graphql(buildRefreshQuery(batch.length), variables);
    } catch (err) {
      // One id the API can no longer resolve makes the whole response an error
      // even though the surviving aliases came back; keep the partial data
      // rather than losing the batch.
      if (!err?.data) throw err;
      data = err.data;
    }

    batch.forEach((row, index) => {
      const node = data?.[`m${index}`];
      if (!node) return; // no longer resolvable; keep what is stored
      refreshed.push({
        ...row,
        state: node.state,
        warningsCount: node.warningsCount ?? row.warningsCount,
        failureReason: node.failureReason ?? null,
        migrationLogUrl: node.migrationLogUrl ?? null,
      });
    });
  }

  return refreshed;
}

export { fetchNewMigrations, refreshMigrations, buildRefreshQuery, toRow };
