# Worker sync: Linear

Bring Linear projects, issues, and initiatives into Notion so product,
engineering, and leadership teams can review execution and strategy together.
The worker creates and maintains all three databases for you, while preserving
links back to Linear for day-to-day work.

## Quickstart

You need Node.js 22+, a
[Linear personal API key](#getting-a-linear-personal-api-key), and a Linear
user who can read the work you want to sync. Create a key in **Linear >
Settings > Security & access > API keys**, then run these commands from the
repository root:

```sh
npm install --global ntn
cd workers/linear-sync
npm install
ntn login
ntn workers deploy --name linear-sync
ntn workers env set LINEAR_API_KEY=lin_api_your-key-here
```

Preview the issue sync without writing to Notion:

```sh
ntn workers sync trigger issuesSync --preview
```

Then create and populate the three databases immediately:

```sh
ntn workers sync trigger projectsSync
ntn workers sync trigger issuesSync
ntn workers sync trigger initiativesSync
```

The worker keeps them current automatically: issues every five minutes,
projects every 15 minutes, and initiatives every hour. A daily issue sweep
repairs drift and removes records that Linear has permanently deleted.

Everything visible to the Linear API key can be copied, including project and
initiative update narratives. Review the destination databases' Notion sharing
settings before giving a broader audience access.

## What you can answer

| Managed database       | Questions it helps answer                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Linear Projects**    | Which projects are at risk or approaching their target date? Which projects lack a lead, priority, or recent status update?        |
| **Linear Issues**      | What is overdue, high priority, or unassigned? How is active work distributed across teams, projects, cycles, and workflow stages? |
| **Linear Initiatives** | Which initiatives are at risk or approaching their target date? Which strategic initiatives have no contributing projects?         |

## Reference

### Synced databases and schedules

Three databases are maintained by four syncs:

| Database               | Sync                       | Mode        | Schedule     |
| ---------------------- | -------------------------- | ----------- | ------------ |
| **Linear Projects**    | `projectsSync`             | replace     | Every 15 min |
| **Linear Issues**      | `issuesSync`               | incremental | Every 5 min  |
| **Linear Issues**      | `issuesReconciliationSync` | replace     | Daily        |
| **Linear Initiatives** | `initiativesSync`          | replace     | Every hour   |

The two issue syncs intentionally target the same managed database. The fast
incremental sync keeps active work current; the daily replacement sweep repairs
drift and removes records that Linear has permanently deleted.

The databases are otherwise independent. Project, initiative, team, and cycle
names are stored as readable values instead of Notion relations. This keeps
the example reliable when resources have different visibility, are synced on
different schedules, or are archived and deleted in a different order.

#### Linear Projects

| Notion property   | Linear field                           | Type     |
| ----------------- | -------------------------------------- | -------- |
| Name              | `name`                                 | title    |
| Status            | workspace-specific `status.name`       | select   |
| Health            | `health`                               | select   |
| Lead              | `lead.displayName` or `lead.name`      | richText |
| Project Link      | `url`                                  | url      |
| Progress %        | `progress` converted from 0–1 to 0–100 | number   |
| Target Date       | `targetDate`                           | date     |
| Updated           | `updatedAt`                            | date     |
| Last Update At    | `lastUpdate.updatedAt`                 | date     |
| Last Update Link  | `lastUpdate.url`                       | url      |
| Status Category   | canonical category from `status.type`  | select   |
| Priority          | `priorityLabel` or `priority`          | select   |
| Start Date        | `startDate`                            | date     |
| Started           | `startedAt`                            | date     |
| Completed         | `completedAt`                          | date     |
| Canceled          | `canceledAt`                           | date     |
| Created           | `createdAt`                            | date     |
| Archived          | whether `archivedAt` is set            | checkbox |
| Slug ID           | `slugId`                               | richText |
| Linear Project ID | `id`                                   | richText |

Each project page body starts with the latest status-update narrative, author,
date, and source link, followed by Linear's richer `content` field (or
`description` fallback). **Status** preserves the team's custom name, while
**Status Category** provides a stable cross-project rollup. Update edits also
participate in the sync freshness watermark.

