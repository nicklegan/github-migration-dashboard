// Enumerates every organization in an enterprise via GraphQL, following
// pageInfo.endCursor until exhausted. Requires the token to have the
// read:enterprise scope and to be an enterprise owner.

const ENTERPRISE_ORGS_QUERY = `
query ($slug: String!, $cursor: String) {
  enterprise(slug: $slug) {
    organizations(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { login }
    }
  }
}`;

async function fetchEnterpriseOrganizations(octokit, slug, budget = null) {
  const logins = [];
  let cursor = null;

  do {
    budget?.take("graphql");
    const data = await octokit.graphql(ENTERPRISE_ORGS_QUERY, { slug, cursor });
    // A null enterprise means the slug is wrong or the token lacks read:enterprise.
    if (!data.enterprise) {
      throw new Error(
        `Enterprise '${slug}' not found, or the token lacks the read:enterprise scope.`,
      );
    }

    const connection = data.enterprise.organizations;
    for (const node of connection.nodes) logins.push(node.login);
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);

  return logins;
}

// Pure: derive the enterprise slug from the server URL. On GitHub Enterprise
// Cloud with data residency the tenant subdomain is the enterprise slug
// (https://acme.ghe.com -> "acme"). Returns "" when it can't be determined.
function enterpriseSlugFromServerUrl(serverUrl) {
  let host;
  try {
    host = new URL(serverUrl).host;
  } catch {
    return "";
  }

  const match = /^([^.]+)\.ghe\.com$/.exec(host);
  return match ? match[1] : "";
}

// The enterprises the token's owner administers. github.com puts no slug in the
// workflow context, so this is what saves the caller from configuring one. Needs
// the same read:enterprise scope the organization listing already does.
const VIEWER_ENTERPRISES_QUERY = `
query {
  viewer {
    enterprises(first: 10, membershipType: ADMIN) {
      nodes { slug }
    }
  }
}`;

async function fetchViewerEnterprises(octokit) {
  const data = await octokit.graphql(VIEWER_ENTERPRISES_QUERY);
  return (data.viewer?.enterprises?.nodes ?? []).map((node) => node?.slug).filter(Boolean);
}

// Which of `slugs` own `org`, asked as one aliased request rather than one per
// candidate. The slugs travel as variables because they end up in the document
// itself. `query` is a search, so the login is matched exactly rather than
// trusting whatever it ranked first.
async function findEnterprisesOwningOrganization(octokit, slugs, org) {
  if (slugs.length === 0 || !org) return [];

  const declarations = slugs.map((_, index) => `$s${index}: String!`).join(", ");
  const fields = slugs
    .map(
      (_, index) =>
        `e${index}: enterprise(slug: $s${index}) { organizations(first: 10, query: $org) { nodes { login } } }`,
    )
    .join("\n");

  const variables = { org };
  slugs.forEach((slug, index) => {
    variables[`s${index}`] = slug;
  });

  const data = await octokit.graphql(`query (${declarations}, $org: String!) {\n${fields}\n}`, variables);

  const wanted = org.toLowerCase();
  return slugs.filter((_, index) =>
    (data?.[`e${index}`]?.organizations?.nodes ?? []).some(
      (node) => node?.login?.toLowerCase() === wanted,
    ),
  );
}

// An organization behind SAML single sign-on that the token has not been
// authorized for fails the same way as one the token simply cannot see. The
// message is the only thing that tells them apart, and the two need opposite
// remedies — authorize the existing token, versus get access at all. Reporting
// them identically sends people to the wrong fix.
const SSO_PATTERN = /\bsaml\b|single[- ]sign[- ]on|\bsso\b/i;

// repositoryMigrations answers HTTP 200 with this message both when the token
// lacks admin:org and when its owner is not an owner or migrator of the
// organization, so the remedy has to name both.
const PERMISSION_PATTERN = /does not have the right permission/i;

function oneLine(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function classifyOrgFailure(err) {
  const message = oneLine(err instanceof Error ? err.message : err);
  const status = err?.status ?? err?.response?.status ?? null;

  if (SSO_PATTERN.test(message)) {
    return {
      kind: "sso",
      reason: "Token not authorized for SSO",
      hint:
        "Authorize the token for this organization: Settings → Developer settings → " +
        "Personal access tokens → Configure SSO.",
    };
  }

  if (PERMISSION_PATTERN.test(message)) {
    return {
      kind: "access",
      reason: "No access to repository migrations",
      hint:
        "The token needs the admin:org, read:audit_log, read:enterprise, repo, and workflow " +
        "scopes, and its owner must be an owner or migrator of the organization.",
    };
  }

  if (status === 403 || status === 404) {
    return {
      kind: "access",
      reason: `No access (HTTP ${status})`,
      hint: "The token needs organization owner or migrator access.",
    };
  }

  return { kind: "error", reason: message, hint: null };
}

export {
  fetchEnterpriseOrganizations,
  fetchViewerEnterprises,
  findEnterprisesOwningOrganization,
  enterpriseSlugFromServerUrl,
  classifyOrgFailure,
};
