# GitHub migration dashboard

> A GitHub Action that tracks every repository and Actions workflow migration
> across your enterprise, and builds a self-updating GitHub Pages dashboard from
> it.

The dashboard covers every organization in your enterprise from a single token,
and reports both of GitHub's migration paths to GitHub Enterprise Cloud:

- **GitHub Enterprise Importer (GEI)** — from Azure DevOps, Bitbucket, GitLab,
  GitHub.com, or GitHub Enterprise Server
- **Enterprise Live Migrations (ELM)** — from GitHub Enterprise Server to
  GitHub Enterprise Cloud with data residency

Migrations from both tools appear in the same tables, so every repository is
counted and dated the same way regardless of how it was moved. The action runs on
the destination; GitHub Enterprise Server is supported as a source only.

Moving a repository is only part of a migration. Workflow files are migrated, but
secrets, variables, environments, and runners are not. To show whether a migrated
repository is actually working, the dashboard also inventories its Actions
workflows and reports whether they have run successfully since the move.

| Tab                       | What it shows                                                                                    |
| :------------------------ | :----------------------------------------------------------------------------------------------- |
| **Onboarding**            | How long migrated repositories take to get running again, against their window                 |
| **Overview**              | KPI cards, breakdowns by organization, team, or source platform, and distributions             |
| **Repository migrations** | One row per target repository; expand to see every attempt                                       |
| **Workflow migrations**   | One row per repository; expand to see each Actions workflow and its status                       |

**Onboarding** leads, because moving a repository is the easy half; it is the
default tab whenever a window is configured. The overview then reads in two
sections — **What moved** and **What still runs**.

Every chart is a filter. Click a bar segment, a donut slice, a legend entry, or
the name beside a bar to select it; click again to deselect. Selections
accumulate, and every other chart, the KPI cards, and the tables follow. Bar
charts show the ten largest categories and roll the rest into **Other**.

![A walkthrough of the dashboard: the onboarding tab's recovery curve and time-to-onboard bars, the overview's breakdowns with a chart filtering everything else, a repository's migration attempts unfolding, and a repository's Actions workflows with their status](docs/dashboard.gif)

## Usage

