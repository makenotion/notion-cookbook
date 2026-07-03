# Worker sync: Todoist completed work

Turn finished Todoist tasks into a durable work journal in Notion. This Worker
creates related **Completed Work** and **Projects** databases for weekly reviews,
status updates, retrospectives, and personal workload analysis.

Todoist remains the place to plan and complete work. The Worker makes read-only
API requests and never creates, edits, completes, reopens, or deletes a Todoist
task.

## Quickstart

You need Node.js 22+, npm 10.9.2+, access to Notion Workers, and a Todoist API
token from **Settings > Integrations > Developer**.

From the repository root:

```sh
npm install --global ntn
cd workers/todoist-completed-work-sync
npm install
ntn login
ntn workers deploy --name todoist-completed-work-sync
```

The first completion sync imports the previous 365 days. To choose an earlier
fixed boundary, set it before enabling scheduled reads with the token:

```sh
ntn workers env set TODOIST_HISTORY_START=2024-01-01
ntn workers env set TODOIST_API_TOKEN=your-token
```

If the default 365-day boundary is right, set only `TODOIST_API_TOKEN`.

Preview the output, then populate Projects first so task relations resolve
immediately:

```sh
ntn workers sync trigger projectsSync --preview
ntn workers sync trigger completedWorkSync --preview

ntn workers sync trigger projectsSync
ntn workers sync trigger completedWorkSync
```

Projects then refresh hourly and completed work every 15 minutes. The Workers
platform supplies Notion authentication; do not add a `NOTION_API_TOKEN`.

## What you can answer

| Managed database           | Questions it helps answer                                                                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Todoist Completed Work** | What did I finish this week? Which tasks took longest, were postponed often, or lacked labels or due dates? What belongs in a status update, one-on-one, performance review, or retrospective? |
| **Todoist Projects**       | Which active or archived projects account for completed work? How is finished work distributed across projects and workspaces?                                                                 |

Useful Completed Work properties include **Completed**, **Project**,
**Priority**, **Labels**, **Due**, **Deadline**, **Planned Duration**,
**Days to Complete**, **Postponed Count**, and a direct **Task Link**. Projects
include their active or archived state, workspace context, and source metadata.
See `src/completed-work.ts` and `src/projects.ts` for the complete schemas.

Add your own Notion properties such as **Impact**, **Outcome**, **Customer**, or
**Reflection**, and write notes in each page body. Later syncs update only the
Worker-owned properties; they do not replace user-added properties or page
content.

## Reference

### Synced databases and schedules

| Managed database           | Schedule     | What it contains                                                                                             |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| **Todoist Completed Work** | Every 15 min | One row per completion occurrence, with project, priority, labels, dates, duration, and task-history signals |
| **Todoist Projects**       | Every hour   | Last-known active and archived projects related to completed work                                            |

### How it works

- **One row means one completion.** The primary key combines the immutable task
  ID with its normalized completion time. Replaying a window updates the same
  row, while a later occurrence of a recurring task creates a new row.
- **History is non-destructive.** Todoist does not provide reliable tombstones
  for completions that are later reopened or removed. The Worker keeps every
  completion it has observed and retains last-known projects instead of
  inferring deletion from absence.
- **Relations use stable IDs.** Completed rows relate to Projects by Todoist
  project ID and also retain the raw ID if a relation cannot resolve.
- **Pagination is replay-safe.** The Worker reads fixed 30-day completion
  windows, follows Todoist cursors, and advances its timestamp checkpoint only
  after every page in every window succeeds. Each scheduled run overlaps the
  previous day; deterministic keys make that replay idempotent.
- **Initialized capabilities detect account changes.** Each capability pins the
  authenticated Todoist user ID in its own state and rejects a later token for
  another account. A new or reset capability has no prior binding, so never
  repoint an existing deployment; use a separate deployment and databases.
- **Dates are explicit.** Completion times are normalized to UTC. Floating due
  datetimes use the authenticated user's Todoist timezone.

The API client paces requests, honors Todoist retry timing, applies timeouts and
response-size limits, and bounds cursor state. A bad or partial API response
fails visibly rather than advancing the checkpoint with incomplete history.

`completedWorkSync` and `completedWorkBackfill` both use incremental upserts.
Neither capability automatically removes existing Notion rows.

### Replay older history

The manual backfill has independent state, so replaying older work does not
disturb the frequent sync. Confirm the deployment still uses the original
account token, then set the boundary, reset only the backfill, and run it:

```sh
ntn workers env set TODOIST_HISTORY_START=2022-01-01
ntn workers sync state reset completedWorkBackfill
ntn workers sync trigger completedWorkBackfill
```

The Worker divides long ranges into 30-day windows automatically. Existing
completion rows are refreshed without deleting user-added properties or notes.

### Credentials and privacy

| Variable                | Required | Default      | Purpose                                                    |
| ----------------------- | -------- | ------------ | ---------------------------------------------------------- |
| `TODOIST_API_TOKEN`     | yes      | none         | Personal Todoist bearer token                              |
| `TODOIST_HISTORY_START` | no       | 365 days ago | Earliest completion date or timezone-qualified ISO instant |

The token can read the Todoist data visible to its owner. Store it with
`ntn workers env set`, never in source control. For local execution, copy
`.env.example` to the gitignored `.env` file.

Completed task descriptions, project names, and labels may contain sensitive
work context, so review the managed databases' Notion sharing settings. The
**Completed By User ID** and **Responsible User ID** properties are raw Todoist
identifiers, not display names. This personal recipe does not build a team people
directory or claim an assignee-friendly workload view.

For a multi-user product, replace the personal token with Todoist OAuth and
request only the documented read scope.

### Adapt the recipe

High-value extensions include:

1. **Resolve people.** Add a related People database so raw completion and
   responsibility IDs become names, teams, or workspace members.
2. **Draft weekly updates.** Add a Notion automation or Agent Tool that turns a
   reviewed weekly view into a status update. The sync itself continues to run
   independently and does not require AI or a Notion Agent.
3. **Add source fields.** Extend the validated Todoist type, its Notion schema,
   transform, README, and fixtures together.
4. **Add active work separately.** Keep this append-only completion journal and
   create another database and capability for current tasks rather than mixing
   two different retention models.

Preserve the account binding, completion-occurrence primary key, pinned windows,
timestamp checkpoint, and non-destructive history when adapting the data model.

### Project structure

```text
src/
├── index.ts          — databases, schedules, and capability entry points
├── todoist.ts        — typed API client and response validation
├── sync-state.ts     — windows, cursors, checkpoints, and account binding
├── completed-work.ts — Completed Work schema and transform
├── projects.ts       — Projects schema and transform
└── helpers.ts        — bounded text, options, dates, URLs, and metrics
fixtures/             — offline Todoist response fixtures
test.ts               — transforms, state transitions, and API failure tests
```

### Local testing

The checks are deterministic and do not contact Todoist or Notion. From the
repository root:

```sh
cd workers/todoist-completed-work-sync
npm install
npm run check
npm test
npm run build
```

To exercise the capabilities locally against the account in `.env`:

```sh
ntn workers exec projectsSync --local
ntn workers exec completedWorkSync --local
```

## Learn more

- [Notion sync guide](https://developers.notion.com/workers/guides/syncs)
- [Todoist API v1](https://developer.todoist.com/api/v1/)
- [Contributing guide](../../CONTRIBUTING.md)
