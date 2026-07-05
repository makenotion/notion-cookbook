# Worker sync: Todoist tasks and project summaries

Sync every open Todoist task into a native Notion database and summarize open
and recently completed work by project. Use the result for daily task triage,
project review, and weekly status preparation without managing tasks twice.

Todoist remains the system of record. This Worker makes read-only Todoist API
requests and never creates, edits, completes, reopens, or deletes a Todoist
task.

## When to use it

Use this recipe when tasks are executed in Todoist but project notes, plans, or
status updates live in Notion. It creates two related managed databases:

| Database             | What it helps answer                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| **Todoist Tasks**    | What is overdue, due today, coming up, high priority, or still unscheduled?                           |
| **Todoist Projects** | How much open work does each project have, what is due soon, and what was completed in the last week? |

It is intentionally not a two-way task manager, employee-performance report,
time tracker, or permanent archive of completed tasks.

## Prerequisites

- Node.js 22 or newer
- npm 10.9.2 or newer
- Access to Notion Workers
- A Todoist personal API token from **Settings > Integrations > Developer**
- The immutable Todoist user ID returned by `GET /api/v1/user`

For a multi-user product, replace the personal token with Todoist OAuth and
request only the documented read scope.

## Setup

From the repository root:

```sh
npm install --global ntn@latest
cd workers/todoist-sync
npm install
ntn login
ntn workers deploy --name todoist-sync
ntn workers sync pause projectsSync
ntn workers sync pause tasksSync
```

Use `--name todoist-sync` only for the first deployment. The CLI records that
Worker in the gitignored `workers.json`. Keep that file and run
`ntn workers deploy` for later updates; using another name creates separate
managed databases.

Store the account binding and token in the deployed Worker environment:

```sh
ntn workers env set TODOIST_USER_ID=your-user-id
ntn workers env set TODOIST_API_TOKEN=your-token
```

Preview both capabilities while they remain paused:

```sh
ntn workers sync trigger projectsSync --preview
ntn workers sync trigger tasksSync --preview
```

Populate Projects first so task relations resolve on their first write:

```sh
ntn workers sync trigger projectsSync
ntn workers sync status projectsSync
```

Watch until Projects succeeds, then press Ctrl-C and run Tasks:

```sh
ntn workers sync trigger tasksSync
ntn workers sync status tasksSync
```

Watch until Tasks succeeds, then press Ctrl-C and start both schedules:

```sh
ntn workers sync resume projectsSync
ntn workers sync resume tasksSync
```

The first deployment starts both schedules. Keep them paused until credentials,
previews, and the ordered initial runs succeed. Tasks then refresh every 15
minutes and project summaries refresh hourly. The Workers platform supplies
Notion authentication; do not add a `NOTION_API_TOKEN`.

## Expected result

### Todoist Tasks

The primary columns are ordered for daily triage:

1. **Task**
2. **Due Status**
3. **Due**
4. **Project**
5. **Priority**
6. **Labels**

**Due Status** is recalculated from one pinned observation time in the
authenticated user's Todoist timezone:

- **Overdue** — a dated task is already past due
- **Today** — due today and not yet overdue
- **Next 7 days** — due after today through seven calendar days from today
- **Later** — due beyond that window
- **No due date** — unscheduled

Remaining fields retain the hard deadline, planned duration, Todoist link,
description, recurrence and subtask flags, source timestamps, and immutable
Todoist task ID.

The database contains all active Todoist tasks, including future and
unscheduled work. A completed or deleted task disappears only after a complete,
successful replacement scan. Open the **Open in Todoist** link to change it.

### Todoist Projects

The first six columns support project review and status preparation:

1. **Project**
2. **Open Tasks**
3. **Overdue**
4. **Due Next 7 Days**
5. **Completed Last 7 Days**
6. **Recent Completions**

Each active project also includes its next hard deadline, next non-overdue due
date, unscheduled and P1 task counts, planned minutes due in the next seven
days, last completion, description, source link, update time, and immutable ID.

**Completed Last 7 Days** counts completion occurrences in one pinned rolling
seven-day window. **Recent Completions** lists the five most recent task titles
and adds `+N more` when the count is larger. Completed tasks are useful summary
input; they are not copied into a third archive database.

Add your own Notion project properties or relations for status, goals,
customers, meeting notes, or specifications. The Worker owns only its declared
properties. Keep durable notes in separate Notion documents or a user-owned
projects database: managed task rows disappear when work is completed, and
managed project rows disappear when a Todoist project is no longer active.

## Recommended views

The Worker creates databases and properties, not opinionated views. In Notion,
use the synced properties to create:

