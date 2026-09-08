import { test } from "node:test";
import assert from "node:assert/strict";
import { committerEmail } from "../src/git.js";

test("committerEmail follows the runner's server host", () => {
  assert.equal(
    committerEmail("https://nicklegan.ghe.com"),
    "github-actions[bot]@users.noreply.nicklegan.ghe.com",
  );
  assert.equal(
    committerEmail("https://github.com"),
    "github-actions[bot]@users.noreply.github.com",
  );
  assert.equal(
    committerEmail("https://ghes.example.com/some/path"),
    "github-actions[bot]@users.noreply.ghes.example.com",
  );
});

test("committerEmail falls back to github.com when the server URL is missing", () => {
  assert.equal(committerEmail(""), "github-actions[bot]@users.noreply.github.com");
  assert.equal(committerEmail(undefined), "github-actions[bot]@users.noreply.github.com");
});
