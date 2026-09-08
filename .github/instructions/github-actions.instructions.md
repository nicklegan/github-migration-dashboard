---
description: Conventions for authoring GitHub Actions (JavaScript/ESM, bundled with esbuild).
applyTo: '**'
---

# GitHub Action authoring conventions

Build every GitHub Action in this repository as a **bundled JavaScript action**
following the layout and conventions below. When scaffolding a new action or
editing an existing one, keep it consistent with this structure.

## Repository layout

```
action.yml            # Action metadata at the repo root
src/                  # ES module source (index.js entry + focused modules)
dist/                 # Bundled, committed output (esbuild) — action.yml points here
test/                 # *.test.js files run by node --test
docs/                 # Only what the README cannot carry (e.g. templates)
.github/
  workflows/          # CI / release workflows
  CODEOWNERS
  dependabot.yml
  CODE_OF_CONDUCT.md
  CONTRIBUTING.md
  SECURITY.md
.nvmrc                # Node major version (matches action.yml runtime)
.gitignore
LICENSE               # MIT
README.md
package.json
package-lock.json
```

## Runtime and language

- **ESM only.** `package.json` sets `"type": "module"`; use `import`/`export`,
  never `require` in `src/`.
- **Node 24.** `action.yml` uses `runs.using: node24`; `.nvmrc` is `24`;
  `package.json` `engines` pins `"node": ">=24"` and `"npm": ">=11"`.
- Use the official toolkit packages: `@actions/core`, `@actions/exec`,
  `@actions/github`. Add `@octokit/*` packages only when the toolkit is
  insufficient.
- **Prefer GraphQL over REST.** When an operation is available via GitHub's
  GraphQL API, use it (`octokit.graphql(...)`) instead of the REST endpoint.
  Fall back to REST only for operations GraphQL does not expose (e.g. most
  migration APIs, which are REST-only).

## `action.yml`

- Lives at the repo root. Include `name`, `description`, `author`, and a
  `branding` block (`icon`, `color`).
- Declare every input under `inputs:` with a `description`. Mark truly required
  inputs `required: true`; give optional inputs a `default`.
- **Quote string defaults** that are booleans or contain special characters
  (e.g. `default: 'false'`, `default: 'backport:'`).
- Point the runtime at the bundle:
  ```yaml
  runs:
    using: node24
    main: dist/index.js
  ```

## `package.json`

- **`name`** matches the repository/action name; keep **`description`** aligned
  with `action.yml`.
- **`main`** is `"dist/index.js"` and **`"type": "module"`** (ESM).
- **Always use this author and contributors block** verbatim:
  ```json
  "author": {
    "name": "GitHub Expert Services",
    "email": "services@github.com",
    "url": "https://services.github.com"
  },
  "contributors": [
    {
      "name": "Nick Nagel",
      "email": "nicklegan@github.com",
      "url": "https://github.com/nicklegan"
    }
  ],
  ```
- Include a `repository` block pointing at the action's Git URL, and set
  `"license": "MIT"`.
- **`engines`** pins `"node": ">=24"` and `"npm": ">=11"`.
- **`scripts`** are exactly `build` (the esbuild command below) and
  `test` (`node --test`).
- **Dependencies — always use the latest published version, never lower than
  what is already in use.** When adding or bumping a package, resolve the newest
  release and pin it with a caret (`^`) at or above the current baseline; never
  downgrade. Current baselines to meet or exceed:
  - `@actions/core` `^3.0.1`
  - `@actions/exec` `^3.0.0`
  - `@actions/github` `^9.1.1`
  - `@octokit/auth-app` `^8.3.0` (only for GitHub App auth actions)
  - `esbuild` `^0.28.2` (devDependency)
- Migration actions that authenticate with a classic PAT do **not** need
  `@octokit/auth-app`; drop it and add only the `@octokit/*` packages the
  migration endpoints require.
- Keep `package-lock.json` committed and in sync (`npm install` after any
  manifest change).

## `src/` structure

- `src/index.js` is the entry point — thin orchestration only. It reads inputs,
  wires modules together, and calls `core.setFailed(err.message)` on failure.
- Split logic into **focused, single-responsibility modules** (e.g. `auth.js`,
  `config.js`, `git.js`, plus one module per feature). Keep pure/testable logic
  separate from I/O so it can be unit-tested without mocking the whole action.
- Read and validate all inputs in one place (a `config.js`-style module) rather
  than scattering `core.getInput` calls.
