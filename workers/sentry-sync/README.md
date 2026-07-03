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
ntn workers env set \
  SENTRY_AUTH_TOKEN=your-token \
  SENTRY_ORG_SLUG=your-organization-slug \
  SENTRY_PROJECTS=checkout-api \
  SENTRY_ENVIRONMENTS=production
```

Apply the credentials and initial scope together before the first run so they
are not saved as separate partial environment updates. Start with one or two
production projects; replace `checkout-api` with a comma-separated list of
Sentry project IDs or slugs.

Create and populate all three databases:

```sh
ntn workers sync trigger issuesSync
ntn workers sync trigger projectsSync
ntn workers sync trigger releasesSync
```

After all three commands complete, the workspace contains managed databases
named **Sentry Issues**, **Sentry Projects**, and **Sentry Releases**, populated
with any records matching the configured scope. Subsequent runs update those
databases on the schedules below.

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

| Database            | Sync           | Mode    | Schedule     | Membership                                                    |
| ------------------- | -------------- | ------- | ------------ | ------------------------------------------------------------- |
| **Sentry Issues**   | `issuesSync`   | replace | Every 15 min | Every issue status seen in the pinned prior 30 days           |
| **Sentry Projects** | `projectsSync` | replace | Daily        | Visible projects, enriched from the pinned prior 30 days      |
| **Sentry Releases** | `releasesSync` | replace | Every 15 min | The first 100 rows returned by the configured release request |

`replace` means complete reconciliation. The Worker updates stable rows and
removes rows absent from a completed refresh; it does not delete and recreate
the database. A failed or partial multi-page refresh is not treated as a
complete snapshot. Every returned row also emits explicit empty property values
when a Sentry field disappears, so an earlier value cannot remain stale.

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
issue lacks 14-day statistics, the project row clears its seven-day totals and
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
Absent health values remain empty—never stale, `0`, `100%`, or an invented
“Healthy” status. Explicit zeroes from Sentry remain zero.

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
  a successful Sentry response returned no matching health row or no session
  telemetry exists for that release and scope.

## How it works

### Contract boundary

All provider calls use the four public Sentry REST endpoints linked below and
only parameters documented for those endpoints. The example does not use
Sentry alpha, early-access, internal, or undocumented APIs. Sentry's `/api/0`
path is its documented public REST namespace, not an API maturity label.

On the Notion side, the example imports only public exports documented for
`@notionhq/workers`; it does not import SDK internals. The current Notion CLI
labels Workers as Beta, which is a platform-level constraint shared by Worker
examples rather than a hidden dependency of this integration. The conservative
continuation-state budget and explicit property clearing reflect current
Workers runtime behavior and should be revalidated when upgrading the Beta SDK.

### Rolling issue triage

The Worker calls Sentry's current organization issue-search endpoint with an
explicit empty `query=`. Sentry otherwise defaults the endpoint to unresolved
issues, while this example needs recently active resolved and ignored groups
for review as well. The first page pins an exact 30-day `start` and `end`, base
URL, organization, and filters. Each request reads the currently configured
token so routine rotation cannot strand an in-progress refresh.

Every page requests 100 groups and 24-hour group statistics. Sentry's `Link`
header is authoritative: the Worker continues only when the one trusted
`rel="next"` entry declares `results="true"`. Missing or malformed links,
untrusted origins/paths, duplicate next links, and repeated recent cursors fail
closed. Cursor fingerprints use a fixed-size history so long traversals do not
grow continuation state or introduce an artificial page limit.

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

Continuation state remains below Workers' 256 KiB runtime limit, with reserved
headroom for compact cursor history and a secondary cap of 500 active projects.
Metadata length varies, so the serialized-state budget can be reached first.
If either aggregation boundary is reached, the Worker checkpoints before any
project rows are written and asks for a narrower project or environment scope.
After the configured scope changes, it automatically restarts from a fresh
window instead of retrying an unrecoverable oversized state. During project
inventory pagination, emitted aggregates are removed so continuation state
shrinks while rows are written.

Apply the narrower scope with `ntn workers env set`, then rerun
`ntn workers sync trigger projectsSync`. No sync-state reset is required.

### Recent rollout health

The release refresh deliberately requests the maximum 100 releases from
Sentry's documented most-recent-first organization endpoint, so this is an
explicit useful set rather than accidental pagination truncation. The Worker
uses only the endpoint's documented project and environment filters. The
separate Release Health query applies the same explicit project and environment
scope shown in Notion.

One additional sessions request groups the prior seven days by release across
the configured project and environment scope, requests totals without
time-series payloads, and orders by session volume. This avoids per-release
detail calls. The Worker requests at most 250 groups and fails if Sentry reaches
that boundary, because treating a potentially capped result as complete could
remove valid rows or omit health. With four fields and seven daily buckets,
that conservative request also remains below Sentry's documented
10,000-data-point constraint even if the service computes series before
omitting them from the response.

A successful empty health result is valid and clears unavailable metrics. API
errors, including 404s, remain visible failures rather than being interpreted
as absent telemetry. Because the release sync uses replacement semantics, a
failed health request does not publish a partial snapshot or clear previously
valid rows.

### Rate limits and request safety

All three syncs share a conservative 60-request-per-minute pacer. Sentry uses
caller- and endpoint-specific quotas instead of publishing one universal
limit. On HTTP 429, the Worker passes usable `Retry-After` and
`X-Sentry-Rate-Limit-Reset` delays to the Workers runtime.

Requests have a 30-second timeout, reject redirects, and send the bearer token
only to a validated HTTPS base URL. Loopback HTTP is allowed for local testing.
Authentication and authorization errors remain visible rather than being
reinterpreted as empty provider data.

## Sentry access and configuration

### Create a Sentry token

Prefer an organization **internal integration** for a deployed Worker:

“Internal integration” is Sentry's name for an organization-owned credential;
it does not mean this example calls an internal or alpha API.

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

| Variable              | Required | Description                                                                           |
| --------------------- | -------- | ------------------------------------------------------------------------------------- |
| `SENTRY_AUTH_TOKEN`   | Yes      | Bearer token with `event:read`, `org:read`, and `project:releases`                    |
| `SENTRY_ORG_SLUG`     | Yes      | Organization slug from the Sentry URL                                                 |
| `SENTRY_PROJECTS`     | No       | Comma-separated project IDs or slugs; scopes issues, projects, releases, and health   |
| `SENTRY_ENVIRONMENTS` | No       | Comma-separated environments; scopes issues, project aggregates, releases, and health |
| `SENTRY_BASE_URL`     | No       | HTTPS root for self-hosted Sentry; defaults to `https://sentry.io`, without API path  |

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
├── sentry.ts     — REST client, response validation, pagination, and rate limits
├── sync-state.ts — pinned windows, cursor safeguards, and continuation limits
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
ntn workers sync trigger issuesSync --local --preview
ntn workers sync trigger projectsSync --local --preview
ntn workers sync trigger releasesSync --local --preview
```

Keep generated and machine-local files out of commits. `.env`, `workers.json`,
`workers.*.json`, `package-lock.json`, `dist/`, and `node_modules/` are
gitignored; `.env.example` is the tracked configuration template. A test
deployment does not require committing its generated Worker configuration.

Confirm that recently active resolved and unresolved issues appear; project
totals match the scoped issue set; current/prior seven-day buckets line up with
Sentry; newest releases remain one row each with project context; and a
successful health response without a matching release group clears prior
metrics rather than retaining stale values or creating false zeroes.

## Customizing the default set

To remove a database from a fork, delete its `worker.database(...)` and
`worker.sync(...)` blocks from `src/index.ts`, then remove its schema module if
unused. No environment flag is required. This stops future management but does
not trash a database created by an earlier deployment; archive or trash that
database manually in Notion after confirming its contents are no longer needed.

### Safe extension contract

Follow the complete path for every field or resource rather than editing only
the visible schema:

1. **Provider contract:** add the narrow response type and runtime parser in
   `src/sentry.ts`. Build URLs from the validated Sentry base, validate provider
   pagination with `nextCursorFromLink`, and route every request through
   `fetchSentryJson` so timeout, redirect, authentication, rate-limit, and
   response checks remain consistent. Retain only fields the database actually
   uses.
2. **Database contract:** update the schema and transform together in
   `src/issues.ts`, `src/projects.ts`, or `src/releases.ts`. Every upsert must
   emit every declared schema property; emit the empty property value (`[]`)
   when an upstream nullable value disappears so Notion clears stale data. Use
   an immutable provider ID as the primary key.
3. **Lifecycle contract:** register a new database, sync, and schedule in
   `src/index.ts`. Pin the time window and `SentryScope` for the full refresh,
   validate cursor traversal with `nextCursorTraversal`, and enforce the
   continuation limits in `src/sync-state.ts`. If state can grow before any
   rows are emitted, prefer a small recoverable checkpoint like the projects
   sync rather than stranding an oversized continuation.
4. **Completeness contract:** exhaustive syncs must follow trusted pagination
   until a terminal `hasMore: false`; never silently stop and call a partial
   result complete. If a deliberately bounded snapshot is more useful, as with
   the newest 100 releases, make the limit part of its membership definition
   and document it.
5. **Verification contract:** add complete, minimal, populated-to-missing,
   explicit-zero, unknown-enum, privacy, cursor, rate-limit, and boundary tests
   in `test.ts`. Then run the offline checks and exercise the changed endpoint
   against a small real Sentry scope before deployment.

Keep raw event data out of this base example. A webhook-driven fork can improve
issue freshness while the full refresh remains reconciliation.

## Official documentation

- [List an organization's issues](https://docs.sentry.io/api/events/list-an-organizations-issues/)
- [List an organization's projects](https://docs.sentry.io/api/organizations/list-an-organizations-projects/)
- [List an organization's releases](https://docs.sentry.io/api/releases/list-an-organizations-releases/)
- [Retrieve Release Health session statistics](https://docs.sentry.io/api/releases/retrieve-release-health-session-statistics/)
- [Sentry pagination](https://docs.sentry.io/api/pagination/)
- [Sentry rate limits](https://docs.sentry.io/api/ratelimits/)
- [Sentry authentication and permissions](https://docs.sentry.io/api/auth/)
- [Sentry data scrubbing](https://docs.sentry.io/security-legal-pii/scrubbing/)
- [Notion Workers overview](https://developers.notion.com/workers/get-started/overview)
- [Workers SDK reference](https://developers.notion.com/workers/reference/sdk)
- [Workers sync guide](https://developers.notion.com/workers/guides/syncs)
