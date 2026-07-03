# Worker sync: Todoist completed work

Turn finished Todoist tasks into a durable work journal in Notion. This Worker
maintains a **Completed Work** database related to **Projects**, giving
individuals a source for weekly reviews, status updates, retros, and personal
workload analysis without copying an active task list into a second system.

Todoist remains the place to plan and complete work. The Worker is read-only:
it never creates, edits, completes, reopens, or deletes a Todoist task.

## Quickstart

You need Node.js 22+, npm 10.9.2+, and a Todoist API token. In Todoist, open
**Settings > Integrations > Developer**, copy the API token, then run from the
repository root:

```sh
npm install --global ntn
cd workers/todoist-completed-work-sync
npm install
ntn login
ntn workers deploy --name todoist-completed-work-sync
ntn workers env set TODOIST_API_TOKEN=your-token
```

By default, the first completion sync imports the previous 365 days. To choose
an earlier fixed boundary, set it before the first run:

```sh
ntn workers env set TODOIST_HISTORY_START=2024-01-01
```

Preview both databases without writing to Notion:

```sh
ntn workers sync trigger projectsSync --preview
ntn workers sync trigger completedWorkSync --preview
```

Then populate Projects first so task relations can resolve immediately:

```sh
ntn workers sync trigger projectsSync
ntn workers sync trigger completedWorkSync
```

Projects refresh hourly and completed work refreshes every 15 minutes. The
Workers platform supplies Notion authentication; do not add a
`NOTION_API_TOKEN`.

## What this unlocks

The Todoist UI is optimized for deciding what to do next. This Worker creates
the retained, structured record needed to answer a different set of questions:

- What did I finish this week, grouped by project and priority?
- Which projects consumed the most completed work this month?
- Which finished tasks were repeatedly postponed or took longest to close?
- What belongs in a weekly update, one-on-one, performance review, or project
  retrospective?
- Which completed tasks had no due date, deadline, label, or project context?

Unlike an active-task mirror, completed rows remain useful after projects are
archived or Todoist stops returning a task. Add Notion properties such as
**Impact**, **Outcome**, **Customer**, or **Reflection**, and write notes in a
task page: later syncs update provider-owned fields without replacing those
user-owned properties or the page body.

## Reference

### Databases and capabilities

| Database                   | Capability              | Mode        | Schedule     | Purpose                                       |
| -------------------------- | ----------------------- | ----------- | ------------ | --------------------------------------------- |
| **Todoist Projects**       | `projectsSync`          | incremental | Every hour   | Last-known active and archived project data   |
| **Todoist Completed Work** | `completedWorkSync`     | incremental | Every 15 min | Recent completions and ongoing reconciliation |
| **Todoist Completed Work** | `completedWorkBackfill` | incremental | Manual       | Replay history without deleting enriched rows |