**Linear Project ID**, the immutable UUID, is the primary key. **Slug ID**
remains visible for recognition and cross-referencing but is not used for
identity because human-readable identifiers can change.

#### Linear Issues

| Notion property   | Linear field                         | Type        |
| ----------------- | ------------------------------------ | ----------- |
| Title             | `title`                              | title       |
| Issue Key         | `identifier` (for example, ENG-123)  | richText    |
| Status            | workspace-specific `state.name`      | select      |
| Priority          | `priorityLabel` or `priority`        | select      |
| Assignee          | `assignee.displayName` or `name`     | richText    |
| Issue Link        | `url`                                | url         |
| Updated           | `updatedAt`                          | date        |
| Workflow Category | canonical category from `state.type` | select      |
| Team              | `team.name` or `team.key`            | select      |
| Project           | `project.name`                       | select      |
| Cycle             | `cycle.name` or cycle number         | select      |
| Labels            | all `labels.nodes[].name`            | multiSelect |
| Estimate          | `estimate`                           | number      |
| Due Date          | `dueDate`                            | date        |
| Started           | `startedAt`                          | date        |
| Completed         | `completedAt`                        | date        |
| Canceled          | `canceledAt`                         | date        |
| Created           | `createdAt`                          | date        |
| Archived          | whether `archivedAt` is set          | checkbox    |
| Linear Issue ID   | `id`                                 | richText    |

Each issue page body contains its Markdown `description`. Workspace-specific
workflow names remain visible in **Status**, while **Workflow Category** makes
cross-team reporting consistent. Labels are paginated rather than silently
stopping at the first nested page.

**Linear Issue ID**, the immutable UUID, is the primary key. The familiar
**Issue Key** stays prominent, but it can change when an issue moves between
teams, so it is not safe as a sync key.

#### Linear Initiatives

| Notion property      | Linear field                  | Type     |
| -------------------- | ----------------------------- | -------- |
| Name                 | `name`                        | title    |
| Status               | `status`                      | select   |
| Health               | `health`                      | select   |
| Owner                | `owner.displayName` or `name` | richText |
| Initiative Link      | `url`                         | url      |
| Project Count        | all contributing `projects`   | number   |
| Target Date          | `targetDate`                  | date     |
| Last Update At       | `lastUpdate.updatedAt`        | date     |
| Last Update Link     | `lastUpdate.url`              | url      |
| Updated              | `updatedAt`                   | date     |
| Started              | `startedAt`                   | date     |
| Completed            | `completedAt`                 | date     |
| Created              | `createdAt`                   | date     |
| Archived             | whether `archivedAt` is set   | checkbox |
| Slug ID              | `slugId`                      | richText |
| Linear Initiative ID | `id`                          | richText |

Each initiative page body starts with its latest update narrative and then
lists the projects contributing directly or through sub-initiatives, followed
by the Initiative overview. **Project Count** is exact for projects visible to
the API key and includes inherited and archived projects. The body renders up
to 100 alphabetized project links and directs readers to Linear when more
exist. Archived projects are annotated, while trashed projects are excluded.

**Linear Initiative ID**, the immutable UUID, is the primary key, while
**Slug ID** is retained as the readable identifier.

Latest-update and overview source-text excerpts are each limited to 20,000
characters. When text is shortened, the page shows an explicit link to its
complete version in Linear rather than truncating silently.

Initiatives are also subject to the authenticated user's Linear plan and
permissions. If the API reports that the feature is unavailable, the
initiative sync fails visibly instead of silently replacing the database with
an empty snapshot. Initiatives must be enabled, and a guest user's key may not
be able to read them.

### Project structure

