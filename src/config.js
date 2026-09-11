import * as core from "@actions/core";
import { enterpriseSlugFromServerUrl } from "./organizations.js";
import { committerEmail } from "./git.js";

// Reads and validates every action input in one place.
function readConfig() {
  const teamProperty = core.getInput("team-property") || "team";

  return {
    token: core.getInput("token", { required: true }),
    // Empty when the host carries no slug (github.com); index.js then resolves
    // it from the token.
    enterprise: resolveEnterprise(core.getInput("enterprise"), process.env.GITHUB_SERVER_URL),
    dataDir: core.getInput("data-dir") || "data",
    // Empty means "autosense from the runner env" (see octokit.js).
    apiUrl: core.getInput("api-url"),
    serverUrl: resolveServerUrl(core.getInput("api-url"), process.env.GITHUB_SERVER_URL),
    teamProperty,
    teamLabel: labelFromProperty(teamProperty),
    outputPath: core.getInput("output-path") || "_site",
    inventoryTtlDays: nonNegativeInt(core.getInput("inventory-ttl-days"), 7),
    attributeTtlDays: nonNegativeInt(core.getInput("attribute-ttl-days"), 1),
    settledAttributeTtlDays: nonNegativeInt(core.getInput("settled-attribute-ttl-days"), 7),
    onboardingWindowDays: nonNegativeInt(core.getInput("onboarding-window-days"), 60),
    rowChunkSize: positiveInt(core.getInput("row-chunk-size"), 2000),
    detailBuckets: positiveInt(core.getInput("detail-buckets"), 256),
    liveMigrations: booleanInput("live-migrations", true),
    commitData: core.getBooleanInput("commit-data"),
    commitMessage:
      core.getInput("commit-message") || "chore: update migration data [skip ci]",
    committer: {
      name: core.getInput("committer-name") || "github-actions[bot]",
      email: core.getInput("committer-email") || committerEmail(process.env.GITHUB_SERVER_URL),
    },
    budget: {
      rest: positiveInt(core.getInput("rest-budget"), 4000),
      graphql: positiveInt(core.getInput("graphql-budget"), 4000),
      audit: positiveInt(core.getInput("audit-budget"), 1500),
    },
  };
}

// The enterprise slug, explicit input first. A *.ghe.com tenant carries it in
// the host, so those runs need no input; github.com does not, so there the slug
// has to be given.
function resolveEnterprise(input, serverUrl) {
  return String(input ?? "").trim() || enterpriseSlugFromServerUrl(serverUrl);
}

// The web host the migrations landed on, so the dashboard can link a target
// repository. The runner's own server is that host unless api-url points the
// run at a different instance, in which case the link must follow the data.
function resolveServerUrl(apiUrl, serverUrl) {
  return webHostOf(apiUrl) || trimSlash(serverUrl) || "https://github.com";
}

// api.github.com, api.SUB.ghe.com, and GHES's <host>/api/v3 all reduce to the
// web host by dropping the "api." prefix and the path.
function webHostOf(apiUrl) {
  if (!String(apiUrl ?? "").trim()) return "";
  try {
    const url = new URL(apiUrl);
    return `${url.protocol}//${url.host.replace(/^api\./, "")}`;
  } catch {
    return "";
  }
}

function trimSlash(value) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

// getBooleanInput throws on an absent value, which happens whenever the action
// is invoked without the defaults action.yml supplies (tests, or a consumer
// pinned to an older major).
function booleanInput(name, fallback) {
  const raw = core.getInput(name).trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "true";
}

// A budget of 0 means unlimited, for a first run that must complete in one pass.
function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed <= 0 ? Infinity : parsed;
}

// 0 disables re-inventory, leaving each repository inventoried once.
function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// Turns a property name into something the dashboard can print as a heading:
// "business_unit" and "businessUnit" both become "Business unit". Organizations
// name this concept team, business unit, group, or tribe, and the dashboard
// should use their word rather than ours.
function labelFromProperty(property) {
  const words = String(property)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_.]+/g, " ")
    .trim()
    .toLowerCase();
  if (!words) return "Team";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export { readConfig, labelFromProperty, resolveEnterprise, resolveServerUrl };