All three capabilities call the public [Todoist API v1](https://developer.todoist.com/api/v1/)
directly with read-only `GET` requests. The completed-work sync uses Todoist's
completion-date endpoint rather than trying to infer history from the active
tasks collection.

#### Todoist Completed Work

| Notion property          | Todoist value                                      | Type        |
| ------------------------ | -------------------------------------------------- | ----------- |
| Task                     | `content`                                          | title       |
| Completed                | `completed_at`                                     | date        |
| Project                  | relation keyed by `project_id`                     | relation    |
| Priority                 | priority 4–1 mapped to P1–P4                       | select      |
| Labels                   | `labels`                                           | multiSelect |
| Task Link                | stable Todoist app URL from task ID                | url         |
| Description              | `description`                                      | richText    |
| Description Truncated    | whether Description exceeded 2,000 characters      | checkbox    |
| Due / Due Text           | structured `due` date and its human-readable text  | date/text   |
| Recurring                | `due.is_recurring`                                 | checkbox    |
| Deadline                 | `deadline.date`                                    | date        |
| Planned Duration (min)   | normalized `duration`                              | number      |
| Days to Complete         | elapsed time from `added_at` to `completed_at`     | number      |
| Completion Count         | `completed_count`                                  | number      |
| Postponed Count          | `postponed_count`                                  | number      |
| Created / Updated        | `added_at` / `updated_at`                          | date        |
| Is Subtask               | whether `parent_id` is set                         | checkbox    |
| Completed By User ID     | raw `completed_by_uid`                             | richText    |
| Responsible User ID      | raw `responsible_uid`                              | richText    |
| Section / Parent Task ID | `section_id` / `parent_id`                         | richText    |
| Todoist Project ID       | `project_id`                                       | richText    |
| Todoist Task ID          | stable task `id`                                   | richText    |
| Completion ID            | task `id` + normalized `completed_at`; primary key | richText    |

Each completion occurrence uses a deterministic key built from its Todoist task
ID and normalized UTC completion timestamp. Replayed windows update the same
row rather than creating duplicates, while later completions of a recurring
task create new rows. **Completion Count** remains Todoist's aggregate count for
the underlying task at the time that occurrence was observed.

The completion endpoint does not provide a guaranteed tombstone stream for
tasks later reopened or removed. The Worker therefore retains every observed
completion snapshot instead of inferring deletion from a later absence.

#### Todoist Projects

| Notion property                 | Todoist value                                 | Type        |
| ------------------------------- | --------------------------------------------- | ----------- |
| Project                         | `name`                                        | title       |
| State                           | active or archived collection/state           | select      |
| Kind                            | personal or workspace-backed                  | select      |
| Workspace Status / Workspace ID | `status` / `workspace_id`                     | select/text |
| Color                           | humanized `color`                             | select      |
| Favorite / Shared / Inbox       | corresponding project flags                   | checkbox    |
| View / Role                     | `view_style` / `role`                         | select      |
| Description                     | `description`                                 | richText    |
| Description Truncated           | whether Description exceeded 2,000 characters | checkbox    |
| Created / Updated               | `created_at` / `updated_at`                   | date        |
| Parent Project ID               | `parent_id`                                   | richText    |
| Todoist Project ID              | immutable project `id`; primary key           | richText    |

The project sync walks both active and archived collections. It is incremental
by design: if a project becomes inaccessible or is deleted later, its last-known
row and any user-added context remain available to completed-work history.
Completed rows also retain the raw **Todoist Project ID**, so no source identity
is lost if a relation cannot resolve.

### How completion syncing works

1. A run pins an exclusive upper boundary one minute behind the current time,
   avoiding records that may still be settling in Todoist's index.
2. It reads fixed 30-day windows. Todoist permits at most three months per
   completion-date request, so the smaller window leaves ample safety margin.
3. Each window follows Todoist's cursor pagination at 200 records per request.
   The cursor is valid only with the same query parameters, so window boundaries
   remain pinned for every page.
4. Repeated cursors and runs above 1,000 pages fail visibly instead of looping
   forever or silently truncating history.
5. Only after every page in every window succeeds does the durable timestamp
   checkpoint advance. The next cycle overlaps the prior day; stable completion
   IDs make replay safe and protect against index lag and boundary writes.

Todoist advises against persisting list cursors for long-term polling. This
Worker retains a cursor only while finishing one pinned Worker cycle. Its
long-lived checkpoint is a completion timestamp, never an expired cursor.

Every page first verifies the authenticated Todoist user. That stable user ID is
stored in both in-flight state and terminal checkpoints, so replacing the token
with one for another account fails before source rows can be mixed. The user's
Todoist timezone is also used for floating due datetimes that carry no explicit
zone.

All capabilities share a conservative pacer of 60 requests per minute. HTTP
429 responses use Todoist's `Retry-After` metadata, including the structured
error-body value when available, and let the Workers runtime retry later.
Successful response bodies are capped at 8 MiB and error bodies at 64 KiB.
Oversized responses fail visibly, and provider-authored error prose is never
copied into Worker errors; only safe error identifiers are retained. Requests
time out after 30 seconds. Cursor values, recent cursor history, page count, and
serialized sync state are all bounded.

### Replaying older history

`completedWorkBackfill` has independent state so an explicit historical replay
does not disturb the frequent completion sync. Set the desired boundary, reset
the manual capability, and trigger it:

```sh
ntn workers env set TODOIST_HISTORY_START=2022-01-01
ntn workers sync state reset completedWorkBackfill
ntn workers sync trigger completedWorkBackfill
```

The endpoint accepts ranges of no more than three months, but the Worker
automatically divides any configured history into 30-day windows. Incremental
upserts mean a replay refreshes Todoist fields while retaining existing rows,
user-added database properties, and page notes.

### Suggested Notion views

- **This week:** Completed is within the past week, grouped by Project.
- **Weekly update:** Completed is within the past week, grouped by Priority;
  add a user-owned **Impact** or **Share** property for editorial selection.
- **Project retrospective:** filter one Project, sort Completed ascending, and
  show Days to Complete plus Postponed Count.
- **Recurring commitments:** Recurring is checked, sorted by Completion Count.
- **Work without structure:** Project is empty or Labels is empty, useful for
  finding recurring work that should be named and owned.

### Credentials and visibility

`TODOIST_API_TOKEN` determines everything the Worker can read. A personal API
token is appropriate for a personal deployment. If adapting this example into
a multi-user product, implement Todoist OAuth and request only the documented
read scope instead of collecting personal tokens.

Rotating a token for the same Todoist user is safe. Do not point an existing
deployment at a different Todoist account: the Worker rejects that account
change, and its incremental databases intentionally retain the original
account's history. Create a new deployment and managed databases for another
account.

**Completed By User ID** and **Responsible User ID** are raw Todoist identifiers,
not resolved display names. They preserve source attribution for downstream
enrichment, but this personal reference Worker does not create a people
directory or claim an assignee-friendly team workload view.

Review the managed databases' Notion sharing settings before sharing them more
broadly. Completed task descriptions, project names, and labels may contain
sensitive work context.

### Configuration

| Variable                | Required | Default      | Description                                             |
| ----------------------- | -------- | ------------ | ------------------------------------------------------- |
| `TODOIST_API_TOKEN`     | yes      | none         | Token used as a Bearer credential for Todoist API v1    |
| `TODOIST_HISTORY_START` | no       | 365 days ago | Earliest completion date, as `YYYY-MM-DD` or offset ISO |

For local execution, copy `.env.example` to `.env`. The file is gitignored and
must not be committed.

### Project structure

```text
src/
├── index.ts          — registers two databases and three sync capabilities
├── todoist.ts        — typed API v1 client, validation, and rate-limit handling
├── sync-state.ts     — window, cursor, checkpoint, and project phase transitions
├── completed-work.ts — completed-work schema and deterministic transform
├── projects.ts       — active/archived project schema and transform
└── helpers.ts        — bounded text, options, dates, URLs, and derived metrics
```

Fixtures under `fixtures/` exercise the API parser without network access.

### Local verification

Run the deterministic checks without a Todoist or Notion connection:

```sh
npm run check
npm test
npm run build
```

To execute against the Todoist account configured in a local `.env` file:

```sh
ntn workers exec projectsSync --local
ntn workers exec completedWorkSync --local
```

Deploy only after the offline checks pass:

```sh
ntn workers deploy --name todoist-completed-work-sync
```

## Boundaries

- This is a completed-work journal, not an active Todoist task sync.
- It is read-only and does not expose agent actions that mutate Todoist.
- It keeps one row per completion returned by Todoist, including later
  occurrences of recurring tasks; task ID plus completion time is the identity.
- Project rows are last-known snapshots; deletion is not inferred from absence.
- User attribution fields are raw IDs, not resolved names.
- API visibility, feature availability, and retained history remain subject to
  the authenticated Todoist account and plan.

## Adapting this Worker

Useful extensions include workspace/user enrichment that resolves raw user IDs,
or a Notion automation that drafts weekly updates from the Completed Work
database. Preserve the current account binding, timestamp checkpoint,
bounded-window, and completion-ID rules when changing the data model.