- Read inputs with the toolkit helpers: `core.getInput('name', { required: true })`
  for strings and `core.getBooleanInput('name')` for booleans. Emit results with
  `core.setOutput`, group logs with `core.startGroup`/`endGroup`, and write a
  run summary with `core.summary` where useful.
- Fail with `core.setFailed(err.message)` — never `process.exit`. Mask any
  sensitive value derived at runtime with `core.setSecret` before logging around
  it.
- Prefer **configurable, prefixed inputs** over hardcoded values (e.g. a
  `label-prefix` input rather than a fixed label), and give every optional input
  a sensible `default`.
- Design the action to be **idempotent** — re-running on the same event should
  reconcile to the same end state rather than duplicating side effects.

## JavaScript patterns

- Run external tools through **`@actions/exec`** (`exec` / `getExecOutput`), not
  `child_process`. Wrap them in thin helpers, pass `{ silent: true }` when
  capturing and `.trim()` the output, and use `{ ignoreReturnCode: true }` when a
  non-zero exit is expected and handled rather than thrown.
- **Never pass secrets as command-line arguments** (they leak into logged command
  lines). Feed them on stdin via `{ input: Buffer.from(secret) }`, and call
  `core.setSecret` before use. When writing key material to disk, restrict
  permissions (`fs.mkdirSync(dir, { mode: 0o700 })`, `fs.writeFileSync(file, data, { mode: 0o600 })`).
- Import Node built-ins with the **`node:` prefix** (`node:fs`, `node:os`,
  `node:path`).
- Thread a single **`ctx`/config object** through functions instead of long
  positional parameter lists; extend it with `{ ...ctx, extra }` rather than
  adding parameters.
- Keep parsing, naming, and predicate helpers in **pure, I/O-free modules** so
  they unit-test directly; small named predicates (`isForkPR(pr)`) read better
  than inline conditions.
- In `index.js`, dispatch on `context.eventName` with a `switch`, and `core.info`
  + no-op on unsupported events instead of failing.
- **Comment the "why", not the "what"** — reserve comments for non-obvious
  reasons (why a workaround exists), not a restatement of the next line.

## Authentication

- **Migration actions authenticate with a classic personal access token (PAT).**
  The GitHub migration APIs (org/repo migrations, GEI) are not supported by
  GitHub App installation tokens or fine-grained PATs, so these actions must take
  a **classic PAT** as input and use it for all API calls.
  - Take the token as a `token` input sourced from a repository secret (e.g.
    `token: ${{ secrets.MIGRATION_TOKEN }}`). Never hardcode or log it.
  - Document the required classic PAT scopes in the README (typically
    `repo` and `read:org`, plus `read:audit_log` for actions that read the
    organization audit log — confirm against the specific migration endpoints
    the action calls). Enumerate the scopes in a table with a why-it-is-needed
    column rather than a prose list.
  - Pass the token to `@actions/github`'s `getOctokit(token)` (or an
    `@octokit/*` client); do not rely on the default `GITHUB_TOKEN`, which lacks
    migration permissions.
- For non-migration actions that open PRs, push commits, or need the events they
  create to trigger downstream CI, authenticate as a **GitHub App** and derive an
  installation token in the action (via `@octokit/auth-app`) instead. Take
  `app-id` and `private-key` as inputs sourced from repository secrets; never
  hardcode or log secret values.

## Data residency (github.com and ghe.com)

- Every action **must work on github.com, ghe.com (data residency), and GHES**
  without per-platform branching. Never hardcode `api.github.com`,
  `github.com`, or any host — derive everything from the runner-provided
  environment.
- Ride the runner-provided base URLs. `getOctokit` respects them when you pass
  `baseUrl`:
  ```js
  const apiUrl = process.env.GITHUB_API_URL;       // REST base
  const graphqlUrl = process.env.GITHUB_GRAPHQL_URL; // GraphQL base
  const options = apiUrl ? { baseUrl: apiUrl } : {};
  const octokit = getOctokit(token, options);
  if (graphqlUrl) {
    // Octokit re-appends "/graphql"; strip it so GHES lands on /api/graphql.
    octokit.graphql = octokit.graphql.defaults({
      baseUrl: graphqlUrl.replace(/\/graphql$/, ""),
    });
  }
  ```
