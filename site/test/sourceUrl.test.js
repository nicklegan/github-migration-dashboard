import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSourceUrl } from "../src/sourceUrl.js";

test("GitHub, ghe.com, and GHES split into owner and repository", () => {
  assert.deepEqual(parseSourceUrl("https://github.com/octo-org/api"), {
    namespace: "octo-org",
    repository: "api",
  });
  assert.deepEqual(parseSourceUrl("https://nicklegan.ghe.com/sandbox/api"), {
    namespace: "sandbox",
    repository: "api",
  });
  assert.deepEqual(parseSourceUrl("https://ghes.example.com/platform/api"), {
    namespace: "platform",
    repository: "api",
  });
});

test("GitLab keeps nested subgroups in the namespace", () => {
  assert.deepEqual(parseSourceUrl("https://gitlab.dev/gl/widgets"), {
    namespace: "gl",
    repository: "widgets",
  });
  assert.deepEqual(parseSourceUrl("https://gitlab.dev/devops/iac/aws/account-template"), {
    namespace: "devops/iac/aws",
    repository: "account-template",
  });
});

test("GitLab parses the same on gitlab.com and self-hosted hosts", () => {
  const expected = { namespace: "gl", repository: "widgets" };
  assert.deepEqual(parseSourceUrl("https://gitlab.com/gl/widgets"), expected);
  assert.deepEqual(parseSourceUrl("https://gitlab.example.com/gl/widgets"), expected);
  assert.deepEqual(parseSourceUrl("https://gitlab-17-3-7.local/gl/widgets"), expected);
  assert.deepEqual(parseSourceUrl("http://localhost:8929/gl/widgets"), expected);
});

test("Bitbucket Cloud splits into workspace and repository", () => {
  assert.deepEqual(parseSourceUrl("https://bitbucket.org/acme/payments"), {
    namespace: "acme",
    repository: "payments",
  });
});

test("Bitbucket Server handles both clone and browse paths", () => {
  assert.deepEqual(parseSourceUrl("https://bitbucket.acme.com/scm/PLAT/payments.git"), {
    namespace: "PLAT",
    repository: "payments",
  });
  assert.deepEqual(
    parseSourceUrl("https://bitbucket.acme.com/projects/PLAT/repos/payments/browse"),
    { namespace: "PLAT", repository: "payments" },
  );
});

test("Azure DevOps takes the repository after the _git marker", () => {
  assert.deepEqual(parseSourceUrl("https://dev.azure.com/acme/Platform/_git/payments"), {
    namespace: "acme/Platform",
    repository: "payments",
  });
  assert.deepEqual(parseSourceUrl("https://acme.visualstudio.com/Platform/_git/payments"), {
    namespace: "Platform",
    repository: "payments",
  });
  assert.deepEqual(
    parseSourceUrl("https://dev.azure.com/acme/DefaultCollection/Platform/_git/payments"),
    { namespace: "acme/DefaultCollection/Platform", repository: "payments" },
  );
});

test("a trailing .git suffix is dropped", () => {
  assert.deepEqual(parseSourceUrl("https://gitlab.dev/gl/widgets.git"), {
    namespace: "gl",
    repository: "widgets",
  });
});

test("percent-encoded segments are decoded", () => {
  assert.deepEqual(parseSourceUrl("https://dev.azure.com/acme/My%20Project/_git/payments"), {
    namespace: "acme/My Project",
    repository: "payments",
  });
});

test("a URL with no path yields nothing rather than a bogus split", () => {
  assert.equal(parseSourceUrl("https://not-used"), null);
  assert.equal(parseSourceUrl("https://not-used/"), null);
});

test("missing or malformed input yields nothing", () => {
  assert.equal(parseSourceUrl(""), null);
  assert.equal(parseSourceUrl(null), null);
  assert.equal(parseSourceUrl("not a url"), null);
});

test("a single-segment path is a repository without a namespace", () => {
  assert.deepEqual(parseSourceUrl("https://gitlab.dev/widgets"), {
    namespace: null,
    repository: "widgets",
  });
});
