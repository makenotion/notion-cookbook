# Worker sync: Sentry

Bring Sentry's operational signals into Notion so engineering, product, and
support can coordinate reliability work without turning Notion into another
error console. Out of the box, this Worker helps teams see what is breaking,
which services carry the most unresolved risk, whether ownership gaps are
growing, and how the newest releases are behaving.

The example creates three complementary databases by default:

- **Sentry Issues** keeps a rolling triage view current every 15 minutes.
- **Sentry Projects** adds a daily service-level reliability summary to the
  complete project inventory.
- **Sentry Releases** combines the 100 newest releases with seven-day rollout
  health every 15 minutes.

All three are registered intentionally. It is easier to remove a database and
its sync from a fork than to discover and wire up a valuable view later. There
are no hidden enable flags, relations, invented health scores, or raw-event
copies.

## Quickstart

You need Node.js 22+, a Sentry organization, and an
[internal integration token](#create-a-sentry-token) with `event:read`,
`org:read`, and `project:releases`. From the repository root:

```sh
npm install --global ntn
cd workers/sentry-sync
npm install
ntn login
ntn workers deploy --name sentry-sync
ntn workers env set SENTRY_AUTH_TOKEN=your-token
ntn workers env set SENTRY_ORG_SLUG=your-organization-slug
```

For the first run, scope to one or two production projects. Replace the example
slug with a Sentry project ID or slug:

```sh
ntn workers env set SENTRY_PROJECTS=checkout-api
ntn workers env set SENTRY_ENVIRONMENTS=production
```

Create and populate all three databases while streaming each run:

```sh
ntn workers exec issuesSync --stream
ntn workers exec projectsSync --stream
ntn workers exec releasesSync --stream
```

## What you can answer

| Question                                                      | Signals to use                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| What is breaking now?                                         | Issue status, priority, 24-hour events, 30-day users                    |
| What is new, regressed, escalating, or unowned?               | Status detail, assignee, unhandled, last seen                           |
| Which services carry the most current reliability burden?     | Unresolved issues, seven-day events, high-priority and lifecycle counts |
| Is service activity rising compared with the prior week?      | Events (7d), Previous 7d Events, Event Change vs Prior 7d               |
| Where are ownership and instrumentation gaps concentrated?    | Unassigned Unresolved (30d), Teams, Has Sessions                        |
| Are the newest rollouts stable and broadly exercised?         | Crash-Free Sessions, Crash-Free Users, Sessions (7d), Users (7d)        |
| Which releases introduced new issue groups or lack telemetry? | New Issues, Health Data (7d), First Event, Last Event                   |

These are coordination views. Sentry remains the system of record for event
details, investigation, alerting, and mutations.

## Reference

### Databases and schedules

| Database            | Sync           | Mode    | Schedule     | Membership                                               |
| ------------------- | -------------- | ------- | ------------ | -------------------------------------------------------- |
| **Sentry Issues**   | `issuesSync`   | replace | Every 15 min | Every issue status seen in the pinned prior 30 days      |
| **Sentry Projects** | `projectsSync` | replace | Daily        | Visible projects, enriched from the pinned prior 30 days |
| **Sentry Releases** | `releasesSync` | replace | Every 15 min | The 100 most recent releases across the configured scope |

`replace` means complete reconciliation. The Worker updates stable rows and
removes rows absent from a completed refresh; it does not delete and recreate
the database. A failed or partial multi-page refresh is not treated as a
complete snapshot.

### Issue fields

| Notion property | Sentry issue-group field               |
| --------------- | -------------------------------------- |
| Issue           | `title`                                |
| Status          | `status`                               |
| Assignee        | `assignedTo.name`                      |
| Issue Link      | `permalink`                            |
| Last Seen       | `lastSeen`                             |
| Priority        | `priority`                             |
| Status Detail   | `substatus`                            |
| Level           | `level`                                |
| Unhandled       | `isUnhandled`                          |
| Events (24h)    | sum of `stats["24h"]`                  |
| Events (30d)    | query-window `count`                   |
| Users (30d)     | query-window `userCount`               |
| Lifetime Events | `lifetime.count`                       |
| Lifetime Users  | `lifetime.userCount`                   |
| Project         | `project.name` or `project.slug`       |
| Category        | `issueCategory`                        |
| Issue Type      | `issueType`                            |
| Platform        | issue or project `platform`            |
| Culprit         | `culprit`                              |
| First Seen      | `firstSeen`                            |
| Issue Key       | `shortId` (for example, `CHECKOUT-42`) |
| Sentry Issue ID | immutable `id`                         |

The immutable Sentry issue ID is the primary key. Each page body contains a
short, bounded triage snapshot assembled from these same group-level fields.

### Project fields

The project database combines Sentry's project inventory with aggregates from
the complete issue scan. It includes:

- unresolved, high-priority, new, regressed, escalating, unhandled, and
  unassigned issue-group counts;
- event volume in the current and previous seven-day windows, with the exact
  change rather than a subjective score;
- 30-day issue-group and event totals;
- the most active issue in the current seven-day window and its source link;
- last activity, team, platform, session-instrumentation, and first-event
  context;
- the environment scope used for every issue-derived aggregate.

The immutable project ID is the primary key. A project with no issue activity
in the 30-day window still appears with zero issue counts. If any returned
issue lacks 14-day statistics, the project row omits its seven-day totals and
top issue rather than publishing an understated result. The same rule applies
to an incomplete 30-day event count.

There is deliberately no project-level affected-users total: one person can
appear in several issue groups, so summing `userCount` would double-count them.

### Release fields

Each release row represents one Sentry organization release, keyed by its
immutable release ID. The newest 100 releases contribute status, projects,
dates, new issue groups, deploy and commit counts, platforms, version, a direct
Sentry link, and the provider-supplied external release URL. One aggregate
Release Health query adds:

- crash-free session and user rates;
- sessions and unique users in the returned seven-day window;
- the exact rounded window Sentry evaluated;
- the configured project and environment scope used for health.

Sentry reports crash-free rates as percentage points; the transform converts
them to Notion's percent-property representation without changing their
meaning. A release without session telemetry still gets a metadata row.
Absent health values remain absent—never `0`, `100%`, or an invented “Healthy”
status. Explicit zeroes from Sentry remain zero.

`New Issues`, deploys, and commits remain organization-release values. Projects
lists every project Sentry associates with the release, while health metrics
are aggregated only over the explicit **Health Project Scope** and
**Environment Scope**. Keeping both scopes visible prevents a shared release
from implying that scoped health covers every listed project. The base example
avoids duplicated rows with misleading per-project copies of release-level
metrics.

## Suggested Notion views

- **Active triage:** Status is Unresolved; sort by Priority, Events (24h), and
  Users (30d).
- **New and regressed:** Status Detail is New, Regressed, or Escalating; sort
  by Last Seen descending.
- **Needs an owner:** Status is Unresolved and Assignee is empty; sort by
  Unhandled, Priority, and Events (24h).
- **Services needing attention:** sort projects by Unresolved Issues (30d),
  Events (7d), Event Change vs Prior 7d, and Unassigned Unresolved (30d).
- **Regression concentration:** sort projects by Regressed Unresolved (30d)
  and High-Priority Unresolved (30d); group by Team or Platform.
- **Rollout watch:** sort releases by Released At descending, then Crash-Free
  Sessions and Sessions (7d).
- **Missing release telemetry:** filter Health Data (7d) unchecked. Empty means
  the sessions endpoint was unavailable on that Sentry installation.

## How it works

### Rolling issue triage

The Worker calls Sentry's current organization issue-search endpoint with an
explicit empty `query=`. Sentry otherwise defaults the endpoint to unresolved
issues, while this example needs recently active resolved and ignored groups
for review as well. The first page pins an exact 30-day `start` and `end`, base
URL, organization, filters, and a non-secret credential fingerprint.

Every page requests 100 groups and 24-hour group statistics. Sentry's `Link`
header is authoritative: the Worker continues only when the one trusted
`rel="next"` entry declares `results="true"`. Missing or malformed links,
untrusted origins/paths, duplicate next links, and cursor cycles fail closed.

### Service-level reliability

The daily project refresh has two phases:

1. Scan the same pinned 30-day issue scope with 14-day statistics and keep only
   compact per-project counters in serializable state.
2. Page through the organization project inventory and enrich each project
   with those aggregates.

Configured project IDs or slugs are applied to issue search and locally to the
project inventory; configured environments scope the issue-derived signals.
Projects with no matching issues still appear. An issue aggregate whose
project was deleted or became inaccessible is retained using the issue's
project metadata so risk does not disappear silently.

The state is capped at 500 active projects. Larger organizations should set
`SENTRY_PROJECTS`; crossing the boundary fails with an actionable error rather
than truncating the snapshot.

### Recent rollout health

The release refresh deliberately requests only the first 100 releases from the
endpoint's most-recent-first default order, so this is an explicit useful set
rather than accidental pagination truncation. Project and environment filters
scope both release membership and health. An explicit empty `status=` includes
recently archived releases instead of Sentry's default open-only set.

One additional sessions request groups the prior seven days by release across
the configured project and environment scope, requests totals without
time-series payloads, and orders by session volume. This avoids per-release
detail calls. The Worker requests at most 250 groups and fails if Sentry reaches
that boundary, because treating a potentially capped result as complete could
remove valid rows or omit health. With four fields and seven daily buckets,
that conservative request also remains below Sentry's documented
10,000-data-point constraint even if the service computes series before
omitting them from the response.

An empty health result is valid and leaves metrics absent. A 404 from the
sessions endpoint on an older self-hosted installation also preserves release
metadata. Authentication, authorization, malformed data, timeouts, 429s, and
other API errors remain visible failures.

### Rate limits and request safety

All three syncs share a conservative 60-request-per-minute pacer. Sentry uses
caller- and endpoint-specific quotas instead of publishing one universal
limit. On HTTP 429, the Worker passes usable `Retry-After` and
`X-Sentry-Rate-Limit-Reset` delays to the Workers runtime.

Requests have a 30-second timeout, reject redirects, and send the bearer token
only to a validated HTTPS base URL. Loopback HTTP is allowed for local testing.
The token fingerprint prevents a multi-page refresh from continuing under a
rotated credential with different access.

## Sentry access and configuration

### Create a Sentry token

Prefer an organization **internal integration** for a deployed Worker:

1. Open **Organization Settings > Developer Settings > Internal
   Integrations**.
2. Create an integration dedicated to this Worker.
3. Grant `event:read` for issue groups, `org:read` for projects and aggregate
   Release Health, and `project:releases` for release metadata.
4. Store the token only with `ntn workers env set`.

A broader `project:read` permission also authorizes release listing, but
`project:releases` is the narrower purpose-specific choice. A personal token is
convenient for testing but follows that user's access and lifecycle.

### Environment variables

| Variable              | Required | Description                                                                          |
| --------------------- | -------- | ------------------------------------------------------------------------------------ |
| `SENTRY_AUTH_TOKEN`   | Yes      | Bearer token with `event:read`, `org:read`, and `project:releases`                   |
| `SENTRY_ORG_SLUG`     | Yes      | Organization slug from the Sentry URL                                                |
| `SENTRY_PROJECTS`     | No       | Comma-separated project IDs or slugs; scopes issues, projects, releases, and health  |
| `SENTRY_ENVIRONMENTS` | No       | Comma-separated environments; scopes issues, project aggregates, and release health  |
| `SENTRY_BASE_URL`     | No       | HTTPS root for self-hosted Sentry; defaults to `https://sentry.io`, without API path |

For self-hosted Sentry:

```sh
ntn workers env set SENTRY_BASE_URL=https://sentry.example.com
```

Self-hosted versions can lag Sentry SaaS. Optional fields and unknown future
enum values are tolerated; missing identity, pagination, and completeness
contracts fail visibly.

## Privacy and operational boundaries

The Worker requests issue-group metadata, project metadata, release metadata,
and aggregate session totals. It does not request raw events, stack traces,
breadcrumbs, request bodies, headers, query strings, tags, attachments, event
users, IP addresses, or event contexts. Sentry's standard release response can
contain owners, release authors, and commit-author metadata; the parser
discards those fields immediately and never persists them in Notion or sync
state. The issue parser retains an assignee display name but likewise discards
email and other unselected response fields.

Issue titles, culprits, project names, and release versions can still contain
customer, code, or infrastructure details. Review Sentry's data-scrubbing
settings and the Notion databases' sharing permissions before syncing
production data broadly.

This is a one-way mirror. Changes in Notion do not update Sentry.

## Project structure

```text
src/
├── index.ts      — registers all databases, schedules, phases, and shared pacer
├── sentry.ts     — minimal REST client, strict parsing, pagination, and limits
├── sync-state.ts — pinned issue windows and reusable cursor-loop safeguards
├── issues.ts     — issue schema and triage transform
├── projects.ts   — project schema and truthful issue aggregation
├── releases.ts   — release schema and aggregate health merge
└── helpers.ts    — bounded labels, safe values, statistics, and summaries
```

## Local validation

All tests are offline and mock `fetch`; they do not need a Sentry token:

```sh
cd workers/sentry-sync
npm install
npm run check
npm test
npm run build
```

For live verification without writing to Notion, copy `.env.example` to `.env`,
add credentials for a small test project, and run:

```sh
ntn workers exec issuesSync --local --stream
ntn workers exec projectsSync --local --stream
ntn workers exec releasesSync --local --stream
```

Confirm that recently active resolved and unresolved issues appear; project
totals match the scoped issue set; current/prior seven-day buckets line up with
Sentry; newest releases remain one row each with project context; and missing
Release Health leaves fields absent rather than creating false zeroes.

## Customizing the default set

To remove a view from a fork, delete its `worker.database(...)` and
`worker.sync(...)` blocks from `src/index.ts`, then remove its schema module if
unused. No environment flag is required.

When adding fields, retain only the selected provider shape, validate identity
and null semantics, preserve schema/transform property order, and add complete,
missing, zero, future-value, privacy, and pagination tests. Keep raw event data
out of this base example. A webhook-driven fork can improve issue freshness
while the full refresh remains reconciliation.

## Official documentation

- [List an organization's issues](https://docs.sentry.io/api/events/list-an-organizations-issues/)
- [List an organization's projects](https://docs.sentry.io/api/organizations/list-an-organizations-projects/)
- [List an organization's releases](https://docs.sentry.io/api/releases/list-an-organizations-releases/)
- [Retrieve Release Health session statistics](https://docs.sentry.io/api/releases/retrieve-release-health-session-statistics/)
- [Sentry pagination](https://docs.sentry.io/api/pagination/)
- [Sentry rate limits](https://docs.sentry.io/api/ratelimits/)
- [Sentry authentication and permissions](https://docs.sentry.io/api/auth/)
- [Sentry data scrubbing](https://docs.sentry.io/security-legal-pii/scrubbing/)
- [Notion Workers](https://developers.notion.com/docs/workers)
