# Worker sync: Jira Cloud

Syncs Jira Cloud issues, current sprints, sprint performance, and projects
into Notion databases that stay up to date automatically. Each database uses
a schedule suited to its job, from a five-minute operational issue mirror to
daily sprint analytics and project reference data.

You don't need to create the Notion databases yourself. The worker declares the
schemas and Notion creates and manages each database for you (these are called
"managed databases").

## What you get

| Database                    | Purpose                                 | Schedule     |
| --------------------------- | --------------------------------------- | ------------ |
| **Jira Issues**             | Operational issue mirror                | Every 5 min  |
| **Jira Current Sprints**    | Active and future sprint mirror         | Every 15 min |
| **Jira Sprint Performance** | Cross-board sprint analytics and roster | Daily        |
| **Jira Projects**           | Project reference data                  | Daily        |

The four databases are intentionally independent. This example stores stable
Jira IDs but does not create Notion relations, avoiding sync-order and scope
dependencies that can make a ready-to-deploy mirror brittle.

### Jira Issues

| Notion property | Jira field                                           | Type        |
| --------------- | ---------------------------------------------------- | ----------- |
| Summary         | `summary`                                            | title       |
| Status          | `status.name`                                        | select      |
| Issue Type      | `issuetype.name`                                     | select      |
| Assignee        | `assignee.displayName`                               | richText    |
| Sprint          | discovered Sprint custom field                       | richText    |
| Updated         | `updated`                                            | date        |
| Status Category | `status.statusCategory.name`                         | select      |
| Priority        | `priority.name`                                      | select      |
| Reporter        | `reporter.displayName`                               | richText    |
| Project         | `project.name`                                       | richText    |
| Issue Link      | link to Jira issue                                   | url         |
| Labels          | `labels`                                             | multiSelect |
| Components      | `components[].name`                                  | multiSelect |
| Fix Versions    | `fixVersions[].name`                                 | multiSelect |
| Resolution      | `resolution.name`                                    | select      |
| Due Date        | `duedate`                                            | date        |
| Epic            | issue hierarchy or discovered Epic Link custom field | richText    |
| Story Points    | discovered Story Points custom field                 | number      |
| Created         | `created`                                            | date        |
| Issue Key       | `key` (e.g. PROJ-123)                                | richText    |
| Jira Issue ID   | `id` (immutable primary key)                         | richText    |

**Status Category** groups custom statuses (like "Waiting for Customer" or
"Code Review") into three categories: To Do, In Progress, Done. More useful
for high-level views than individual status names.

**Sprint**, **Story Points**, and **Epic Link** custom fields are discovered
automatically from Jira's field metadata. If your Jira instance has ambiguous
or renamed fields, use the optional environment variables below to specify the
field IDs explicitly.

Story Points discovery requests both Jira's company-managed **Story Points**
field and team-managed **Story point estimate** field when both exist, then
uses whichever is populated on each issue. Because this discovery is based on
the standard English field names, renamed or localized fields need an explicit
override.

**Epic** uses a standard issue's direct hierarchy parent, then falls back to
the discovered Epic Link field. A subtask's direct parent is a task or story,
so it is deliberately left blank rather than mislabeled when Jira doesn't
expose an explicit Epic Link for the subtask.

The immutable **Jira Issue ID** is the database primary key. **Issue Key**
remains a display property and is used in links, but it can change when an issue
moves to another project.

### Jira Current Sprints

| Notion property | Jira field            | Type     |
| --------------- | --------------------- | -------- |
| Name            | `name`                | title    |
| State           | `state`               | select   |
| Board           | board name (resolved) | richText |
| Start Date      | `startDate`           | date     |
| End Date        | `endDate`             | date     |
| Goal            | `goal`                | richText |
| Complete Date   | `completeDate`        | date     |
| Sprint ID       | `id`                  | richText |

