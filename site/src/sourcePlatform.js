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
// A name that matches no family is shown as typed rather than guessed at.

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

const NAME_FAMILY = [
  ["gitlab", /gitlab/i],
  ["bitbucket", /bitbucket/i],
  ["ado", /azure\s*devops|\bado\b/i],
  ["github", /github|\bghec\b|\bghes\b|\bghe\b/i],
];

// Visible fallback for a name nobody could classify; the full text stays on
// hover and in the CSV.
const RAW_NAME_CHARS = 24;

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

function truncate(text) {
  return text.length > RAW_NAME_CHARS ? `${text.slice(0, RAW_NAME_CHARS - 1)}…` : text;
}

function sourcePlatform(sourceType, sourceUrl, sourceKind = null) {
  if (sourceType === LIVE_MIGRATION) return LABELS.elm;

  const family = familyOf(sourceKind, sourceType);
  if (family === "github") return githubProduct(hostOf(sourceUrl));
  if (family) return LABELS[family];

  return sourceType ? truncate(sourceType) : "—";
}

// The same, read off a row or attempt as the tables carry them.
function platformOf(row) {
  return sourcePlatform(row?.sourceType, row?.sourceUrl, row?.sourceKind ?? null);
}

export { sourcePlatform, platformOf, LABELS as SOURCE_LABELS, LIVE_MIGRATION };
