# Worker sync: Sentry

Bring the Sentry issues that mattered during the last 30 days into Notion for
triage, operational review, and cross-functional visibility. The Worker keeps
one approachable **Sentry Issues — Last 30 Days** database current every 15
minutes, with native lifecycle signals, recent event volume, user impact,
ownership, and a link back to Sentry.

The result is useful immediately: create views for unresolved issues,
regressions, unassigned high-impact errors, recently active issues that are now
resolved, or concentrations by project without changing the code.

## Quickstart

You need Node.js 22+, a Sentry organization, an
[internal integration token](#create-a-sentry-token) with `event:read` access,
and permission to read the projects you want to sync. From the repository
root:

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
slug with your Sentry project ID or slug:

```sh
ntn workers env set SENTRY_PROJECTS=checkout-api
ntn workers env set SENTRY_ENVIRONMENTS=production
```

Create and populate the database immediately, while streaming the run output:

```sh
ntn workers exec issuesSync --stream
```

The Worker refreshes the database every 15 minutes. It includes issues of
every status that Sentry considers active in the pinned 30-day query window;
an issue that is no longer returned by that rolling window is removed from the
managed database after a complete successful refresh.

## What you can answer

| Question                                                                | Fields to use                                      |
| ----------------------------------------------------------------------- | -------------------------------------------------- |
| What is breaking now?                                                   | Status, Priority, Events (24h), Users (30d)        |
| What is new, regressed, or escalating?                                  | Status Detail, Last Seen                           |
| Which important or unhandled issues have no owner?                      | Assignee, Priority, Unhandled, Events (30d)        |
| Which issues are hottest today or have caused the most lifetime impact? | Events (24h), Lifetime Events, Lifetime Users      |
| Which recently active issues are now resolved or ignored?               | Status, Last Seen                                  |
| Where are recent issues concentrated?                                   | Project, Platform, Category, Issue Type, Unhandled |

## Reference

### Database and schedule

| Database                         | Sync         | Mode    | Schedule     | Membership                             |
| -------------------------------- | ------------ | ------- | ------------ | -------------------------------------- |
| **Sentry Issues — Last 30 Days** | `issuesSync` | replace | Every 15 min | Every status seen in the prior 30 days |

Here, `replace` means a **complete reconciliation**: the Worker reads every API
page in one pinned snapshot and Notion reconciles membership only after that
refresh succeeds. It does not delete and recreate the database. Existing rows
are updated by immutable Sentry issue ID; rows absent from the completed
30-day snapshot are removed.

One database is deliberate. Active, regressed, unassigned, resolved, and
project-specific lists are different views of the same issue data, so separate
managed databases would duplicate rows and make setup harder. A future
**Sentry Project Health** database would be worthwhile only with distinct
aggregates such as unresolved counts, high-priority counts, recent events, and
affected users—not merely project reference metadata.

### Field mapping

| Notion property | Sentry issue-group field               | Type     |
| --------------- | -------------------------------------- | -------- |
| Issue           | `title`                                | title    |
| Status          | `status`                               | select   |
| Assignee        | `assignedTo.name`                      | richText |
| Issue Link      | `permalink`                            | url      |
| Last Seen       | `lastSeen`                             | date     |
| Priority        | `priority`                             | select   |
| Status Detail   | `substatus`                            | select   |
| Level           | `level`                                | select   |
| Unhandled       | `isUnhandled`                          | checkbox |
| Events (24h)    | sum of `stats["24h"]`                  | number   |
| Events (30d)    | query-window `count`                   | number   |
| Users (30d)     | query-window `userCount`               | number   |
| Lifetime Events | `lifetime.count`                       | number   |
| Lifetime Users  | `lifetime.userCount`                   | number   |
| Project         | `project.name` or `project.slug`       | select   |
| Category        | `issueCategory`                        | select   |
| Issue Type      | `issueType`                            | select   |
| Platform        | issue or project `platform`            | select   |
| Culprit         | `culprit`                              | richText |
| First Seen      | `firstSeen`                            | date     |
| Issue Key       | `shortId` (for example, `CHECKOUT-42`) | richText |
| Sentry Issue ID | immutable `id`                         | richText |

**Sentry Issue ID** is the primary key. The familiar **Issue Key** remains
visible for recognition, but it is not used for identity because a display
identifier is not as durable as Sentry's underlying group ID.

Each page body contains a short, bounded triage snapshot assembled from these
same group-level fields: status, ownership, 24-hour, 30-day, and lifetime
impact, native lifecycle signals, location, first/last seen timestamps, and
the source link. It does not copy raw event payloads.

### Suggested Notion views

- **Active triage:** filter Status to Unresolved; sort by Priority, Events
  (24h), and Users (30d).
- **New and regressed:** filter Status Detail to New, Regressed, or Escalating;
  sort by Last Seen descending.
- **Needs an owner:** filter Status to Unresolved and Assignee empty, then sort
  by Unhandled, Priority, and Events (24h).
- **Largest user impact:** sort by Lifetime Users and Lifetime Events.
- **Recently active resolutions:** filter Status to Resolved or Ignored and
  sort by Last Seen. Last Seen is event activity—not the resolution timestamp.
- **Risk by service:** group by Project or Platform, then sort by Events (24h).

### Project structure

```text
src/
├── index.ts      — registers the managed database, schedule, and shared pacer
├── sentry.ts     — minimal REST client, trusted pagination, and rate limits
├── sync-state.ts — pinned 30-day window and cursor-loop safeguards
├── issues.ts     — Notion schema and issue-group transform
└── helpers.ts    — labels, safe values, statistics, and page summaries
```

### How it works

1. The Worker calls Sentry's current organization issue-search endpoint,
   `GET /api/0/organizations/{organization}/issues/`, requesting 100 groups per
   page. It makes one request per page and performs no per-issue enrichment.
2. Sentry normally defaults this endpoint to unresolved issues. The client
   deliberately sends an empty `query=` so the rolling database also includes
   resolved and ignored issues returned for the window.
3. The first page fixes an exact `start` and `end` spanning 30 days, plus the
   base URL, organization, project filters, environment filters, and a
   non-secret credential fingerprint. That scope remains in serializable sync
   state through the final page, so a long run cannot slide its window, mix
   queries, or continue under a newly rotated token with different access.
   Results use Sentry's `new` sort and request 24-hour group statistics.
4. Sentry's `Link` header is authoritative. The client continues only when the
   one `rel="next"` entry declares `results="true"`, extracts its opaque cursor,
   validates the URL's origin and path, and rebuilds the configured request.
   Missing links/cursors, duplicate next links, and immediate or longer cursor
   cycles fail the refresh instead of silently truncating it or looping.
5. A completed replace-mode run reconciles the whole key set. This catches
   status, priority, and assignee changes and removes groups that leave the
   rolling window. Sentry does not expose a reliable general issue mutation
   timestamp: `lastSeen` records event activity, so it is intentionally not
   treated as an incremental watermark.
6. All requests share a conservative 60-request-per-minute client-side pacer.
   Sentry uses caller- and endpoint-specific frequency and concurrency limits
   rather than one universal quota. On HTTP 429, the Worker passes usable
   `Retry-After` and `X-Sentry-Rate-Limit-Reset` delays to the Workers runtime
   for backoff.
7. Unknown future enum values remain visible as readable select values. Null
   values are omitted instead of being mislabeled; meaningful zero counts and
   a real `false` Unhandled value are preserved.

Every scheduled run reads the complete scoped 30-day result—one request for
each 100 issue groups. That is intentionally correct for status, priority, and
assignee changes, but a large unscoped organization can generate substantial
API traffic. Start with production and the projects your team reviews. If you
fork the example for a very large scope, use a slower schedule or combine a
webhook path with this full refresh as reconciliation.

## Sentry access and configuration

### Create a Sentry token

Prefer an organization **internal integration** for a deployed Worker:

1. In Sentry, open **Organization Settings > Developer Settings > Internal
   Integrations**.
2. Create an integration dedicated to this Worker.
3. Grant the least privilege needed to list issue groups: `event:read`.
4. Copy its token into `SENTRY_AUTH_TOKEN` and store it only with
   `ntn workers env set`.

A personal authentication token is convenient for testing, but it follows the
user's access and lifecycle. The internal integration is easier to scope and
operate independently. The token can sync only organizations, projects, and
environments it is allowed to read.

### Environment variables

| Variable              | Required | Description                                                                               |
| --------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `SENTRY_AUTH_TOKEN`   | Yes      | Bearer token with `event:read`                                                            |
| `SENTRY_ORG_SLUG`     | Yes      | Organization slug from the Sentry URL                                                     |
| `SENTRY_PROJECTS`     | No       | Comma-separated project IDs or slugs; omit for all projects visible to the token          |
| `SENTRY_ENVIRONMENTS` | No       | Comma-separated environment names, such as `production,staging`                           |
| `SENTRY_BASE_URL`     | No       | HTTPS root for self-hosted Sentry; defaults to `https://sentry.io` and must omit `/api/0` |

For example, scope a deployed Worker to two services and production:

```sh
ntn workers env set SENTRY_PROJECTS=checkout-api,billing-api
ntn workers env set SENTRY_ENVIRONMENTS=production
```

For self-hosted Sentry:

```sh
ntn workers env set SENTRY_BASE_URL=https://sentry.example.com
```

The client requires HTTPS before sending its bearer token; loopback HTTP is
accepted only for local development. Self-hosted versions can lag Sentry SaaS,
so the parser accepts absent optional fields and future enum values but fails
visibly if required identity or pagination contracts are missing.

## Privacy and operational boundaries

This example intentionally fetches only Sentry **issue-group metadata**. It
does not request raw events, stack traces, breadcrumbs, request bodies,
headers, query strings, tags, attachments, event users, IP addresses, or event
contexts. The parser retains an assignee's display name but discards email and
unselected response fields. It also avoids N+1 detail requests.

Issue titles and culprits can still contain customer, code, or infrastructure
details. Review Sentry's server-side data-scrubbing settings and the Notion
database's sharing permissions before syncing production data to a broader
audience.

This is a one-way mirror. Changes in Notion do not update Sentry. Sentry
remains the system of record and every row includes a direct source link.

## Local validation

All tests are offline and mock `fetch`; they do not need a Sentry token or
contact Sentry:

```sh
cd workers/sentry-sync
npm install
npm run check
npm test
npm run build
```

The suite covers full/minimal transforms, property order, unknown and null
values, zero counts, bounded Markdown, explicit all-status queries, project
and environment filters, trusted Link parsing, pinned windows, resource and
credential scope, longer cursor loops, authentication, malformed responses,
rate-limit resets, and a concrete Worker execution across pages.

For live verification without writing to Notion, copy `.env.example` to `.env`,
add credentials for a small test project, and stream one local execution:

```sh
ntn workers exec issuesSync --local --stream
```

Then deploy to a test Worker and use `ntn workers exec issuesSync --stream` for
an end-to-end managed-database run. Confirm that:

- resolved and unresolved groups are both present when Sentry returns both;
- Events (24h) matches the issue group's 24-hour chart;
- changing a status, priority, or assignee is reflected after the next run;
- the second page is reached in an organization with more than 100 matching
  groups;
- no raw event data or assignee email appears in the local output.

## Extending the example

To add another issue-group field:

1. Add only the selected API shape to `SentryIssue` and validate it in
   `parseIssue()` in `src/sentry.ts`.
2. Add the Notion property to `issueSchema` in `src/issues.ts`.
3. Add the matching transform property in exactly the same order.
4. Add complete, null, unknown-value, and privacy regression tests.
5. Update the mapping and recommended views in this README.

Keep raw event details out of this base example. For faster freshness, a
separate webhook-driven example can upsert changed groups while this full
refresh remains the reconciliation path. For a project-level database, first
compute meaningful health aggregates; do not create relations or thin project
rows merely because the API exposes them.

## Official documentation

- [List an organization's issues](https://docs.sentry.io/api/events/list-an-organizations-issues/)
- [Sentry pagination](https://docs.sentry.io/api/pagination/)
- [Sentry API rate limits](https://docs.sentry.io/api/ratelimits/)
- [Sentry API authentication](https://docs.sentry.io/api/auth/)
- [Sentry API permissions](https://docs.sentry.io/api/permissions/)
- [Sentry data scrubbing](https://docs.sentry.io/security-legal-pii/scrubbing/)
- [Notion Workers](https://developers.notion.com/docs/workers)
