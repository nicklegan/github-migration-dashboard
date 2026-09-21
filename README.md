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

Both land in the same tables, counted and dated the same way. The action runs on
the destination; GitHub Enterprise Server is a source only.

Workflow files migrate; secrets, variables, environments, and runners do not. So
the dashboard also inventories each repository's Actions workflows and reports
whether they have run successfully since the move.

| Tab                   | What it shows                                                                      |
| :-------------------- | :--------------------------------------------------------------------------------- |
| **Overview**          | KPI cards, breakdowns by organization, team, or source platform, and distributions |
| **Onboarding**        | How long migrated repositories take to get running again, against their window     |
| **Repositories**      | One row per target repository; expand to see every attempt                         |
| **Actions workflows** | One row per repository; expand to see each workflow and its status                 |

Every chart is a filter: click a bar segment, a donut slice, or a legend entry to
select it, click again to clear. Selections accumulate and every other chart, the
KPI cards, and the tables follow. Bar charts show the ten largest categories and
roll the rest into **Other**.

![A walkthrough of the dashboard: the overview's breakdowns with a chart filtering everything else, the onboarding tab's time-to-onboard bars and recovery curve, a repository's migration attempts unfolding, and a repository's Actions workflows with their status](docs/dashboard.gif)

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

| Name                     | Description                                                                                                            | Default | Location       | Required |
| :----------------------- | :--------------------------------------------------------------------------------------------------------------------- | :------ | :------------- | :------- |
| `token`                  | Classic PAT that reads migrations, the audit log, and Actions runs.                                                    |         | [workflow.yml] | `true`   |
| `team-property`          | Organization custom property holding the owning team. Its name becomes the dashboard's heading.                        | `team`  | [workflow.yml] | `false`  |
| `onboarding-window-days` | How long after a migration a newly added workflow still counts as part of it. `0` disables it, and the Onboarding tab. | `60`    | [workflow.yml] | `false`  |
| `live-migrations`        | Also report Enterprise Live Migrations (GHES → data residency). GHE.com only; skipped when unavailable.                 | `true`  | [action.yml]   | `false`  |
| `refresh-attributes`     | Re-read team, size, and location for every repository this run, ignoring the TTLs. Costs one request per 100.           | `false` | [action.yml]   | `false`  |

### Tuning

Defaults suit most estates. See [action.yml](action.yml) for the full text.

| Name                         | Description                                                                              | Default                                  |
| :--------------------------- | :---------------------------------------------------------------------------------------- | :--------------------------------------- |
| `enterprise`                 | Enterprise slug to report on. Autosensed; set only to disambiguate.                      | (autosensed)                             |
| `api-url`                    | REST API base URL. Override only when the organizations live on another instance.        | (autosensed)                             |
| `data-dir`                   | Directory holding the JSON data store.                                                   | `data`                                   |
| `inventory-ttl-days`         | How often to re-list a repository's workflows. `0` inventories it once.                  | `7`                                      |
| `attribute-ttl-days`         | How often to refresh team and size while a repository is onboarding.                     | `1`                                      |
| `settled-attribute-ttl-days` | How often to refresh them once its window has closed. `0` freezes them.                  | `7`                                      |
| `row-chunk-size`             | Repositories per dashboard row chunk. Smaller chunks stream in sooner.                   | `2000`                                   |
| `detail-buckets`             | Files the per-repository detail is spread across. Raise on a large estate.               | `256`                                    |
| `rest-budget`                | Maximum REST calls per run. `0` is unlimited.                                            | `4000`                                   |
| `graphql-budget`             | Maximum GraphQL requests per run. `0` is unlimited.                                      | `4000`                                   |
| `audit-budget`               | Maximum audit-log requests per run. `0` is unlimited.                                    | `1500`                                   |
| `output-path`                | Directory the assembled dashboard is written to.                                         | `_site`                                  |
| `commit-data`                | Commit the refreshed data store when it changes. Needs `contents: write`.                | `true`                                   |
| `commit-message`             | Commit message for data store commits.                                                   | `chore: update migration data [skip ci]` |
| `committer-name`             | Author and committer name for those commits.                                             | `github-actions[bot]`                    |
| `committer-email`            | Author and committer email. Empty derives the Actions bot address on the runner's host.  | _derived_                                |

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

Team breakdowns come from an organization
[custom property](https://docs.github.com/organizations/managing-organization-settings/managing-custom-properties-for-repositories-in-your-organization),
defined once and set per repository. `team-property` names it, and that name is
what the dashboard prints, so an organization that says business unit, group, or
tribe gets its own word: `business_unit` reads as `Business unit`.

A repository with the property unset counts as `Unassigned` rather than being
dropped, so the breakdown always totals the whole estate. Changing
`team-property` re-reads every repository on the next run. The name is matched
regardless of case, and a multi-select property joins its values with commas.

## Onboarding window

Actions workflows rarely arrive with the repository — some land the same day,
some weeks later. `onboarding-window-days` decides how long that still counts as
part of the migration. A workflow first seen inside the window is migration
scope; one first seen after it is badged `Added later` and does not move
migration metrics.

Closing the window does not declare success. A repository whose window closed
with a workflow still failing or never run is badged **not onboarded**
— that list is the point of the window, not a pass mark.

### Getting back online

A repository is **back online** when every workflow it is scored on has passed at
least once — the rule that badges it onboarded, now dated, so the **Onboarding**
tab can chart how long it took. The curve stacks onboarded, part-way there, and
nothing running, so the three bands come to the whole population. A repository
with nothing scored has no recovery to chart and is left out; so is one whose
success predates these dates being recorded.

An estate migrated before this existed is dated by a one-time back-fill: two
requests per already-succeeded workflow, spread across runs and resumable. Until
most of the estate is dated the curve withholds itself and reports its progress,
because leaving the undated out drops successes without dropping failures.

## What counts as migrated

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
Actions — its final step, and bounded by the audit log's retention. A migration
that never enabled Actions and whose log has gone stays undated.

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
estate takes several runs. Hitting a budget stops that phase, commits its
progress, sets the `truncated` output, and resumes next run.

- :bulb: Raise the TTLs to trade freshness for headroom. Avoid
  `onboarding-window-days: 0` on a large estate: re-listing never retires a
  repository, so cost follows the estate rather than the migration rate.

## Where it runs

The action rides the runner-provided `GITHUB_API_URL` / `GITHUB_GRAPHQL_URL`, so
github.com and ghe.com both work without per-platform branching. The enterprise
is autosensed from the tenant host, or from the token; set `enterprise` only
when that is ambiguous.

## Development

```sh
npm ci
npm test       # Unit tests (node --test), the dashboard's included
npm run build  # Bundles src/ into dist/index.js and site/ into dist/web/
```

Both build outputs are committed under `dist/`, and the runner executes `dist/`,
not `src/` — rebuild and commit it whenever `src/` or `site/` changes. CI fails
the build when `dist/` is out of date.
