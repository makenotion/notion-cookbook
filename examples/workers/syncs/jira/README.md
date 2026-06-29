# Worker sync: Jira Cloud

Syncs Jira Cloud issues, sprints, and projects into Notion databases that
stay up to date automatically. Once deployed, the worker checks Jira every
few minutes and creates or updates a Notion page for each record.

You don't need to create the Notion databases yourself. The worker declares the
schemas and Notion creates and manages each database for you (these are called
"managed databases").

## What you get

| Database | Jira resource | Schedule |
| --- | --- | --- |
| **Jira Issues** | Issues (via JQL search) | Every 2 min |
| **Jira Sprints** | Sprints (across Scrum boards) | Every 5 min |
| **Jira Projects** | Projects | Every 5 min |

### Jira Issues

| Notion property | Jira field | Type |
| --- | --- | --- |
| Summary | `summary` | title |
| Status | `status.name` | select |
| Issue Type | `issuetype.name` | select |
| Assignee | `assignee.displayName` | richText |
| Sprint | `sprint.name` | richText |
| Updated | `updated` | date |
| Status Category | `status.statusCategory.name` | select |
| Priority | `priority.name` | select |
| Reporter | `reporter.displayName` | richText |
| Project | `project.name` | richText |
| Issue Link | link to Jira issue | url |
| Labels | `labels` | multiSelect |
| Components | `components[].name` | multiSelect |
| Fix Versions | `fixVersions[].name` | multiSelect |
| Resolution | `resolution.name` | select |
| Due Date | `duedate` | date |
| Epic | `parent.fields.summary` or custom field | richText |
| Story Points | custom field (configurable) | number |
| Created | `created` | date |
| Issue Key | `key` (e.g. PROJ-123) | richText |

**Status Category** groups custom statuses (like "Waiting for Customer" or
"Code Review") into three categories: To Do, In Progress, Done. More useful
for high-level views than individual status names.

**Epic** is resolved from the issue's parent summary (next-gen/team-managed
projects) or from a custom field (classic projects — see optional env vars).

**Story Points** requires setting the `JIRA_STORY_POINTS_FIELD` env var.

### Jira Sprints

| Notion property | Jira field | Type |
| --- | --- | --- |
| Name | `name` | title |
| State | `state` | select |
| Board | board name (resolved) | richText |
| Start Date | `startDate` | date |
| End Date | `endDate` | date |
| Goal | `goal` | richText |
| Complete Date | `completeDate` | date |
| Sprint ID | `id` | richText |

Board IDs are resolved to names by fetching all Scrum boards once per sync
cycle. Only Scrum boards are fetched (Kanban boards don't have sprints).
Page body contains the sprint goal.

### Jira Projects

| Notion property | Jira field | Type |
| --- | --- | --- |
| Name | `name` | title |
| Project Key | `key` (e.g. PROJ) | richText |
| Lead | `lead.displayName` | richText |
| Category | `projectCategory.name` | select |
| Project Type | `projectTypeKey` | select |
| Project Link | link to Jira project | url |

Page body contains the project description.

## Project structure

```text
src/
├── index.ts      — registers all databases and syncs
├── jira.ts       — API client (auth, pagination, types, lookups)
├── issues.ts     — issue schema + transform
├── sprints.ts    — sprint schema + transform
├── projects.ts   — project schema + transform
└── helpers.ts    — shared utilities (dateOnly)
```

## How it works

1. **Issues** are fetched every 2 minutes via JQL search, scoped to
   specific projects if `JIRA_PROJECTS` is set. Uses `startAt`/`total`
   pagination (100 issues per page).
2. **Sprints** are fetched every 5 minutes by listing all Scrum boards,
   then fetching sprints for each. Board names are resolved once per cycle.
   Deleted boards are skipped gracefully.
3. **Projects** are fetched every 5 minutes via the project search endpoint.
4. All syncs share a single rate-limit pacer (9 requests per second) to stay
   within Jira Cloud's 10/second limit on Standard plans.
5. Because all syncs use `mode: "replace"`, records deleted from Jira are
   automatically removed from the Notion database on the next full sync.

## Prerequisites

- Node >= 22, npm >= 10.9.2
- A Jira Cloud instance
- The `ntn` CLI installed and authenticated (`ntn auth login`)

### Getting a Jira API token

1. Go to [https://id.atlassian.com/manage/api-tokens](https://id.atlassian.com/manage/api-tokens)
2. Click **Create API token**, give it a name, and copy the token
3. Note the email address associated with your Atlassian account

## Environment variables

### Required

| Variable | Description |
| --- | --- |
| `JIRA_DOMAIN` | Your Jira Cloud domain (e.g. `acme` for acme.atlassian.net) |
| `JIRA_EMAIL` | Email of the Atlassian account for API access |
| `JIRA_API_TOKEN` | API token from id.atlassian.com |

### Optional

| Variable | Description |
| --- | --- |
| `JIRA_PROJECTS` | Comma-separated project keys to sync (e.g. `PROJ,TEAM`). If not set, all projects are synced. |
| `JIRA_STORY_POINTS_FIELD` | Custom field ID for story points (e.g. `customfield_10016`) |
| `JIRA_EPIC_FIELD` | Custom field ID for epic link (e.g. `customfield_10014`) |

To find your custom field IDs, fetch any issue with all fields:
`GET https://{domain}.atlassian.net/rest/api/3/issue/{key}` and look for the
`customfield_XXXXX` entries containing story point values or epic references.

No `NOTION_API_TOKEN` is needed — the platform handles Notion credentials
automatically.

## Setup and deploy

1. Install the Notion Workers CLI:

   ```sh
   npm install -g @notionhq/ntn
   ```

2. Clone and install:

   ```sh
   cd examples/workers/syncs/jira
   npm install
   ```

3. Typecheck and test:

   ```sh
   npm run check
   npm test
   ```

4. Log in to Notion:

   ```sh
   ntn auth login
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

7. Optionally scope to specific projects and set custom fields:

   ```sh
   ntn workers env set JIRA_PROJECTS=PROJ,TEAM
   ntn workers env set JIRA_STORY_POINTS_FIELD=customfield_10016
   ntn workers env set JIRA_EPIC_FIELD=customfield_10014
   ```

8. Preview a sync without writing to Notion:

   ```sh
   ntn workers sync trigger issuesSync --preview
   ntn workers sync trigger sprintsSync --preview
   ntn workers sync trigger projectsSync --preview
   ```

9. Run a real sync:

   ```sh
   ntn workers sync trigger issuesSync
   ntn workers sync trigger sprintsSync
   ntn workers sync trigger projectsSync
   ```

Once deployed, all three syncs run automatically. Three databases will appear
in your Notion workspace after the first run.

## Adapting the schema

Each resource has its own file with a schema and transform function:

| Resource | File |
| --- | --- |
| Issues | `src/issues.ts` |
| Sprints | `src/sprints.ts` |
| Projects | `src/projects.ts` |

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
- [Contributing guide](../../../../CONTRIBUTING.md)
