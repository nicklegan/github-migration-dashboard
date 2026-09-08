import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePreference, resolveTheme, nextPreference } from "../src/theme.js";

test("anything that is not a pinned theme means follow the system", () => {
  assert.equal(normalizePreference("light"), "light");
  assert.equal(normalizePreference("dark"), "dark");
  assert.equal(normalizePreference(null), "system");
  assert.equal(normalizePreference(""), "system");
  assert.equal(normalizePreference("solarized"), "system");
});

test("with nothing pinned the system decides", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme(null, true), "dark");
});

test("a pinned theme overrides the system", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});

// Toggling away from the system pins the override.
test("toggling away from the system pins the opposite", () => {
  assert.equal(nextPreference("system", true), "light");
  assert.equal(nextPreference("system", false), "dark");
});

// Toggling back to what the system already wants drops the pin, so a reader who
// never really wanted an override goes back to following their machine.
test("toggling back to the system's own theme stops overriding it", () => {
  assert.equal(nextPreference("light", true), "system");
  assert.equal(nextPreference("dark", false), "system");
});

test("toggling is reversible from any starting point", () => {
  for (const prefersDark of [true, false]) {
    for (const start of ["system", "light", "dark"]) {
      const once = nextPreference(start, prefersDark);
      const twice = nextPreference(once, prefersDark);
      assert.equal(
        resolveTheme(twice, prefersDark),
        resolveTheme(start, prefersDark),
        `${start} @ prefersDark=${prefersDark} should round-trip`,
      );
      assert.notEqual(resolveTheme(once, prefersDark), resolveTheme(start, prefersDark));
    }
  }
});