This lightweight mirror includes only active and future sprints, making it
useful for current planning without mixing in years of closed sprint history.
Board IDs are resolved to names by fetching all Scrum boards once per sync
cycle. Only Scrum boards are fetched (Kanban boards don't have sprints). Page
body contains the sprint goal.

### Jira Sprint Performance

This daily analytical sync creates one scorecard per active or closed sprint
with configured start and end dates across the visible Scrum boards. It uses
each board's configured Story Points field and rightmost Done column, rather
than assuming one global field or completion status. Boards configured with a
different estimate field use issue counts so the example never labels time or
another unit as story points.

| PM question                              | Sprint scorecard output                                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Are we likely to complete the scope?     | Delivery Forecast, Forecast Completion %, Days Remaining                                           |
| What was committed versus completed?     | Committed and Completed Issues/Points, Predictability %, Completion %                              |
| How much scope changed after the start?  | Added and Removed Issues/Points, Estimate Change, Net Scope Change, Scope Change %                 |
| What rolled over?                        | Rolled Over Issues/Points and destination sprint names in the page body                            |
| What is the team's velocity?             | Velocity plus 3-Sprint and 5-Sprint rolling velocity for the same board                            |
| Which issues participated in the sprint? | A linked issue roster grouped by committed, added, completed, incomplete, removed, and rolled over |

The scorecard also records current scope, estimation basis, unestimated issue
count, metrics timestamp, and a **Data Quality** rating. Subtasks are excluded
from the numerical analytics to avoid double counting parent estimates, but
remain visible in a separate roster section.

For boards configured to estimate by issue count, velocity and percentages use
issue counts and the point-specific properties are left blank rather than
presenting counts as story points.

**Delivery Forecast** predicts delivery of the current sprint scope; it does
not claim to interpret whether Jira's free-text sprint goal will be achieved.
For closed sprints, the forecast becomes a delivered, partially delivered, or
missed outcome. Active forecasts require three comparable completed sprints
from the same board; until then they report **Insufficient Data** instead of
extrapolating from a small or early sample.

Historical analytics are best effort. Jira's sprint issue endpoint returns
issues that remain associated with a sprint, so an issue removed before this
worker first observes the sprint may be absent even when its changelog still
exists. Missing membership, estimate, completion, and rollover evidence is
surfaced in the **Data Quality** property and in a data-quality section on the
sprint page. Treat older Limited or Partial scorecards as directional rather
than exact Jira sprint reports.

### Jira Projects

| Notion property | Jira field                   | Type     |
| --------------- | ---------------------------- | -------- |
| Name            | `name`                       | title    |
| Project Key     | `key` (e.g. PROJ)            | richText |
| Lead            | `lead.displayName`           | richText |
| Category        | `projectCategory.name`       | select   |
| Project Type    | `projectTypeKey`             | select   |
| Project Link    | link to Jira project         | url      |
| Jira Project ID | `id` (immutable primary key) | richText |

Page body contains the project description.
The immutable **Jira Project ID** is the database primary key; **Project Key**
stays available as a display property because Jira administrators can change
it.

## Project structure

```text
src/
├── index.ts              — registers all databases and syncs
├── jira.ts               — API client (auth, pagination, types, lookups)
├── issues.ts             — issue schema + transform
├── sprints.ts            — current sprint schema + transform
├── all-sprints.ts        — fetches and normalizes sprint history
├── sprint-analytics.ts   — scorecard calculations, schema, and issue roster
├── projects.ts           — project schema + transform
└── helpers.ts            — shared utilities (dateOnly)
```

## How it works

1. **Issues** are fetched every 5 minutes via JQL search, scoped to
   specific projects if `JIRA_PROJECTS` is set. Uses `nextPageToken`
   pagination (100 issues per page). Jira truncation warnings abort the sync so
   a partial result can't be committed as a complete replacement snapshot.
2. **Current Sprints** are fetched every 15 minutes by listing all Scrum boards,
   then fetching only active and future sprints for each. Board names are
   resolved once per cycle and deleted boards are skipped gracefully.
3. **Sprint Performance** runs daily across all sprints. It combines board
   configuration, enhanced sprint issue pages, and bulk issue changelogs to
   reconstruct commitment, scope changes, completion, rollover, and velocity.
4. **Projects** are fetched daily via the project search endpoint.
5. All syncs share a single rate-limit pacer (9 requests per second). If Jira
   responds with HTTP 429, the worker passes Jira's `Retry-After` interval to
   the runtime so the request can be retried after the requested delay.
6. Because all syncs use `mode: "replace"`, records deleted from Jira are
   automatically removed from the Notion database on the next full sync.

## Prerequisites

- Node >= 22, npm >= 10.9.2
- A Jira Cloud instance
- The `ntn` CLI installed and authenticated (`ntn login`)

### Getting a Jira API token

1. Go to [https://id.atlassian.com/manage/api-tokens](https://id.atlassian.com/manage/api-tokens)
2. Click **Create API token**, give it a name, and copy the token
3. Note the email address associated with your Atlassian account

## Environment variables

### Required

| Variable         | Description                                                 |
| ---------------- | ----------------------------------------------------------- |
| `JIRA_DOMAIN`    | Your Jira Cloud domain (e.g. `acme` for acme.atlassian.net) |
| `JIRA_EMAIL`     | Email of the Atlassian account for API access               |
| `JIRA_API_TOKEN` | API token from id.atlassian.com                             |

### Optional

| Variable                  | Description                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JIRA_PROJECTS`           | Comma-separated project keys whose issues should be synced (e.g. `PROJ,TEAM`). Both sprint databases and the Projects database still include all visible data. |
| `JIRA_SPRINT_FIELD`       | Override the automatically discovered Sprint field ID (e.g. `customfield_10020`)                                                                               |
| `JIRA_STORY_POINTS_FIELD` | Override the automatically discovered Story Points field ID, or comma-separated IDs (e.g. `customfield_10016,customfield_10026`)                               |
| `JIRA_EPIC_FIELD`         | Override the automatically discovered Epic Link field ID (e.g. `customfield_10014`)                                                                            |

The worker normally discovers these custom fields from Jira's field metadata,
so no overrides are needed. To find an ID for an override, request
`GET https://{domain}.atlassian.net/rest/api/3/field` and find the relevant
`customfield_XXXXX` entry.

No `NOTION_API_TOKEN` is needed — the platform handles Notion credentials
automatically.

## Setup and deploy

1. Install the Notion Workers CLI:

   ```sh
   npm install --global ntn
   ```

2. Clone and install:

   ```sh
   cd workers/jira-sync
   npm install
   ```

3. Typecheck and test:

   ```sh
   npm run check
   npm test
   ```

4. Log in to Notion:

   ```sh
   ntn login
   ```

5. Deploy the worker:

   ```sh
   ntn workers deploy
   ```

6. Set environment variables on the deployed worker:

   ```sh
   ntn workers env set JIRA_DOMAIN=acme
   ntn workers env set JIRA_EMAIL=you@example.com
   ntn workers env set JIRA_API_TOKEN=your-api-token
   ```

7. Optionally scope the issue sync to specific projects and override custom
   fields:

   ```sh
   ntn workers env set JIRA_PROJECTS=PROJ,TEAM
   ntn workers env set JIRA_SPRINT_FIELD=customfield_10020
   ntn workers env set JIRA_STORY_POINTS_FIELD=customfield_10016
   ntn workers env set JIRA_EPIC_FIELD=customfield_10014
   ```

8. Preview a sync without writing to Notion:

   ```sh
   ntn workers sync trigger issuesSync --preview
   ntn workers sync trigger currentSprintsSync --preview
   ntn workers sync trigger allSprintsSync --preview
   ntn workers sync trigger projectsSync --preview
   ```

9. Run a real sync:

   ```sh
   ntn workers sync trigger issuesSync
   ntn workers sync trigger currentSprintsSync
   ntn workers sync trigger allSprintsSync
   ntn workers sync trigger projectsSync
   ```

Once deployed, all four syncs run automatically. Four databases will appear in
your Notion workspace after their first runs.

## Adapting the schema

Each resource has its own file with a schema and transform function:

| Resource           | File                      |
| ------------------ | ------------------------- |
| Issues             | `src/issues.ts`           |
| Current Sprints    | `src/sprints.ts`          |
| Sprint Performance | `src/sprint-analytics.ts` |
| Projects           | `src/projects.ts`         |

To add a new Jira field:

1. Add the field name to the `ISSUE_FIELDS` array in `src/jira.ts` (Jira only
   returns fields you request)
2. Add the field to the `JiraIssue` type in `src/jira.ts`
3. Add a property to the schema with the appropriate `Schema.*` type
4. Add a `Builder.*` call in the transform function

## Local testing

Run offline tests (no Jira connection needed):

```sh
npm test
```

Test a sync locally against a real Jira instance:

```sh
ntn workers exec issuesSync --local
```

## Learn more

- [Notion Workers documentation](https://developers.notion.com/docs/workers)
- [Jira Cloud REST API — Issue Search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)
- [Jira Software REST API — Sprints](https://developer.atlassian.com/cloud/jira/software/rest/api-group-sprint/)
- [Jira Cloud REST API — Projects](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/)
- [Jira API Tokens](https://id.atlassian.com/manage/api-tokens)
- [Contributing guide](../../CONTRIBUTING.md)