The example
[workflow](https://docs.github.com/actions/reference/workflow-syntax-for-github-actions)
below refreshes the data on a schedule and publishes the dashboard to GitHub
Pages.

```yaml
name: Migration dashboard

on:
  schedule:
    - cron: '0 */2 * * 1-5' # Every 2 hours, Monday to Friday
  workflow_dispatch:
    inputs:
      refresh_attributes:
        description: Re-read team, size, and location for every repository
        type: boolean
        default: false

permissions:
  contents: write
  pages: write
  id-token: write

concurrency:
  group: migration-dashboard
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v7

      - name: Sync migration data
        id: sync
        uses: nicklegan/github-migration-dashboard@v1
        with:
          token: ${{ secrets.DASHBOARD_TOKEN }}
          refresh-attributes: ${{ inputs.refresh_attributes }}
          # team-property: 'team'
          # onboarding-window-days: '60'

      - name: Upload Pages artifact
        uses: actions/upload-pages-artifact@v5
        with:
          path: ${{ steps.sync.outputs.site-path }}

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deploy.outputs.page_url }}
    steps:
      - name: Deploy to GitHub Pages
        id: deploy
        uses: actions/deploy-pages@v5
```

The classic PAT never needs Pages access: the workflow's own `GITHUB_TOKEN`
publishes the site.

- :bulb: Before the first run, enable Actions on the repository and set the
  Pages source to **GitHub Actions**: Settings → Pages → Build and deployment.

## Action inputs

| Name                         | Description                                                                                                                                                                             | Default                                  | Location       | Required |
| :--------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------- | :------------- | :------- |
| `token`                      | Classic PAT that reads migrations, the audit log, and Actions runs. The default `GITHUB_TOKEN` cannot read these.                                                                        |                                          | [workflow.yml] | `true`   |
| `team-property`              | Organization custom property that holds the owning team. Its name is what the dashboard prints as a heading (`business_unit` → `Business unit`).                                          | `team`                                   | [workflow.yml] | `false`  |
| `onboarding-window-days`     | How long after a successful migration a newly added workflow still counts as part of that migration. `0` disables the window, and with it the Onboarding tab.                            | `60`                                     | [workflow.yml] | `false`  |
| `live-migrations`            | Also report Enterprise Live Migrations (GHES → data residency). GHE.com only; needs the `admin:enterprise` scope. Skipped automatically when unavailable.                              | `true`                                   | [action.yml]   | `false`  |
| `enterprise`                 | Enterprise slug to report on, as in `github.com/enterprises/<slug>`. Autosensed from the tenant host, or from the token. Only needed to disambiguate.                                    | (autosensed)                             | [action.yml]   | `false`  |
| `data-dir`                   | Directory holding the JSON data store the dashboard reads and the action commits.                                                                                                       | `data`                                   | [action.yml]   | `false`  |
| `api-url`                    | REST API base URL. Autosensed from the runner. Override only when the target organizations live on a different instance than the runner.                                                 | (autosensed)                             | [action.yml]   | `false`  |
| `inventory-ttl-days`         | How often to re-list a repository's workflows, so workflows added after migration are found even if they never run. `0` inventories each repository only once.                           | `7`                                      | [action.yml]   | `false`  |
| `attribute-ttl-days`         | How often to refresh a repository's team property and size while it is onboarding.                                                                                                       | `1`                                      | [action.yml]   | `false`  |
| `settled-attribute-ttl-days` | How often to refresh team and size once a repository is past its onboarding window, so a change of owning team is picked up. `0` freezes them at window close.                           | `7`                                      | [action.yml]   | `false`  |
| `refresh-attributes`         | Re-read team, size, and current location for every migrated repository this run, ignoring the TTLs. For a `workflow_dispatch` after reorganizing repositories. Costs one request per 100. | `false`                                  | [action.yml]   | `false`  |
| `row-chunk-size`             | Repositories per dashboard row chunk, within a migration month. Smaller chunks stream in sooner on very large estates.                                                                   | `2000`                                   | [action.yml]   | `false`  |
| `detail-buckets`             | How many files the per-repository detail is spread across. Expanding a row downloads one whole bucket, so raise this on a large estate. Safe to change at any time.                      | `256`                                    | [action.yml]   | `false`  |
| `rest-budget`                | Maximum REST calls per run. `0` means unlimited.                                                                                                                                        | `4000`                                   | [action.yml]   | `false`  |
| `graphql-budget`             | Maximum GraphQL requests per run. `0` means unlimited.                                                                                                                                  | `4000`                                   | [action.yml]   | `false`  |
| `audit-budget`               | Maximum audit-log requests per run. `0` means unlimited.                                                                                                                                | `1500`                                   | [action.yml]   | `false`  |
| `output-path`                | Directory the action writes the ready-to-deploy dashboard into.                                                                                                                         | `_site`                                  | [action.yml]   | `false`  |
| `commit-data`                | Commit and push the refreshed data store when it changes. Needs an `actions/checkout` step and `contents: write`.                                                                        | `true`                                   | [action.yml]   | `false`  |
| `commit-message`             | Commit message used when the data store is committed.                                                                                                                                   | `chore: update migration data [skip ci]` | [action.yml]   | `false`  |
| `committer-name`             | Author and committer name for data store commits.                                                                                                                                       | `github-actions[bot]`                    | [action.yml]   | `false`  |
| `committer-email`            | Author and committer email for data store commits. Empty derives the Actions bot address on the runner's host, e.g. `github-actions[bot]@users.noreply.github.com`.                     | _derived_                                | [action.yml]   | `false`  |

[workflow.yml]: #usage 'Usage'
[action.yml]: action.yml 'action.yml'

## Action outputs

| Name                    | Description                                                                  |
| :---------------------- | :--------------------------------------------------------------------------- |
| `changed`               | `true` when the data store was updated by the run.                           |
| `committed`             | `true` when the updated data store was committed and pushed.                 |
| `total`                 | Total number of migrated repositories in the store after the run.            |
| `truncated`             | `true` when a call budget was reached and the next run must resume.          |
| `skipped-organizations` | Number of organizations that could not be synced, listed in the run summary. |
| `site-path`             | Path to the assembled dashboard directory (equals `output-path`).            |

## GitHub secrets

| Name                 | Value                                                   | Required |
| :------------------- | :------------------------------------------------------ | :------- |
| `DASHBOARD_TOKEN`    | Classic PAT owned by an enterprise owner (scopes below) | `true`   |
| `ACTIONS_STEP_DEBUG` | `true` [Enables diagnostic logging]                     | `false`  |

[enables diagnostic logging]: https://docs.github.com/actions/managing-workflow-runs/enabling-debug-logging#enabling-runner-diagnostic-logging 'Enabling runner diagnostic logging'

## Required token

The migration APIs are not available to `GITHUB_TOKEN` or GitHub App tokens, so
this action takes a **classic personal access token**. Its owner must be an
**enterprise owner**, and an **organization owner** (or migrator) in each org.

| Scope              | Why it is needed                                                                       |
| :----------------- | :------------------------------------------------------------------------------------- |
| `repo`             | Repository migrations, repository size, Actions runs                                   |
| `admin:org`        | Repository migrations, organization repositories, and custom property values           |
| `workflow`         | Reads Actions workflows in migrated repositories                                       |
| `read:audit_log`   | Enterprise audit log: workflow runs, deletions, and each migration's duration          |
| `read:enterprise`  | Enumerates every organization in the enterprise                                        |
| `admin:enterprise` | Enterprise Live Migrations — only on a GHE.com (data residency) tenant; otherwise omit |

An organization the token cannot read is skipped with a warning and retried
daily.

- :bulb: Authorize the token for SSO in every organization: Settings → Developer
  settings → Personal access tokens → Configure SSO.

## Permissions

| Permission | Access  | Why it is needed                            |
| :--------- | :------ | :------------------------------------------ |
| `contents` | `write` | Check out and commit the data store         |
| `pages`    | `write` | Publish the assembled dashboard to Pages    |
| `id-token` | `write` | Required by the `actions/deploy-pages` step |

## Owning team

Every breakdown by team comes from a
[custom property](https://docs.github.com/organizations/managing-organization-settings/managing-custom-properties-for-repositories-in-your-organization)
— defined once on the organization, set per repository. `team-property` names it
(default `team`), and that name is what the dashboard prints, so an organization
that says business unit, group, or tribe gets its own word in the headings and
the CSV: a property called `business_unit` reads as `Business unit`.

A repository with the property unset counts as `Unassigned` rather than being
dropped, so the team breakdown always totals the whole estate. Changing
`team-property` re-reads every repository on the next run. The name is matched
regardless of case, and a multi-select property is shown as its values joined
with commas.

## Onboarding window

Actions workflows rarely arrive with the repository — some land the same day,
some weeks later. `onboarding-window-days` (default `60`) decides how long that
still counts as part of the migration. A workflow first seen inside the window is
migration scope; one first seen after it is badged `Added later` and does not
move migration metrics.

Closing the window does not declare success. A repository whose window closed
with a workflow still failing or never run is badged **not onboarded**
— that list is the point of the window, not a pass mark.

### Getting back online

A repository is **back online** when every workflow it is scored on has passed at
least once — the rule that badges it onboarded, now dated, so the **Onboarding**
tab can chart how long it took. One with nothing scored, or whose success predates
these dates being recorded, sits out of the charts rather than counting as never
recovered.

A repository counts as migrated when **any** attempt succeeded. A retry into a
*different* repository name marks the original `SUPERSEDED`, so it stops
counting as an outstanding failure without vanishing. A repository that
succeeded and was **later deleted** is badged `removed` and excluded from the
KPIs; a **failed** migration never created a repository, so it always counts —
that absence *is* the failure.

## Migration duration

Each migration is timed from its own migration log, read the first time the
dashboard sees it succeed. That log expires five days after the migration, so
anything older falls back to the audit log's record of the importer enabling
Actions — its final step. A migration that never enabled Actions and whose log
has gone stays undated rather than being timed from an earlier step.

## Renamed and transferred repositories

A repository that is renamed or transferred is reported **where it lives now** —
the link goes straight there, and the breakdowns follow it. The name it migrated
under is badged **was `old/name`**, exported as `Migrated as`, and still finds it
when searched. Tracking is by repository id, so a new repository reusing an old
name is not mistaken for it.

A move is noticed on the next attribute refresh, so it can lag by up to
`settled-attribute-ttl-days`; run with `refresh-attributes: true` to pick it up
immediately.

## Actions workflow status

Each migrated repository's Actions workflows are classified so the dashboard can
surface post-migration health:

| Status        | Meaning                                                    |
| :------------ | :--------------------------------------------------------- |
| **Succeeded** | At least one successful run ever — a rerun-to-green counts |
| **Failing**   | Ran, but never succeeded                                   |
| **Idle**      | No runs, or only cancelled/skipped/neutral runs            |
| **Manual**    | Never run, and nothing triggers it except a human          |

A repository's summary status is its **worst** workflow: one failure makes it
failing, and a workflow that never ran holds it at idle. Manual-only workflows
are excluded from the counts and the success rate *while they have never run*;
reusable (`workflow_call`-only) workflows are excluded entirely.

## Running at scale

A run costs about the same whether you have migrated 30,000 repositories or
300,000: the onboarding window holds the tracked population at `migrations per
day × onboarding-window-days`, the audit log is read once and scoped to the
organizations holding migrations, and every other phase resumes from a stored
cursor. Steady state is one request per organization plus a handful more.

The first run is the expensive one — one request per repository plus up to three
per workflow — and a classic token allows 5,000 REST requests an hour, so a large
estate takes several runs. Budgets are backstops: hitting one stops that phase,
commits its progress, sets the `truncated` output, and resumes next run. The
audit log's retention bounds history, so migrations older than it arrive without
a duration.

- :bulb: Raise `inventory-ttl-days`, `attribute-ttl-days`, and
  `settled-attribute-ttl-days` to trade freshness for headroom. Avoid
  `onboarding-window-days: 0` on a large estate: re-listing never retires a
  repository, so cost follows the estate rather than the migration rate.

## Where it runs

The action rides the runner-provided `GITHUB_API_URL` / `GITHUB_GRAPHQL_URL`, so
it works on github.com and ghe.com without per-platform branching. The
enterprise is autosensed from the `*.ghe.com` tenant host, or otherwise from the
token; if the token owns several, the one owning the workflow's organization
wins.

- :bulb: Set `enterprise` when autosensing is still ambiguous, and `api-url` only
  when the target organizations live on a different instance than the runner.

## Development

```sh
npm ci
npm test       # Unit tests (node --test), the dashboard's included
npm run build  # Bundles src/ into dist/index.js and site/ into dist/web/
```

Both build outputs are committed under `dist/`, and the runner executes `dist/`,
not `src/` — rebuild and commit it whenever `src/` or `site/` changes. CI fails
the build when `dist/` is out of date.