```text
src/
├── index.ts       — registers three managed databases and four syncs
├── linear.ts      — GraphQL client, cursor pagination, and rate-limit handling
├── sync-state.ts  — serializable cursor and incremental-window transitions
├── projects.ts    — project schema and transform
├── issues.ts      — issue schema and transform
├── initiatives.ts — initiative schema and transform
└── helpers.ts     — shared labels, people, dates, and content helpers
```

### How it works

1. **Projects** use a cursor-paginated replacement sweep every 15 minutes,
   ordered by stable `createdAt` rather than a value that changes mid-sweep.
2. **Issues** use an `updatedAt` filter and cursor every 5 minutes. Each run
   pins an upper time boundary for every page, leaves a short consistency
   buffer for Linear's indexes, and overlaps the previous watermark. Replaying
   a small interval is safe because upserts are keyed by UUID; the overlap
   protects against equal timestamps, indexing lag, and writes at a page
   boundary.
3. **Issue reconciliation** performs a complete daily replacement sweep in
   stable `createdAt` order. The replacement run compares the complete key set
   and removes hard-deleted issues that incremental polling cannot discover.
4. **Initiatives** use a cursor-paginated replacement sweep every hour in
   stable `createdAt` order. Their rows intentionally refresh each sweep
   because contributing-project membership is derived data without a safe
   monotonic timestamp for removals.
5. All top-level collections use Linear's Relay-style GraphQL pagination with
   `after`, `pageInfo.hasNextPage`, and `pageInfo.endCursor`. Projects and
   Issues request 50 records per page; Initiatives request 20 to leave
   headroom in Linear's query-complexity budget for their nested project
   summaries. The client rejects a missing cursor, and persisted cursor
   history detects both immediate repeats and longer cursor cycles instead of
   looping forever.
6. Issue labels are a nested connection. The first 50 arrive with the issue;
   only issues with more labels make follow-up GraphQL requests. Those pages
   share the same pacing and cursor safeguards, and duplicate label names are
   removed. A top-level issue page may make at most 20 label follow-up requests;
   exceeding the bound fails the page instead of committing truncated labels.
7. Initiative projects are also independently cursor-paginated, including
   projects inherited through sub-initiatives. Their shared 20-request bound
   fails the Initiative page instead of returning a false count or incomplete
   project list.

All list queries pass `includeArchived: true`. Archived resources therefore
remain available for history and are marked with the **Archived** checkbox.
If Linear returns a recently deleted issue with `trashed: true`, the
incremental sync emits an explicit delete. Linear does not document
`includeArchived` as including trash, so prompt soft-delete delivery is not
assumed. Replacement syncs exclude any trashed records they do receive, and
the daily issue reconciliation is the guaranteed repair path once a deleted
issue no longer appears in the full collection.

#### Suggested Notion views

- **Active projects:** filter Archived off and Status Category to Backlog,
  Planned, Started, or Paused; sort by Health and Target Date.
- **Team issue tracker:** filter Archived off, then group by Team and Workflow
  Category. Add a Cycle filter for a current-cycle view.
- **Unassigned work:** filter Assignee empty and Workflow Category not Completed
  or Canceled; sort by Priority.
- **Leadership initiatives:** filter Archived off, group by Health, and sort by
  Target Date. Use Project Count to find strategic goals with no associated
  projects visible to the API key.
- **History:** filter Archived on in any database rather than mixing historical
  records into its default active view.

#### Rate limits and query complexity

Every GraphQL request from all four syncs, including follow-up label and
Initiative-project pages, shares one pacer set to **2,000 requests per hour**.
Linear's current API-key request-limit table lists 2,500 requests per
authenticated user per hour, so the pacer leaves meaningful headroom for
incidental traffic. Multiple keys belonging to the same user share that quota.