- **Overdue** — `Due Status` is `Overdue`
- **Today** — `Due Status` is `Today`
- **Upcoming** — `Due Status` is `Next 7 days`
- **Unscheduled** — `Due Status` is `No due date`
- **High priority** — `Priority` is `P1 · Urgent` or `P2 · High`

The Projects database works well sorted by **Overdue** and then
**Due Next 7 Days**, both descending, with **Next Deadline** ascending.

## Sync and safety model

- **Replacement deletion requires a verified snapshot.** Publish traversals
  emit upserts page by page, but Notion removes unseen rows only after the final
  identity set exactly matches discovery and the cycle returns `hasMore: false`.
- **Mutable inputs use two passes.** Active tasks, recent completion
  occurrences, and active projects are discovered first and then traversed
  again. Exact immutable-ID equality catches duplicates and records skipped
  when Todoist data changes during cursor pagination.
- **Project rows publish after aggregation.** The project capability verifies
  active tasks and recent completions before discovering and publishing any
  project summary rows.
- **Inconsistent attempts recover without authorizing deletion.** The first
  expired cursor, duplicate, or membership change restarts immediately while
  no replacement rows have been emitted. A repeated inconsistency retries after
  at least one minute; if it persists, the Worker starts a fresh snapshot.
  After a publish page emits rows, an inconsistency errors without starting a
  new snapshot; a later retry can finish the same attempt if the source
  stabilizes. Reset that capability's platform state only to abandon a
  persistently stuck attempt. This avoids mixing two attempts in one
  replacement accumulator.
- **Pagination fails closed.** Missing, malformed, oversized, or repeated
  cursors never finish a partial replacement.
- **Counts reject duplicates.** Task IDs and completion-occurrence IDs are
  retained in bounded continuation state so repeated records cannot inflate
  project summaries.
- **Every capability enforces one account.** `TODOIST_USER_ID` is checked
  before source pages are read, including every resumed cursor page.
- **Dates are explicit.** Calendar dates are validated without rollover. Due
  classification uses the authenticated user's IANA timezone. Fixed-offset
  timestamps retain their instant; floating Todoist datetimes are interpreted
  as user-local values.
- **Provider access is bounded.** Requests share a conservative pacer, honor
  Todoist retry timing, time out, bound response bodies, and reject malformed
  success payloads.

The configured ceilings are 5,000 active tasks for the Tasks sync and, per
project-summary cycle, 250 referenced project aggregates, 5,000 active projects,
5,000 active tasks, and 5,000 completion occurrences. Both syncs are also
subject to a 200 KiB continuation-state ceiling. A larger account stops before
authorizing replacement deletion; narrow or adapt the limits for that
deployment.

## Configuration and privacy

| Variable            | Required | Purpose                                          |
| ------------------- | -------- | ------------------------------------------------ |
| `TODOIST_USER_ID`   | yes      | Immutable account ID checked by every capability |
| `TODOIST_API_TOKEN` | yes      | Personal Todoist bearer token                    |

Store deployed values with `ntn workers env set`, never in source control. For
local execution, copy `.env.example` to the gitignored `.env` file.

Task titles, descriptions, project names, and labels may contain sensitive
work context. Review the managed databases' Notion sharing settings before
inviting other people.

## Adapt the recipe

Useful, bounded extensions include:

1. Add a configurable Todoist filter when one deployment should expose only a
   subset of active tasks.
2. Resolve assignee IDs through a separate People database before adding team
   workload views; do not expose raw IDs as a people experience.
3. Relate Todoist Projects to an existing Notion projects database through a
   user-owned relation.

Keep active-task replacement and completion-occurrence aggregation separate.
Combining them into one historical task table makes recurring tasks and reopen
behavior ambiguous.

## Project structure

```text
src/
├── index.ts      — databases, schedules, and capability entry points
├── todoist.ts    — bounded Todoist API client and response validation
├── sync-state.ts — account-bound cursors and project aggregation phases
├── tasks.ts      — active-task schema, due classification, and transform
├── projects.ts   — project schema, aggregation, and transform
└── helpers.ts    — bounded text, options, dates, durations, and URLs
fixtures/         — offline Todoist response fixtures
test.ts           — schemas, transforms, state, pagination, and API failures
```

## Verify locally

The checks are deterministic and do not contact Todoist or Notion:

```sh
cd workers/todoist-sync
npm install
npm run check
npm test
npm run build
```

To execute against credentials in a gitignored `.env` file:

```sh
ntn workers exec projectsSync --local
ntn workers exec tasksSync --local
```

## Learn more

- [Notion sync guide](https://developers.notion.com/workers/guides/syncs)
- [Todoist API v1](https://developer.todoist.com/api/v1/)
- [Contributing guide](../../CONTRIBUTING.md)
