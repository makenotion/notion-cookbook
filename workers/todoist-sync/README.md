# Worker sync: Todoist

Bring active Todoist tasks and projects into two related Notion databases. Use
the task database for daily triage and the project database to review open work,
deadlines, and recent completions.

Todoist remains the system of record. The worker only reads from Todoist and
links each managed page back to its source record.

## Quickstart

You need Node.js 22+, npm 10.9.2+, Notion Workers access, and a Todoist personal
API token from **Settings > Integrations > Developer**. You also need the
account's stable `id` from `GET https://api.todoist.com/api/v1/user`.

From the repository root:

```sh
npm install --global ntn@latest
cd workers/todoist-sync
npm install
ntn login
ntn workers deploy --name todoist-sync
ntn workers sync pause projectsSync
ntn workers sync pause tasksSync
ntn workers env set TODOIST_USER_ID=your-user-id
ntn workers env set TODOIST_API_TOKEN=your-token
```

Use `--name todoist-sync` only for the first deployment. Later updates use
`ntn workers deploy`; the gitignored `workers.json` identifies the existing
Worker and its managed databases.

Keep both schedules paused while you validate credentials and the first
discovery page. A single preview invokes one callback and may return no changes:

```sh
ntn workers sync trigger projectsSync --preview
ntn workers sync trigger tasksSync --preview
```

Use the returned `nextContext` with `--context` to continue an optional preview.
Then run each trigger and status pair in order, waiting for success and pressing
Ctrl-C before continuing. Populate Projects before Tasks so relations resolve on
their first write:

```sh
ntn workers sync trigger projectsSync
ntn workers sync status projectsSync
ntn workers sync trigger tasksSync
ntn workers sync status tasksSync
ntn workers sync resume projectsSync
ntn workers sync resume tasksSync
```

Preview output can contain task titles, descriptions, labels, and project names.
Treat it as sensitive. No `NOTION_API_TOKEN` is required; the Workers platform
supplies Notion access.

## What you can answer

| Managed database     | Questions it helps answer                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Todoist Tasks**    | What is overdue, due today, coming up, high priority, or unscheduled? What project does each task belong to? |
| **Todoist Projects** | Which projects have the most open, overdue, urgent, or unscheduled work? What is due or completed recently?  |

The task properties lead with **Task**, **Due Status**, **Due**, **Project**,
**Priority**, and **Labels**. Project properties lead with **Project**, **Open
Tasks**, **Overdue**, **Due Next 7 Days**, **Completed Last 7 Days**, and
**Recent Completions**. Completed tasks contribute only to project summaries;
the worker does not create a completed-task archive.

## Reference

### Synced databases and schedules

| Database             | Sync           | Mode    | Schedule     | Scope                                  |
| -------------------- | -------------- | ------- | ------------ | -------------------------------------- |
| **Todoist Projects** | `projectsSync` | replace | Every hour   | Active projects visible to the account |
| **Todoist Tasks**    | `tasksSync`    | replace | Every 15 min | Active tasks visible to the account    |

The databases are related by stable Todoist project IDs. The worker declares
these properties in order:

- **Todoist Tasks:** Task, Due Status, Due, Project, Priority, Labels, Deadline,
  Planned Duration (min), Open in Todoist, Description, Recurring, Is Subtask,
  Created, Updated, Todoist Task ID.
- **Todoist Projects:** Project, Open Tasks, Overdue, Due Next 7 Days, Completed
  Last 7 Days, Recent Completions, Next Deadline, Next Due, Unscheduled, P1
  Tasks, Planned Minutes Next 7 Days, Last Completed, Description, Open in
  Todoist, Updated, Todoist Project ID.

Notion also adds a reciprocal **Tasks** relation to Todoist Projects.

**Due Status** is derived in the account's Todoist timezone from one observation
time pinned for the run. Its values are **Overdue**, **Today**, **Next 7 days**,
**Later**, and **No due date**.

Project metrics use active tasks plus a pinned rolling seven-day completion
window. Tasks due today count toward **Due Next 7 Days** and **Planned Minutes
Next 7 Days**. **Recent Completions** lists up to five titles; **Last
Completed** is the latest completion inside that same window. **Next Deadline**
is the earliest active task deadline, including an overdue one, while **Next
Due** is the earliest non-overdue due value.

### How it works

1. Every page request verifies the authenticated user against `TODOIST_USER_ID`
   and uses that account's timezone.
2. Tasks and projects are discovered, then emitted during a second traversal.
   That traversal must reproduce the discovered identity set before replacement
   completes.
3. Project rows aggregate verified active tasks and a separately verified recent
   completion window.
4. Replace-mode removal happens only after the final identity set is verified.
   An incomplete run does not remove unseen pages, although earlier upserts may
   already be visible.

Before rows are emitted, an identity change or expired cursor starts a fresh
discovery. After emission, the worker fails closed so an incomplete traversal
cannot authorize deletion. Duplicate identities and cursors that repeat without
advancing are always rejected. A stuck traversal can be abandoned with
`ntn workers sync state reset projectsSync` or
`ntn workers sync state reset tasksSync`. Each inventory is bounded to 5,000
tasks, projects, or completion occurrences and a 200 KiB continuation state.

A record absent from Todoist's active inventory is removed from Notion after a
successful replacement. Completing a recurring task normally advances the same
task ID to its next occurrence, so its existing page is updated instead. Any
notes or custom property values on a removed page are removed with it; keep
durable project context elsewhere.

### Configuration reference

| Variable            | Required | Secret | Description                                    |
| ------------------- | -------- | ------ | ---------------------------------------------- |
| `TODOIST_USER_ID`   | Yes      | No     | Stable account ID checked on every source page |
| `TODOIST_API_TOKEN` | Yes      | Yes    | Personal token for the same Todoist account    |

One deployment represents one Todoist account. Deploy a separate Worker and
managed databases for another account.

## Development

`src/index.ts` registers both databases and schedules; `src/sync.ts` owns sync
traversal and continuation state; `src/todoist.ts` owns the bounded API client;
`src/tasks.ts` and `src/projects.ts` contain the schemas and transforms; and
`src/helpers.ts` contains shared text, date, due-status, duration, and link
transforms.

To add a field, validate it in `src/todoist.ts`, update the relevant schema and
transform, and test both populated and missing values. Keep Todoist IDs as sync
keys.

Run deterministic checks without Todoist or Notion credentials:

```sh
npm run check
npm test
npm run build
```

For a local credential check, copy the safe template, add your Todoist values,
and invoke the first discovery callback without writing to Notion:

```sh
cd workers/todoist-sync
cp .env.example .env
ntn workers sync trigger projectsSync --local --preview
ntn workers sync trigger tasksSync --local --preview
```

Never commit `.env`, credentials, preview output, or generated Worker state.

## Learn more

- [Notion Workers overview](https://developers.notion.com/workers/get-started/overview)
- [Notion sync guide](https://developers.notion.com/workers/guides/syncs)
- [Todoist API v1](https://developer.todoist.com/api/v1/)
- [Contributing guide](../../CONTRIBUTING.md)