Linear also applies a separate hourly query-complexity budget and rejects an
individual query above its maximum complexity. The example requests only the
fields it maps, uses explicit 20- or 50-record connection limits, and paginates
nested labels and Initiative projects separately. This keeps connection
multiplication predictable instead of hiding a large nested query in one
request.

The client treats both HTTP 429 responses and GraphQL `RATELIMITED` errors as
rate limits. It reads `Retry-After` and Linear's request, endpoint, and
complexity reset headers, then passes the longest applicable delay to the
Workers runtime. It also rejects GraphQL partial responses so missing fields
cannot silently become incomplete Notion pages.

### Linear access and credentials

The key's Linear visibility defines what the worker can copy.

#### Getting a Linear personal API key

1. Open Linear and go to **Settings > Security & access > API keys**.
2. Create a new personal API key, give it a recognizable label, and copy it.
3. Store it as `LINEAR_API_KEY`; Linear only shows the secret when it is
   created.

The worker sends this value directly in Linear's `Authorization` header, as
required for personal API keys. Do not add a `Bearer` prefix. You do not need
to build authentication headers or provide a `NOTION_API_TOKEN`; the worker
handles Linear authorization and the Workers platform handles Notion
credentials.

### Configuration reference

#### Required

| Variable         | Description                                                |
| ---------------- | ---------------------------------------------------------- |
| `LINEAR_API_KEY` | Personal API key with access to the resources being synced |

For local execution, copy `.env.example` to `.env` and add your key. `.env` is
gitignored and must not be committed.

### Local verification

Run all offline tests without a Linear connection:

```sh
npm test
```

Run a sync locally against the Linear workspace accessible to the key in your
`.env` file:

```sh
ntn workers exec projectsSync --local
ntn workers exec issuesSync --local
ntn workers exec issuesReconciliationSync --local
ntn workers exec initiativesSync --local
```

Use `--preview` when triggering a deployed sync whose returned fields you want
to inspect before writing to Notion.

### Operational notes

Linear recommends webhooks instead of polling for production integrations that
can receive events. Workers syncs currently use scheduled execution, so this
example combines a five-minute incremental poll with daily reconciliation. A
webhook-capable deployment can retain the reconciliation sweep as a repair path.

Linear-hosted images embedded in Markdown may require Linear authentication;
Notion readers who are not signed into Linear may not be able to render them.

### Adapting the schema

Each resource file contains both its managed-database schema and transform:

| Resource    | File                 |
| ----------- | -------------------- |
| Projects    | `src/projects.ts`    |
| Issues      | `src/issues.ts`      |
| Initiatives | `src/initiatives.ts` |

To add a Linear field:

1. Add it to the resource's GraphQL selection and TypeScript type in
   `src/linear.ts`.
2. Add a property with the appropriate `Schema.*` type in the resource file.
3. Add the matching `Builder.*` value in the resource transform, preserving
   schema order.
4. Add standard, minimal, and relevant edge-case assertions to `test.ts`.

Keep the immutable UUID property as each database's primary key. Add related
resources as resolved names unless you intentionally design and validate a
cross-database relation lifecycle.

## Learn more

- [Notion Workers documentation](https://developers.notion.com/docs/workers)
- [Linear GraphQL API — Getting started](https://linear.app/developers/graphql)
- [Linear GraphQL API — Pagination](https://linear.app/developers/pagination)
- [Linear GraphQL API — Filtering](https://linear.app/developers/filtering)
- [Linear GraphQL API — Rate limiting](https://linear.app/developers/rate-limiting)
- [Linear documentation — Delete and archive issues](https://linear.app/docs/delete-archive-issues)
- [Linear documentation — Initiatives](https://linear.app/docs/initiatives)
- [Linear documentation — Initiative and Project updates](https://linear.app/docs/initiative-and-project-updates)
- [Linear documentation — Sub-initiatives](https://linear.app/docs/sub-initiatives)
- [Contributing guide](../../CONTRIBUTING.md)