- Derive host-dependent values from the environment too — e.g. a default
  committer email off the server host:
  `github-actions[bot]@users.noreply.${new URL(process.env.GITHUB_SERVER_URL || 'https://github.com').host}`.
- With GitHub App auth, mint the installation token via REST on the
  tenant-host Octokit (as above); `@octokit/auth-app`'s installation flow would
  otherwise POST to `api.github.com` and break on ghe.com/GHES.

## Build and `dist/`

- Bundle with **esbuild** into a single committed `dist/index.js`. Keep the
  `build` script consistent:
  ```json
  "build": "esbuild src/index.js --bundle --platform=node --format=esm --target=node24 --outfile=dist/index.js --minify --banner:js=\"import { createRequire } from 'module'; const require = createRequire(import.meta.url);\""
  ```
- **Always rebuild and commit `dist/` whenever `src/` or dependencies change** —
  the runtime executes `dist/`, not `src/`. A stale bundle is a common failure.

## Testing

- Use Node's built-in test runner: `"test": "node --test"`. No external test
  framework.
- Place tests in `test/<module>.test.js`, one file per source module, using
  `node:test` and `node:assert`.
- Test the pure logic modules directly; avoid networked or Git-dependent tests.

## Development workflow

- **Initialize a Git repository** for every new action (`git init`) and commit as
  you go — make a commit after each meaningful change rather than one large
  commit at the end, so the history is reviewable and revertible.
- After changing `src/` or dependencies, run `npm run build` and commit the
  refreshed `dist/` in the same change.
- Write temporary or scratch files to a **`tmp/` folder inside the workspace**
  (create it if missing), never to `/tmp` or other system-root locations. `tmp/`
  is gitignored.

## `.github` meta files

- Keep `CODEOWNERS`, `dependabot.yml`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`,
  and `SECURITY.md` present and current.
- Keep a single **`.github/workflows/ci.yml`** that runs on `push` to `main` and
  on `pull_request`, with `permissions: contents: read`. Its steps:
  ```yaml
  - uses: actions/checkout@v7
  - uses: actions/setup-node@v7
    with:
      node-version-file: .nvmrc
      cache: npm
  - run: npm ci
  - run: npm test
  - name: Verify dist/ is up to date
    run: |
      npm run build
      if [ -n "$(git status --porcelain dist)" ]; then
        echo "::error::dist/ is out of date — run 'npm run build' and commit the result."
        git --no-pager diff -- dist
        exit 1
      fi
  ```

## Static file contents

Verbatim templates for `CODEOWNERS`, `dependabot.yml`, `SECURITY.md`,
`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `LICENSE`, and a `README.md` skeleton
live in [docs/action-static-files.md](../../docs/action-static-files.md). When
scaffolding a new action, open that file and copy each template in, substituting
the repo owner/name and copyright holder/year where noted.

## `.gitignore`

- Ignore at least `node_modules/`, `*.log`, `tmp/`,
  `.github/copilot-instructions.md`, and `docs/action-static-files.md`. Never
  ignore `dist/` — it is committed.

## Versioning and releases

- Tag releases with SemVer (`v1.0.1`) and also move a major-version tag (`v1`)
  to the latest compatible release so consumers can pin `uses: owner/action@v1`.
- Publish to the GitHub Marketplace from the release.

## Documentation

- `README.md` documents usage with a complete example workflow, an inputs table
  (name, description, default, location, required), required secrets, and
  permissions. Follow a consistent section order: badges → short description →
  Usage (example workflow) → Action inputs → Action outputs → GitHub secrets →
  Required token / permissions → feature-specific behavior → Development. Match
  the house style: a `> blockquote` one-liner under the badges, aligned
  Markdown tables, a `Location` column linking inputs to `#usage`/`action.yml`,
  and `:bulb:` tip bullets under each section.
- In example workflows, pin helper actions to a major version
  (`actions/checkout@v7`, `actions/setup-node@v7`), scope `permissions:` to the
  least privilege, and — for Git-dependent actions — check out with
  `fetch-depth: 0`. Use a `concurrency` group when concurrent runs would
  conflict.
- Keep setup instructions in the README rather than a separate walkthrough. Add a
  `docs/` file only for something the README genuinely cannot carry, such as a
  `pull-request-template.md`, and link to it.

## Security

- Never echo secrets to logs. Reference secrets only via inputs.
- Request the **least privilege** needed — scope workflow `permissions:` and
  GitHub App permissions to exactly what the action requires.
