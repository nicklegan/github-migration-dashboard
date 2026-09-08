import * as core from "@actions/core";
import { getOctokit } from "@actions/github";
import { throttling } from "@octokit/plugin-throttling";
import { retry } from "@octokit/plugin-retry";

// Pin a current REST API version so requests don't use the default 2022-11-28,
// which ghe.com tenants now return Deprecation/Sunset headers for. 2026-03-10 is
// supported on github.com and ghe.com.
const REST_API_VERSION = "2026-03-10";

// Secondary rate limits are short-lived, so waiting them out is the documented
// remedy. A few attempts is plenty; beyond that something else is wrong.
const SECONDARY_RETRIES = 3;

// Which budget pool a request draws from, so hitting a real limit closes the
// same pool the configured budget would have. Matched on the path's shape, not
// on a substring: a repository named "graphql" or "audit-log" would otherwise
// charge its REST calls to the wrong pool and close the wrong one on a 403.
function poolFor(options) {
  const path = String(options?.url ?? "").replace(/^https?:\/\/[^/]+/, "");
  if (path === "/graphql" || path.endsWith("/api/graphql")) return "graphql";
  if (/^\/(orgs|enterprises)\/[^/]+\/audit-log(\?|$)/.test(path)) return "audit";
  return "rest";
}

// Builds an authenticated Octokit that works on github.com and ghe.com (data
// residency) without per-platform branching. The REST base URL and GraphQL base
// URL are autosensed from the runner environment; an explicit apiUrl override
// wins when the target org lives on a different instance than the runner.
//
// Every call this action makes is sequential — no Promise.all anywhere — which
// is what keeps it clear of the concurrency and points-per-minute secondary
// limits. Parallelising any phase would forfeit that.
function createClient(token, apiUrl, budget) {
  const restBase = apiUrl || process.env.GITHUB_API_URL || "https://api.github.com";
  const options = {
    baseUrl: restBase,
    throttle: {
      // Primary limits reset on the hour, so waiting would burn the job. Close
      // the pool instead and let the run wind down and resume next time.
      onRateLimit: (retryAfter, requestOptions) => {
        const pool = poolFor(requestOptions);
        budget?.exhaust(pool, `${pool} primary rate limit reached`);
        return false;
      },
      onSecondaryRateLimit: (retryAfter, requestOptions, _octokit, retryCount) => {
        if (retryCount >= SECONDARY_RETRIES) {
          const pool = poolFor(requestOptions);
          budget?.exhaust(pool, `${pool} secondary rate limit persisted after ${retryCount} retries`);
          return false;
        }
        core.info(
          `Secondary rate limit on ${requestOptions.method} ${requestOptions.url}; retrying in ${retryAfter}s.`,
        );
        return true;
      },
    },
  };

  const octokit = getOctokit(token, options, throttling, retry);

  // Applies to every REST request (including octokit.rest.* methods, which all
  // funnel through the request hook). GraphQL ignores the header.
  octokit.hook.before("request", (requestOptions) => {
    requestOptions.headers["x-github-api-version"] = REST_API_VERSION;
  });

  // GraphQL goes through the same request hook, so this sees every response.
  octokit.hook.after("request", (response, requestOptions) => {
    budget?.observe(poolFor(requestOptions), response?.headers ?? {});
  });

  // Prefer the runner-provided GraphQL endpoint when present.
  const graphqlBase = graphqlBaseFrom(restBase);
  octokit.graphql = octokit.graphql.defaults({ baseUrl: graphqlBase });

  return octokit;
}

// Maps a REST base URL to the GraphQL base URL Octokit expects (it re-appends
// "/graphql" itself, so we return the base without that suffix). Both supported
// hosts — api.github.com and api.SUB.ghe.com — serve GraphQL from the REST base.
function graphqlBaseFrom(restBase) {
  const fromEnv = process.env.GITHUB_GRAPHQL_URL;
  if (fromEnv) return fromEnv.replace(/\/graphql$/, "");
  return restBase;
}

export { createClient, poolFor };
