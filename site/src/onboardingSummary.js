// The Onboarding tab's opening paragraph: the handful of numbers that matter,
// in sentences, so nobody has to assemble them from five charts. Pure — it
// takes the figures the tab already computes and returns sentences as parts
// (plain strings, and { strong } for the numbers), so the wording unit-tests
// without React.

const pct = (share) => `${Math.round(share * 100)}%`;
const days = (value) => `${Math.round(value)} days`;
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

// Under these a difference is noise, and the sentence says "about the same"
// rather than claim a direction.
const DAYS_LEVEL = 1;
const SHARE_LEVEL = 0.01;

function withinPhrase(day) {
  return day === 7 ? "within a week" : `within ${day} days`;
}

// Where every repository stands against its window. The two groups are told
// apart because only one of them has been decided: a repository still inside
// its window can yet go green, so it is not in the on-time rate.
function statusSentences(status, windowDays) {
  const settled = status.settled ?? 0;
  const greenOpen = Math.max(0, (status.complete ?? 0) - (status.onTimeSettled ?? 0));
  const open = (status.inProgress ?? 0) + greenOpen;
  const sentences = [];

  if (settled > 0) {
    const parts = [
      "Of the ",
      { strong: plural(settled, "repository", "repositories") },
      ` whose ${windowDays}-day window has closed, `,
      { strong: pct(status.onTimeSettled / settled) },
      " had every workflow green in time",
    ];
    const tail = [];
    if (status.late > 0) tail.push([{ strong: pct(status.late / settled) }, " got there late"]);
    if (status.incomplete > 0) {
      tail.push([{ strong: pct(status.incomplete / settled) }, " still have a workflow failing or never run"]);
    }
    tail.forEach((clause, i) => parts.push(i === tail.length - 1 ? ", and " : ", ", ...clause));
    parts.push(".");
    sentences.push(parts);
  } else {
    sentences.push([`No repository's ${windowDays}-day window has closed yet.`]);
  }

  if (open > 0) {
    const parts = [settled > 0 ? "Another " : "", { strong: open.toLocaleString() }, ` ${open === 1 ? "is" : "are"} still inside their window`];
    if (greenOpen > 0) parts.push(", ", { strong: greenOpen.toLocaleString() }, " of them already fully green");
    parts.push(".");
    sentences.push(parts);
  }
  return sentences;
}

// How long it takes: the first week, and the day half are fully green, set
// against the window so "68 days" reads as "longer than we allow".
function speedSentence(overall, windowDays) {
  const firstDay = Object.keys(overall?.by ?? {}).map(Number)[0];
  const early = firstDay != null ? overall.by[firstDay] : null;
  const median = overall?.median;
  const parts = [];

  if (early) parts.push({ strong: pct(early.share) }, ` are fully green ${withinPhrase(firstDay)}`);

  if (median?.days != null) {
    const verdict = median.days > windowDays ? `longer than the ${windowDays}-day window` : `inside the ${windowDays}-day window`;
    parts.push(parts.length ? ", and half take " : "Half take ", { strong: days(median.days) }, ` — ${verdict}`);
  } else if (median?.over != null) {
    parts.push(parts.length ? ", but fewer than half are fully green after " : "Fewer than half are fully green after ", {
      strong: days(median.over),
    });
  }
  if (parts.length === 0) return null;
  parts.push(".");
  return parts;
}

function change(periods, pick) {
  const measured = periods.filter((p) => pick(p) != null);
  if (measured.length < 2) return null;
  const [previous, current] = measured.slice(-2);
  return { current: pick(current), previous: pick(previous), currentPeriod: current, previousPeriod: previous };
}

// One comparison as a clause, and whether it is good news (1), bad (-1), or
// level (0), so two clauses can be joined with "and" or "but".
function speedClause(c) {
  const diff = c.current - c.previous;
  const figures = ` (median ${Math.round(c.current)} vs ${Math.round(c.previous)} days)`;
  if (Math.abs(diff) < DAYS_LEVEL) return { tone: 0, parts: ["took about as long to become fully green", figures] };
  return diff < 0
    ? { tone: 1, parts: ["became fully green ", { strong: "faster" }, figures] }
    : { tone: -1, parts: ["took ", { strong: "longer" }, " to become fully green", figures] };
}

function earlyClause(c, day) {
  const diff = c.current - c.previous;
  const figures = ` (${pct(c.current)} vs ${pct(c.previous)})`;
  const within = withinPhrase(day);
  if (Math.abs(diff) < SHARE_LEVEL) return { tone: 0, parts: [`were about as often fully green ${within}`, figures] };
  return diff > 0
    ? { tone: 1, parts: ["were ", { strong: "more often" }, ` fully green ${within}`, figures] }
    : { tone: -1, parts: ["were ", { strong: "less often" }, ` fully green ${within}`, figures] };
}

function compared(previousPeriod, currentPeriod, clauses) {
  const parts = [
    `Compared with repositories migrated ${previousPeriod.phrase ?? previousPeriod.label}, those migrated ${currentPeriod.phrase ?? currentPeriod.label} `,
  ];
  clauses.forEach((clause, i) => {
    if (i > 0) parts.push(clauses[0].tone * clause.tone < 0 ? ", but " : ", and ");
    parts.push(...clause.parts);
  });
  parts.push(".");
  return parts;
}

// Is it getting better: the latest period (the caller passes months) against
// the one before, on the median and on the first week — the first week because
// it is known within days of migrating, so a change in tooling shows there
// first.
function trendSentences(periods) {
  const firstDay = Object.keys(periods[0]?.by ?? {}).map(Number)[0];
  const speed = change(periods, (p) => p.median?.days);
  const early = firstDay != null ? change(periods, (p) => p.by?.[firstDay]?.share) : null;
  if (!speed && !early) {
    return [["Too few repositories have been migrated long enough ago to compare periods yet."]];
  }

  const same =
    speed && early && speed.currentPeriod.key === early.currentPeriod.key && speed.previousPeriod.key === early.previousPeriod.key;
  if (same) return [compared(speed.previousPeriod, speed.currentPeriod, [speedClause(speed), earlyClause(early, firstDay)])];

  const sentences = [];
  if (speed) sentences.push(compared(speed.previousPeriod, speed.currentPeriod, [speedClause(speed)]));
  if (early) sentences.push(compared(early.previousPeriod, early.currentPeriod, [earlyClause(early, firstDay)]));
  return sentences;
}

function onboardingSummary({ status, overall, periods = [], windowDays }) {
  if (!(windowDays > 0) || !status) return [];
  const speed = speedSentence(overall, windowDays);
  return [...statusSentences(status, windowDays), ...(speed ? [speed] : []), ...trendSentences(periods)];
}

// The sentences as plain text, for tests and anywhere markup is not wanted.
function summaryText(sentences) {
  return sentences.map((parts) => parts.map((p) => (typeof p === "string" ? p : p.strong)).join("")).join(" ");
}

export { onboardingSummary, summaryText };
