# Worker sync: Sentry

Bring Sentry issue triage, project trends, and release health into Notion. The
worker maintains three databases automatically: issues and releases refresh
every 15 minutes, and projects refresh daily. Use them to coordinate reliability
work without sending every collaborator into Sentry.

## Quickstart

You need Node.js 22+, a Sentry organization, and an
[internal integration token](#create-a-sentry-token) with `event:read`,
`org:read`, and `project:releases`.

From the repository root:

```sh
npm install --global ntn
cd workers/sentry-sync
npm install
ntn login
ntn workers deploy --name sentry-sync
ntn workers env set \
  SENTRY_AUTH_TOKEN=your-token \
  SENTRY_ORG_SLUG=your-organization-slug \
  SENTRY_PROJECTS=checkout-api \
  SENTRY_ENVIRONMENTS=production
```

Schedules run automatically, without recurring CLI commands. To populate them
immediately:

```sh
ntn workers sync trigger issuesSync
ntn workers sync trigger projectsSync
ntn workers sync trigger releasesSync
```

The worker copies issue-group, project, and release metadata plus aggregate
sessions—not raw events or stack traces. Review the databases' Notion sharing
settings before syncing production data broadly. Sentry remains the system of
record; changes in Notion never update it.

## What you can answer

| Managed database    | Questions it helps answer                                                                                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sentry Issues**   | What should we triage first among new, regressed, escalating, high-priority, and unhandled issues? Which unassigned issues have the most 24-hour events or 30-day affected users?                                             |
| **Sentry Projects** | Which services have the largest unresolved or high-priority backlog, and what is each service's most active issue? Where is seven-day event volume rising, and which projects lack team ownership or session instrumentation? |
| **Sentry Releases** | Which recent releases need investigation because crash-free session or user rates are low, new issues appeared, or health data is missing? Which rollouts have enough seven-day sessions and users to assess confidently?     |

## Reference

### Synced databases and schedules

| Database            | Sentry resource                    | Schedule     |
| ------------------- | ---------------------------------- | ------------ |
| **Sentry Issues**   | Issue groups seen in prior 30 days | Every 15 min |
| **Sentry Projects** | Projects + issue-derived summaries | Every day    |
| **Sentry Releases** | Newest 100 releases + health       | Every 15 min |

#### Sentry Issues

| Notion property | Sentry field or meaning                | Type     |
| --------------- | -------------------------------------- | -------- |
| Issue           | `title`                                | title    |
| Status          | `status`                               | select   |
| Status Detail   | `substatus`                            | select   |
| Priority        | `priority`                             | select   |
| Level           | `level`                                | select   |
| Assignee        | `assignedTo.name`                      | richText |
| Unhandled       | `isUnhandled`                          | checkbox |
| Events (24h)    | Sum of 24-hour statistics              | number   |
| Events (30d)    | 30-day query-window `count`            | number   |
| Users (30d)     | 30-day query-window `userCount`        | number   |
| Lifetime Events | `lifetime.count`                       | number   |
| Lifetime Users  | `lifetime.userCount`                   | number   |
| Project         | Project name or slug                   | select   |
| Category        | `issueCategory`                        | select   |
| Issue Type      | `issueType`                            | select   |
| Platform        | Issue or project `platform`            | select   |
| Culprit         | `culprit`                              | richText |
| First Seen      | `firstSeen`                            | date     |
| Last Seen       | `lastSeen`                             | date     |
| Issue Key       | `shortId`                              | richText |
| Issue Link      | `permalink`                            | url      |
| Sentry Issue ID | Immutable `id`; the Notion primary key | richText |

The pinned 30-day query includes all statuses. Page bodies are bounded triage
snapshots; missing nullable values are cleared after a complete refresh.

#### Sentry Projects

| Notion property                | Sentry field or meaning                              | Type        |
| ------------------------------ | ---------------------------------------------------- | ----------- |
| Project                        | Project `name`                                       | title       |
| Unresolved Issues (30d)        | Scoped unresolved issue count                        | number      |
| High-Priority Unresolved (30d) | Scoped high-priority unresolved count                | number      |
| New Unresolved (30d)           | Scoped new unresolved count                          | number      |
| Regressed Unresolved (30d)     | Scoped regressed unresolved count                    | number      |
| Escalating Unresolved (30d)    | Scoped escalating unresolved count                   | number      |
| Unhandled Unresolved (30d)     | Scoped unhandled unresolved count                    | number      |
| Unassigned Unresolved (30d)    | Scoped unassigned unresolved count                   | number      |
| Events (7d)                    | Current seven-day issue-stat bucket                  | number      |
| Previous 7d Events             | Previous seven-day issue-stat bucket                 | number      |
| Event Change vs Prior 7d       | Difference between the two buckets                   | number      |
| Issue Groups (30d)             | Scoped issue-group count                             | number      |
| Events (30d)                   | Scoped event count                                   | number      |
| Most Active Issue (7d)         | Issue with the highest current seven-day event count | richText    |
| Issue Link                     | Link to the most active issue                        | url         |
| Project Link                   | Direct Sentry project link                           | url         |
| Last Seen                      | Latest scoped issue activity                         | date        |
| Platform                       | Project or issue platform                            | select      |
| Teams                          | Project teams                                        | multiSelect |
| Has Sessions                   | Project session instrumentation                      | checkbox    |
| First Event                    | Project `firstEvent`                                 | date        |
| Environment Scope              | Configured environments                              | richText    |
| As Of                          | Summary snapshot time                                | date        |
| Project Slug                   | Project `slug`                                       | richText    |
| Sentry Project ID              | Immutable `id`; the Notion primary key               | richText    |

The daily sync joins visible projects to a scoped 30-day issue scan. Projects
without recent issues show zeroes; incomplete statistics leave trend or event
totals empty. User totals are omitted to avoid cross-group double counting.

#### Sentry Releases

| Notion property      | Sentry field or meaning                         | Type             |
| -------------------- | ----------------------------------------------- | ---------------- |
| Release              | `shortVersion` or `version`                     | title            |
| Projects             | Release project metadata                        | multiSelect      |
| Crash-Free Users     | Seven-day Release Health rate                   | number (percent) |
| Crash-Free Sessions  | Seven-day Release Health rate                   | number (percent) |
| New Issues           | Organization-release total                      | number           |
| Status               | `status`                                        | select           |
| Sessions (7d)        | Scoped Release Health sessions                  | number           |
| Users (7d)           | Scoped Release Health users                     | number           |
| Sentry Link          | Direct Sentry release link                      | url              |
| Released At          | `dateReleased`                                  | date             |
| Created At           | `dateCreated`                                   | date             |
| Health Data (7d)     | Whether Sentry returned a matching health group | checkbox         |
| Release URL          | Provider-supplied external URL                  | url              |
| First Event          | `firstEvent`                                    | date             |
| Last Event           | `lastEvent`                                     | date             |
| Deploys              | Organization-release deploy count               | number           |
| Commits              | Organization-release commit count               | number           |
| Platforms            | Release platform metadata                       | multiSelect      |
| Version              | Full release `version`                          | richText         |
| Reference            | `ref`                                           | richText         |
| Window Start         | Release Health window start                     | date             |
| Window End           | Release Health window end                       | date             |
| Health Project Scope | Configured projects                             | richText         |
| Environment Scope    | Configured environments                         | richText         |
| Sentry Release ID    | Immutable `id`; the Notion primary key          | richText         |

The database contains the newest 100 organization releases in scope. Health is
a separate scoped seven-day aggregate; other metadata remains organization
level. Missing health stays empty, while explicit zeroes remain zero.

### Project structure

```text
src/
├── index.ts      — databases, schedules, and sync phases
├── sentry.ts     — REST client, response validation, and pagination
├── sync-state.ts — pinned windows and continuation safety
├── issues.ts     — issue schema and triage transform
├── projects.ts   — project schema and issue aggregation
├── releases.ts   — release schema and aggregate health merge
└── helpers.ts    — bounded values, statistics, and summaries
```

### How it works

1. Every 15 minutes, issues scans all statuses in a pinned 30-day window and
   follows pagination to completion.
2. Daily, projects aggregates current and prior seven-day events, then enriches
   the inventory. Recent issue data for an inaccessible project is retained.
3. Every 15 minutes, releases fetches the newest 100 releases and one aggregate
   seven-day health response, with no per-release requests.
4. Filters remain fixed for a complete refresh; changes apply next cycle.
5. Immutable IDs update rows. Complete replacement removes records that leave
   the defined membership and clears properties that disappear upstream.

### Sentry access and credentials

#### Create a Sentry token

Create an organization-owned internal integration for a deployed worker:

1. Open **Organization Settings > Developer Settings > Internal
   Integrations**.
2. Create an integration dedicated to this worker.
3. Grant `event:read`, `org:read`, and `project:releases`.
4. Store the token with `ntn workers env set`.

“Internal integration” is Sentry's credential name. `project:read` also permits
release listing, but `project:releases` is narrower. A personal test token
follows that user's access and lifecycle.

### Configuration reference

| Variable              | Required | Description                                                                           |
| --------------------- | -------- | ------------------------------------------------------------------------------------- |
| `SENTRY_AUTH_TOKEN`   | Yes      | Token with `event:read`, `org:read`, and `project:releases`                           |
| `SENTRY_ORG_SLUG`     | Yes      | Organization slug from the Sentry URL                                                 |
| `SENTRY_PROJECTS`     | No       | Comma-separated project IDs or slugs; scopes every database                           |
| `SENTRY_ENVIRONMENTS` | No       | Comma-separated environments; scopes issues, project aggregates, releases, and health |
| `SENTRY_BASE_URL`     | No       | Self-hosted Sentry root; defaults to `https://sentry.io` and must omit `/api/0`       |

No `NOTION_API_TOKEN` is needed. Self-hosted Sentry must use HTTPS, except for a
loopback development server, and its root must not include `/api/0`.

Large organizations should start with `SENTRY_PROJECTS` or
`SENTRY_ENVIRONMENTS`. Project summaries support up to 500 active projects;
Release Health supports one page of fewer than 250 groups.

### Adapting the schema

Schemas and transforms live in `src/issues.ts`, `src/projects.ts`, and
`src/releases.ts`. To add a field:

1. Add the narrow response type and runtime parser in `src/sentry.ts`.
2. Add the property to the resource schema and transform.
3. Emit the empty property value when nullable upstream data disappears.
4. Update this README and add transform tests.

### Local testing

Run the offline checks; mocked requests need no Sentry credentials:

```sh
npm run check
npm test
npm run build
```

For a live read-only preview, copy `.env.example` to `.env`, add a small scope,
and run:

```sh
ntn workers sync trigger issuesSync --local --preview
```

Substitute `projectsSync` or `releasesSync` to preview the other databases.

## Learn more

- [Sentry issues API](https://docs.sentry.io/api/events/list-an-organizations-issues/)
- [Sentry projects API](https://docs.sentry.io/api/organizations/list-an-organizations-projects/)
- [Sentry releases API](https://docs.sentry.io/api/releases/list-an-organizations-releases/)
- [Sentry Release Health API](https://docs.sentry.io/api/releases/retrieve-release-health-session-statistics/)
- [Sentry authentication and permissions](https://docs.sentry.io/api/auth/)
- [Sentry pagination](https://docs.sentry.io/api/pagination/)
- [Sentry rate limits](https://docs.sentry.io/api/ratelimits/)
- [Notion Workers documentation](https://developers.notion.com/workers/get-started/overview)
- [Contributing guide](../../CONTRIBUTING.md)
