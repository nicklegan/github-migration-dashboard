import * as core from "@actions/core";

// How often the running total is written to the log. Every call would drown the
// log; every fifty keeps a long phase visibly alive and the cost legible.
const PROGRESS_EVERY = 50;
// Below this share of the hourly limit a pool is close enough to warn about.
const LOW_SHARE = 0.1;

const LABELS = { rest: "REST", graphql: "GraphQL", audit: "Audit log" };

// Bounds a run's API usage so it stops cleanly instead of exhausting the token
// or blowing the job timeout. Progress is persisted by the caller, so the next
// run resumes rather than restarting.
//
// It also watches the rate-limit headers on every response, so the log can say
// how close the token is to GitHub's own limit — which is shared with whatever
// else the token is doing this hour and is the number that actually stops a run.
class Budget {
  constructor({ rest = Infinity, graphql = Infinity, audit = Infinity } = {}) {
    this.limits = { rest, graphql, audit };
    this.spent = { rest: 0, graphql: 0, audit: 0 };
    this.exhausted = new Set();
    this.rateLimits = {};
    this.observed = 0;
    this.warnedLow = new Set();
  }

  // Returns false once the pool is spent, so callers can stop a phase early.
  take(pool, amount = 1) {
    if (this.exhausted.has(pool)) return false;
    if (this.spent[pool] + amount > this.limits[pool]) {
      this.exhaust(pool, `${pool} call budget of ${this.limits[pool]} reached`);
      return false;
    }
    this.spent[pool] += amount;
    return true;
  }

  // Closes a pool for the rest of the run. The configured budget is a guess at
  // what is safe; GitHub's own rate limit is the fact, so hitting it closes the
  // pool just as reaching the budget does.
  exhaust(pool, reason) {
    if (this.exhausted.has(pool)) return;
    this.exhausted.add(pool);
    core.warning(`${reason}; the next run resumes where this one stopped.`);
  }

  get truncated() {
    return this.exhausted.size > 0;
  }

  // Records the rate-limit headers a response carried. Called from the client's
  // after-request hook, so every REST, GraphQL, and audit-log response counts.
  observe(pool, headers = {}) {
    const limit = Number(headers["x-ratelimit-limit"]);
    const remaining = Number(headers["x-ratelimit-remaining"]);
    const reset = Number(headers["x-ratelimit-reset"]);
    if (Number.isFinite(limit) && Number.isFinite(remaining)) {
      this.rateLimits[pool] = {
        limit,
        remaining,
        resetAt: Number.isFinite(reset) ? reset * 1000 : null,
      };
      if (limit > 0 && remaining / limit < LOW_SHARE && !this.warnedLow.has(pool)) {
        this.warnedLow.add(pool);
        core.warning(
          `${LABELS[pool]} rate limit is nearly used up: ${remaining} of ${limit} left` +
            `${resetLabel(this.rateLimits[pool])}. The run stops that phase cleanly if it runs out.`,
        );
      }
    }
    this.observed += 1;
    if (this.observed % PROGRESS_EVERY === 0) core.info(`API calls so far: ${this.describe()}`);
  }

  // One line per pool with calls made, the budget, and GitHub's remaining
  // allowance where a response has told us, e.g.
  // "REST 350/4000 (4,650 of 5,000 left, resets 15:00Z)".
  describe() {
    return Object.keys(this.spent)
      .map((pool) => {
        const cap = this.limits[pool] === Infinity ? "" : `/${this.limits[pool]}`;
        const rate = this.rateLimits[pool];
        const headroom = rate
          ? ` (${rate.remaining.toLocaleString()} of ${rate.limit.toLocaleString()} left${resetLabel(rate)})`
          : "";
        return `${LABELS[pool]} ${this.spent[pool]}${cap}${headroom}`;
      })
      .join(", ");
  }

  report() {
    return { ...this.spent };
  }
}

function resetLabel(rate) {
  if (!rate?.resetAt) return "";
  const time = new Date(rate.resetAt).toISOString().slice(11, 16);
  return `, resets ${time}Z`;
}

export { Budget, PROGRESS_EVERY };
