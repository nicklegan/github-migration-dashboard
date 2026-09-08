// Theme preference resolution. Pure — no DOM, no React — so the rules that
// decide what the toggle does unit-test directly.

const STORAGE_KEY = "migration-dashboard-theme";

const THEMES = ["light", "dark"];

// A stored preference is either a pinned theme or absent, which means "follow
// the operating system".
function normalizePreference(value) {
  return THEMES.includes(value) ? value : "system";
}

function resolveTheme(preference, prefersDark) {
  const pinned = normalizePreference(preference);
  if (pinned !== "system") return pinned;
  return prefersDark ? "dark" : "light";
}

// What the toggle should store next. Flipping back to whatever the system is
// already asking for drops the pin instead of duplicating it, so a reader who
// never really wanted an override keeps following their OS.
function nextPreference(preference, prefersDark) {
  const showing = resolveTheme(preference, prefersDark);
  const wanted = showing === "dark" ? "light" : "dark";
  return resolveTheme("system", prefersDark) === wanted ? "system" : wanted;
}

export { STORAGE_KEY, THEMES, normalizePreference, resolveTheme, nextPreference };
