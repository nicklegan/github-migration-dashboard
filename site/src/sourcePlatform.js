// Turns a migration's source into a short platform label for the dashboard.
//
// Three signals, in order of trust:
//   1. `migrationSource.type` — set by the importer (GITHUB_ARCHIVE, GITLAB,
//      BITBUCKET_SERVER, AZURE_DEVOPS). Decides the platform family outright.
//   2. `migrationSource.name` — free text typed by whoever created the source
//      in GEI. Migrators get the *family* right ("GitLab Source", "GHEC
//      Source") but reuse GitHub names across products, so when the type is
//      missing the name may only decide the family, never the product.
//   3. The source URL's host — the only signal that tells the three GitHub
//      products apart: github.com is GHEC, *.ghe.com is GHEC with data
//      residency, anything else is a GitHub Enterprise Server.
//
// A name that matches no family is not shown as a platform: migrators sometimes
// name a source after the project it imports ("team/project"). Before giving
// up, the host is checked against the other migrations: when every classified
// source on that host is one platform, an unclassified one there is too. The
// raw name is never shown; it is an input here, not a fact about the source.

const LIVE_MIGRATION = "Enterprise Live Migration";

const LABELS = {
  ghec: "GHEC",
  ghecdr: "GHEC DR",
  ghes: "GHES",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  ado: "Azure DevOps",
  elm: "GHES ELM",
};

const KIND_FAMILY = {
  GITHUB_ARCHIVE: "github",
  GITLAB: "gitlab",
  BITBUCKET_SERVER: "bitbucket",
  AZURE_DEVOPS: "ado",
};
const FAMILY_KIND = Object.fromEntries(Object.entries(KIND_FAMILY).map(([kind, family]) => [family, kind]));

const NAME_FAMILY = [
  ["gitlab", /gitlab/i],
  ["bitbucket", /bitbucket/i],
  ["ado", /azure\s*devops|\bado\b/i],
  ["github", /github|\bghec\b|\bghes\b|\bghe\b/i],
];

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function githubProduct(host) {
  if (host === "github.com") return LABELS.ghec;
  if (host?.endsWith(".ghe.com")) return LABELS.ghecdr;
  return LABELS.ghes;
}

function familyOf(sourceKind, sourceType) {
  if (sourceKind && KIND_FAMILY[sourceKind]) return KIND_FAMILY[sourceKind];
  const name = String(sourceType ?? "");
  for (const [family, pattern] of NAME_FAMILY) if (pattern.test(name)) return family;
  return null;
}

// The platform label, or null when neither the importer nor the name says.
function sourcePlatform(sourceType, sourceUrl, sourceKind = null) {
  if (sourceType === LIVE_MIGRATION) return LABELS.elm;

  const family = familyOf(sourceKind, sourceType);
  if (family === "github") return githubProduct(hostOf(sourceUrl));
  return family ? LABELS[family] : null;
}

// The same, read off a row or attempt as the tables carry them.
function platformOf(row) {
  return sourcePlatform(row?.sourceType, row?.sourceUrl, row?.sourceKind ?? null);
}

// Fills `sourceKind` on rows whose source could not be classified, from the
// consensus of classified rows on the same host. A host with sources of more
// than one family teaches nothing. Live migrations carry no source URL and are
// left alone. Returns the rows unchanged when there is nothing to fill.
function inferSourceKinds(rows) {
  const hosts = new Map();
  const unknown = [];
  for (const row of rows) {
    if (row.sourceType === LIVE_MIGRATION) continue;
    const host = hostOf(row.sourceUrl);
    if (!host) continue;
    const family = familyOf(row.sourceKind, row.sourceType);
    if (!family) {
      unknown.push(row);
      continue;
    }
    const seen = hosts.get(host);
    hosts.set(host, seen === undefined || seen === family ? family : null);
  }
  if (unknown.length === 0) return rows;

  const filled = new Map();
  for (const row of unknown) {
    const family = hosts.get(hostOf(row.sourceUrl));
    if (family) filled.set(row, { ...row, sourceKind: FAMILY_KIND[family] });
  }
  return filled.size === 0 ? rows : rows.map((row) => filled.get(row) ?? row);
}

export { sourcePlatform, platformOf, inferSourceKinds, LABELS as SOURCE_LABELS, LIVE_MIGRATION };
