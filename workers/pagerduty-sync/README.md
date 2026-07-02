# Worker sync: PagerDuty

Use this Worker as a read-only operations awareness and reliability handoff hub
in Notion. It brings active and recent PagerDuty incidents together with service
ownership, response state, current primary on-call coverage, integrations, and
support hours. The Worker creates two managed databases, links each incident to
its PagerDuty service, and preserves direct links back to PagerDuty.

PagerDuty remains the response console and authoritative incident timeline.
Responders still use PagerDuty to acknowledge, reassign, escalate, resolve, and
inspect the complete event history. Notion provides a shared operational view
and a place to coordinate durable follow-up; it does not replace paging or
incident command.

## Quickstart

You need Node.js 22+, npm 10.9.2+, the Notion Workers CLI, and a PagerDuty REST
API key that can read the incidents, services, and current on-calls you want to
copy. For an account-wide sync, an Admin or Account Owner can create a
**read-only** key under
**Integrations > Developer Tools > API Access Keys**. Then run from the
repository root:

```sh
npm install --global ntn
cd workers/pagerduty-sync
npm install
cp .env.example .env
# Edit .env: add the token, select the EU region if needed, and set any scope.
ntn login
ntn workers deploy --name pagerduty-sync
ntn workers env push
```

Using the gitignored `.env` file keeps the token out of the command itself and
your shell history. EU service-region accounts set `PAGERDUTY_REGION=eu` in
that file before pushing it.

Preview both syncs without writing rows:

```sh
ntn workers sync trigger servicesSync --preview
ntn workers sync trigger incidentsSync --preview
```

A preview invokes one callback, while a normal sync cycle follows callbacks
until `hasMore` is false. Every unscoped service discovery callback and the
incident confirmation callback are validation-only, so an empty `changes`
array is expected during those phases. Whenever `hasMore` is true, copy the
preview's `nextContext` value and continue:

```sh
ntn workers sync trigger servicesSync --preview --context '<nextContext JSON>'
```

Repeat with each returned `nextContext` until `hasMore` is false. Use the same
continuation flow for incidents to inspect the open, confirmation, and recent
history phases.

Then populate the service directory before its incident relations:

```sh
ntn workers sync trigger servicesSync
ntn workers sync trigger incidentsSync
```

The worker targets a five-minute cadence for both databases. A complete cycle
can take longer when PagerDuty returns many pages or asks the Worker to retry.
No `NOTION_API_TOKEN` is needed: the Workers platform supplies the Notion client
and owns authentication to the managed databases.

## What you can answer

| Managed database        | Questions it helps answer                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PagerDuty Incidents** | Which incidents need attention? Who is assigned? What changes automatically next? Is there a conference bridge? What was the resolution duration?                           |
| **PagerDuty Services**  | What response state is PagerDuty reporting? Who is primary on call? Which services lack primary coverage or ownership? What integrations, support hours, and routing apply? |

The sync is deliberately read-only. Responders follow **Incident Link** or
**Service Link** back to PagerDuty for action and live detail. It does not copy
stakeholder status updates, business-impact records, notes, or the full
timeline. **Response State** is a readable form of PagerDuty's service status;
it is not an independently calculated health score, uptime measurement, or open
incident count.

## Reference

### Databases and schedules

| Database                | Sync            | Mode    | Schedule    | Default scope                                       |
| ----------------------- | --------------- | ------- | ----------- | --------------------------------------------------- |
| **PagerDuty Incidents** | `incidentsSync` | replace | Every 5 min | All open incidents plus the last 90 days of history |
| **PagerDuty Services**  | `servicesSync`  | replace | Every 5 min | All services visible to the key                     |

The incident sweep first reads every Triggered or Acknowledged incident, without
a creation-time cutoff. It then reads all statuses whose incident creation time
falls in the rolling lookback, so recent Resolved incidents remain available for
review. An old incident stays in Notion while it is open and ages out only after
it is resolved and outside the lookback.

Both syncs use replacement sweeps. At the end of a successful cycle, a row is
removed when its upstream record was deleted, became invisible to the key, or
fell outside the relevant service/team/history scope. A failed or incomplete
sweep does not intentionally present itself as a complete snapshot.

#### PagerDuty Incidents

| Notion property           | PagerDuty field                                 | Type        |
| ------------------------- | ----------------------------------------------- | ----------- |
| Title                     | `title`                                         | title       |
| Status                    | `status`                                        | select      |
| Urgency                   | `urgency`                                       | select      |
| Assigned To               | all `assignments[].assignee` names              | multiSelect |
| Incident Link             | `html_url`                                      | url         |
| Service                   | relation keyed by `service.id`                  | relation    |
| Incident Type             | readable `incident_type.name`                   | select      |
| Last Changed By           | `last_status_change_by` name                    | select      |
| Next Automatic Action     | earliest valid `pending_actions[]` entry        | select      |
| Next Action At            | timestamp paired with Next Automatic Action     | date        |
| Conference Link           | safe HTTP(S) `conference_bridge.conference_url` | url         |
| Conference Dial-in        | `conference_bridge.conference_number`           | richText    |
| Resolution Duration (min) | elapsed time from `created_at` to `resolved_at` | number      |
| Priority                  | `priority.summary` or `priority.name`           | select      |
| Teams                     | all `teams[]` names                             | multiSelect |
| Escalation Policy         | `escalation_policy` name                        | select      |
| Last Status Change        | `last_status_change_at`                         | date        |
| Updated                   | `updated_at`                                    | date        |
| Total Alert Count         | `alert_counts.all`                              | number      |
| Active Alert Count        | `alert_counts.triggered`                        | number      |
| Acknowledged By           | current `acknowledgements[].acknowledger` names | multiSelect |
| Last Acknowledged         | latest current `acknowledgements[].at`          | date        |
| Assigned Via              | `assigned_via`                                  | select      |
| Created                   | `created_at`                                    | date        |
| Resolved                  | `resolved_at`                                   | date        |
| Incident Number           | `incident_number`                               | number      |
| PagerDuty Incident ID     | immutable `id`                                  | richText    |

**PagerDuty Incident ID** is the primary key. The familiar incident number is
retained for searching and sorting but is not used as sync identity.

**Service** is a two-way relation keyed by the immutable service ID. Notion
adds the reciprocal **Incidents** property to each related service so a service
page can show or count its synced incidents.

PagerDuty returns assignments only while an incident is open and returns
acknowledgements only for an acknowledged incident. The transform therefore
clears those Notion values when PagerDuty no longer returns them; it does not
turn missing history into a misleading zero. Priority and Incident Type are
also left empty for accounts or incidents where the features are unavailable.

**Next Automatic Action** is the chronologically earliest valid pending action
PagerDuty returns, with action type and destination used as deterministic tie
breakers. It describes provider automation such as escalation, unacknowledgment,
auto-resolution, or an urgency change; it is not a task assigned in Notion.
**Resolution Duration (min)** is rounded to one decimal and appears only when
both timestamps form a valid nonnegative interval. Last Changed By may identify
a user, service, or integration. Conference fields are cleared independently
when PagerDuty does not return a safe web URL or a dial-in number.

The incident page body is a bounded initial-trigger snapshot: the first-trigger
description, an included email trigger message rendered as plain text, and safe
HTTP(S) context links. It does not copy the incident body, arbitrary structured
trigger details, notes, status updates, or the PagerDuty timeline. Follow
**Incident Link** for the full record and response history.

#### PagerDuty Services

| Notion property            | PagerDuty field or derivation                                  | Type        |
| -------------------------- | -------------------------------------------------------------- | ----------- |
| Name                       | `name`                                                         | title       |
| Response State             | readable `status`                                              | select      |
| Primary On Call            | level-one current on-call user names for the escalation policy | multiSelect |
| Primary Coverage           | service status, policy presence, and current level-one entries | select      |
| Teams                      | all `teams[]` names                                            | multiSelect |
| Service Link               | `html_url`                                                     | url         |
| Coverage Checked           | cycle-pinned on-call observation time                          | date        |
| Integrations               | all `integrations[]` names                                     | multiSelect |
| Integration Count          | number of unique returned integration IDs                      | number      |
| Support Hours              | readable `support_hours` window and time zone                  | richText    |
| Last Incident              | `last_incident_timestamp`                                      | date        |
| Escalation Policy          | `escalation_policy` name                                       | select      |
| Description                | `description`                                                  | richText    |
| Urgency Rule               | readable `incident_urgency_rule` summary                       | richText    |
| Auto Resolve (min)         | `auto_resolve_timeout` converted from seconds                  | number      |
| Re-trigger After Ack (min) | `acknowledgement_timeout` converted from seconds               | number      |
| Created                    | `created_at`                                                   | date        |
| PagerDuty Service ID       | immutable `id`                                                 | richText    |

The complete service description is also used as page content. A disabled or
unavailable timeout is left empty instead of being presented as a duration.
Integration Count preserves zero; Integrations is empty when there are no
names to display. Support Hours is empty when the service has no configured
window.

Every upsert includes every schema property, using an explicit empty value when
PagerDuty removes data. This lets a populated incident or service converge to
its new empty state instead of retaining stale Notion values. Provider-authored
select and multi-select labels normalize ASCII commas, de-duplicate
case-insensitively, sort deterministically, and bound long names with a stable
digest suffix. A row with more than Notion's 100-value multi-select limit fails
visibly rather than silently dropping ownership, responder, or integration
data.

Response State maps PagerDuty's service status as follows: `active` becomes
**No Open Incidents**, `warning` becomes **Response in Progress**, `critical`
becomes **Awaiting Response**, and maintenance and disabled services become
**Maintenance** and **Disabled**. This is the service-level status PagerDuty
returned at observation time, not a separately traversed incident aggregate.

Primary Coverage describes only the first escalation level and uses exactly
four states:

- **Covered:** PagerDuty returned at least one current level-one on-call entry
  for the service's escalation policy.
- **No Primary On Call:** the service has an escalation policy, but the complete
  current snapshot returned no level-one entry. A fallback escalation level may
  still be staffed; this label does not claim that every policy level is empty.
- **No Escalation Policy:** an enabled service has no policy to query.
- **Not Applicable:** the service is disabled.

Primary On Call contains the deduplicated, sorted names from those level-one
entries. Coverage can still be **Covered** when an entry exists but its user
reference has no displayable name. The Worker never converts a failed,
unauthorized, malformed, changing, or incomplete `/oncalls` traversal into the
**No Primary On Call** state; the service replacement cycle fails instead and
does not perform replacement deletion. Upserts from successful earlier publish
pages may already be visible, so a failed multi-page cycle is not described as
transactional.

PagerDuty's service response has no general `updated_at` timestamp. Each row's
`upstreamUpdatedAt` is therefore the cycle's pinned observation time so response
state, coverage, ownership, integrations, support hours, description, and
timeout changes are reapplied rather than skipped against the service's creation
time. **Coverage Checked** exposes that same instant. It is evidence of when
the snapshot was taken, not a promise that the person remains on call after the
row was written.

### Recommended Notion views

Deployment creates the databases and properties, but not saved views. Add these
after the first successful sync.

#### Operations awareness

Create this view in **PagerDuty Incidents**:

- Advanced filter: `(Status is Triggered) OR (Status is Acknowledged)`.
- Group by **Status**.
- Sort by **Priority** ascending, **Urgency** ascending, **Next Action At**
  ascending, then **Last Status Change** descending.
- Show **Title**, **Status**, **Urgency**, **Priority**, **Service**,
  **Incident Type**, **Assigned To**, **Active Alert Count**,
  **Next Automatic Action**, **Next Action At**, **Last Changed By**,
  **Conference Link**, **Conference Dial-in**, and **Incident Link**.

This is the shared awareness view. Use Incident Link for live response, because
the five-minute sync cadence and a cycle's API work make it intentionally less
current than PagerDuty.

#### Service readiness and primary coverage gaps

Create **Service readiness** in **PagerDuty Services**:

- Filter **Response State** to anything except **Disabled**.
- Group by **Response State**.
- Sort by **Primary Coverage** ascending, then **Name** ascending.
- Show **Name**, **Response State**, **Primary On Call**,
  **Primary Coverage**, **Coverage Checked**, **Teams**,
  **Escalation Policy**, **Support Hours**, **Integrations**,
  **Integration Count**, and **Service Link**.

Duplicate that view as **Primary coverage gaps**, then add the advanced filter
`(Primary Coverage is No Primary On Call) OR (Primary Coverage is No Escalation Policy)`
while retaining `Response State is not Disabled`. Group by **Primary Coverage**
and sort by **Response State** ascending, then **Name** ascending.

#### Review intake

Create this view in **PagerDuty Incidents**:

- Filter **Status** to **Resolved** and **Resolved** to within the past 30 days.
- Sort by **Priority** ascending, **Resolution Duration (min)** descending, then
  **Resolved** descending.
- Show **Title**, **Priority**, **Service**, **Incident Type**, **Resolved**,
  **Resolution Duration (min)**, **Last Changed By**, and **Incident Link**.

Use this as intake for a native Notion review workflow, not as a claim that
PagerDuty already classified an incident as requiring review.

### User-owned Incident Reviews

Do not add mutable review ownership or status to either managed sync database.
Instead, create a normal Notion database named **Incident Reviews** with these
properties:

| Property            | Type             | Purpose                                                          |
| ------------------- | ---------------- | ---------------------------------------------------------------- |
| Review              | title            | Durable review or post-incident record                           |
| PagerDuty Incident  | one-way relation | Links to PagerDuty Incidents without changing its managed schema |
| Review Status       | status           | Needed, In progress, Complete, or Not required                   |
| Review Owner        | people           | Notion-native follow-up owner                                    |
| Review Due          | date             | Review deadline                                                  |
| Review Document     | url              | Optional external postmortem                                     |
| Service             | rollup           | Service from the related incident                                |
| Priority            | rollup           | Priority from the related incident                               |
| Resolved            | rollup           | Resolution time from the related incident                        |
| Resolution Duration | rollup           | Resolution Duration (min) from the related incident              |

From **Review intake**, decide whether a review is needed, create and relate an
Incident Reviews page, assign its owner and due date, and keep notes, decisions,
and action items in that native page. Use **Incident Link** for PagerDuty's
authoritative history. A review page and all user-entered mutable fields remain
owned by the workspace and are never written or replaced by this Worker. The
related managed incident can age out after the configured lookback, so copy any
facts that must remain durable instead of relying indefinitely on rollups.

In Incident Reviews, a useful **Review queue** filters Review Status to Needed
or In progress, groups by Review Status, and sorts Review Due ascending, then
Priority ascending.

### Configuration

| Variable                           | Required | Default | Description                                                                                                 |
| ---------------------------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `PAGERDUTY_API_TOKEN`              | yes      | —       | REST API key sent only in the `Authorization` header                                                        |
| `PAGERDUTY_REGION`                 | no       | `us`    | `us` uses `api.pagerduty.com`; `eu` uses `api.eu.pagerduty.com`                                             |
| `PAGERDUTY_INCIDENT_LOOKBACK_DAYS` | no       | `90`    | Resolved/recent history in days, from 1 through 180; open incidents are retained regardless of age          |
| `PAGERDUTY_SERVICE_IDS`            | no       | all     | Comma-separated service IDs; scopes incidents and directly selects the service rows to fetch                |
| `PAGERDUTY_TEAM_IDS`               | no       | all     | Comma-separated team IDs applied only to incident queries; requires the PagerDuty account's `teams` ability |

`PAGERDUTY_SERVICE_IDS` scopes both databases. When it is set, the service sync
fetches those services directly by ID instead of scanning the service directory.
A configured ID that is missing or invisible fails the cycle visibly instead of
silently producing an incomplete service table. `PAGERDUTY_TEAM_IDS` scopes
incidents only: the service directory remains unfiltered so Incident → Service
relations can resolve. When both filters are set, they intersect for incidents,
while the service database still follows only the service-ID scope. Omit the team
filter when the PagerDuty account does not have the `teams` ability.

PagerDuty describes the maximum incident search range as six months. This
recipe accepts a conservative 1–180 day rolling lookback. Configured IDs are
case-sensitive opaque values rather than values matched to an assumed provider
format. Each is limited to 255 characters; control characters and the `.` and
`..` service-ID values are rejected because they cannot be preserved as URL path
segments, while duplicate IDs and surrounding whitespace are removed.
Configuration is copied into serializable sync state at the beginning of a
cycle, so an environment change cannot alter an in-progress traversal; the next
cycle uses the new value.

To retain 30 days and limit both databases to two services, edit `.env`:

```dotenv
PAGERDUTY_INCIDENT_LOOKBACK_DAYS=30
PAGERDUTY_SERVICE_IDS=PABC123,PDEF456
```

Then run `ntn workers env push` and repeat both preview commands before writing.
PagerDuty service and team IDs appear in their web-app URLs and API responses.
The `.env` file is gitignored; never put a real token in `.env.example`,
`workers.json`, tests, or source control.

### Authentication, visibility, and privacy

The client uses PagerDuty REST API v2's `Token token=...` authorization scheme
and accepts REST API access keys, not OAuth bearer tokens. A read-only account
key is the simplest choice because this Worker makes only `GET` requests. A user
API key also works, but its PagerDuty role and team access limit which incidents,
services, and on-call entries appear. A `403` from `/oncalls` fails the service
cycle; it is not represented as missing primary coverage.

Incident titles, responder and current on-call names, team ownership,
initial-trigger descriptions and messages, context links, conference URLs and
dial-in numbers, integration names, support hours, and service descriptions may
be sensitive. A conference URL or number may grant access to a live response
call, and integration names can reveal internal architecture. The key's
visibility defines what can be copied, but Notion sharing controls who can read
the copy afterward. Hiding a property in one view is not an access boundary.

Review the PagerDuty scope and destination sharing before the first write and
before sharing either managed database broadly. Give a user-owned Incident
Reviews database its own appropriate sharing policy. Preview output can contain
the same source data, so treat it as sensitive too.

### Pagination and consistency

PagerDuty's list endpoints use offset pagination and expose at most 10,000
records through an offset traversal. One complete Worker cycle follows these
phase flows:

```text
Incidents: open → open confirmation → recent window(s) → complete
Services: discover → publish → complete
Configured services: publish directly → complete
```

`src/sync-state.ts` contains pure transitions for these phases; the Workers
runtime persists the returned `nextState` between callbacks. The worker protects
completeness as follows:

1. An incident cycle pins the recent-history upper boundary and the service/team
   scope before its first request. Recent-history incidents created later wait
   for the next cycle.
2. The all-open phase is intentionally a live set with no creation-time cutoff,
   so it can include an incident created during the cycle. The Worker scans this
   set twice, and the confirmation pass must reproduce every first-pass ID in
   order. Every continuing page also re-reads the preceding boundary incident
   and verifies its immutable ID and incident number. A substitution, boundary
   shift, total drift, or order drift therefore fails the replacement cycle
   instead of silently skipping an older open incident. Because this set cannot
   be divided by creation time, a total above 10,000 also fails with guidance to
   narrow the service or team scope.
3. The rolling-history phase requests all statuses in initial seven-day windows.
   Any window above 10,000 records is divided into smaller time windows until
   each part can be traversed completely. If an oversized remaining window is
   one minute or less, the cycle fails with guidance to narrow the service or
   team scope.
4. History windows share their exact boundary, and the open and history phases
   can return the same incident. Both cases intentionally replay the immutable
   incident ID, so the upserts converge on one row instead of missing a boundary
   record.
5. Every list page requests `total=true`. The client checks the echoed offset,
   full continuing pages, overlapping record boundary, continuation progress,
   stable total, processed count, and strictly increasing incident numbers. An
   inconsistent traversal fails visibly instead of committing a knowingly
   partial replacement.
6. Without `PAGERDUTY_SERVICE_IDS`, the Worker first discovers the complete
   service identity set without emitting rows, then traverses the directory
   again to publish it. The publish pass must reproduce the same set, so an
   equal-count delete/create race or mutable-name page shift fails before
   replacement deletion instead of silently removing a still-live service. A
   visible directory above 10,000 fails with guidance to configure explicit
   service IDs. With IDs configured, each service is fetched directly and
   published without discovery; a missing/invisible ID fails visibly, and the
   offset ceiling does not apply.
7. Each service publish callback collects the unique escalation policies
   referenced by that service page and reads their current on-calls at the
   cycle-pinned **Coverage Checked** instant. The request uses the same timestamp
   for `since` and `until`, follows every offset page, requires a stable reported
   total and processed count, validates each entry, and fails above 10,000
   entries. If the result spans multiple pages, the Worker repeats the complete
   traversal and requires the same raw identity multiset before publishing
   coverage. The Worker transforms the service page only after this traversal
   completes. A page with no escalation policies makes no `/oncalls` request.

All state is plain serializable data; the sync never relies on a module-global
cache surviving between Worker executions.

### Rate limits

Every request from both syncs shares one pacer capped at 120 requests per
minute. This leaves substantial headroom beneath PagerDuty's general REST API
allowance and for other applications sharing the same user or key. Actual
limits can also vary by operation and credential.

Per cycle, the open confirmation costs twice the number of open-incident pages,
and recent history costs one request per page and subwindow. The new incident
properties come from those list responses and do not add per-incident requests.

An unfiltered service cycle reads every `/services` page twice: discovery emits
no rows and makes no `/oncalls` requests, then publish reproduces the discovered
identity set. Each publish callback reads up to 100 services and queries
`/oncalls` for the unique escalation policies on that page. A one-page directory
with one-page coverage therefore costs three requests. A multi-page on-call
result costs twice its page count because the Worker confirms the complete raw
identity set with a second traversal. An explicit service scope skips discovery,
reads one configured service per callback, and queries that service's policy; a
policy shared by services on different pages can therefore be queried again. A
page with no policies skips the on-call request. Integrations and support hours
come from the service response and add no per-service lookup. The shared pacer
applies to all incident, service, and on-call requests combined.

The Worker deliberately does not duplicate the bounded incident traversal to
calculate service-level open-incident counts. It also makes no per-incident
stakeholder-status or business-impact calls. Those additions would materially
increase request volume and could turn an awareness sync into an unbounded
fan-out.

When PagerDuty returns HTTP 429, the client raises the Workers runtime's
`RateLimitError`. It honors `Retry-After` and PagerDuty's `ratelimit-reset`
header, with a conservative fallback when neither is usable. Invalid JSON,
non-success responses, malformed pages, and non-advancing pagination all fail
closed.

### Project structure

```text
src/
├── index.ts       — registers databases, syncs, and pacing; orchestrates callbacks
├── pagerduty.ts   — list/direct API reads, configuration, and validation
├── sync-state.ts  — incident/service phases, windows, and identity checks
├── incidents.ts   — incident schema and transform
├── services.ts    — service schema, coverage context, and transform
└── helpers.ts     — labels, durations, support hours, and safe page formatting
```

### Extending the example

The confirmation, overlap, and window-splitting state machine is specific to
PagerDuty's live offset pagination. For a provider with stable cursors, start
from the [Linear sync](../linear-sync/); for incremental change tracking plus a
replacement repair path, start from the [Salesforce sync](../salesforce-sync/).

Use this checklist when extending the recipe:

1. Add the provider field to the relevant validated API type in
   `src/pagerduty.ts`; do not trust an unvalidated response shape.
2. Add its `Schema.*` property and matching `Builder.*` value in the same order.
   Keep the first six columns focused on triage, ownership, relation, and source
   actions.
3. Define the behavior for populated, missing, empty, zero, and plan-dependent
   values. Prefer human-readable `summary` or `name` fields over opaque IDs.
4. Preserve deterministic primary keys and the two-way Incident → Service
   relation. Do not let a team filter remove service rows needed by relations.
5. If another endpoint is required, use a bounded batch or one lookup per cycle.
   Do not introduce an unbounded per-incident request, and keep all calls on the
   shared pacer.
6. Revisit the 10,000-record boundary. List traversals need a deterministic split
   strategy or a clear fail-closed scope requirement; explicit service IDs should
   continue to use direct lookups.
7. Whitelist any page content, render provider text as plain text, accept only
   safe context-link protocols, bound its size, and update the privacy inventory.
   Do not copy arbitrary provider payloads or credentials.
8. Add offline tests for populated and explicitly cleared values, request
   parameters, pagination, split boundaries, duplicate detection, filter
   semantics, and rate limits. Add a safe live preview for behavior that fixtures
   cannot prove.
9. Update the property/configuration tables, expected output, extension notes,
   and verification steps. If behavior, entrypoints, integrations, or commands
   change, update the recipe's `catalog.json` entry too.

The default intentionally stops at current level-one coverage on each service.
It does not create a third Worker-managed on-call or review database, browse
future shifts, or copy incident timelines. The native Incident Reviews workflow
above owns mutable follow-up in Notion. Any extension for upcoming schedules,
stakeholder updates, or business impact should first define a bounded batch or
hard scope; do not add an unbounded per-record request path.

### Verification

Run all deterministic checks without contacting PagerDuty or Notion:

```sh
npm run check
npm test
npm run build
```

With a safe test account and `.env` configured, inspect each live result before
writing:

```sh
ntn workers exec servicesSync --local
ntn workers exec incidentsSync --local
ntn workers sync trigger servicesSync --preview
ntn workers sync trigger incidentsSync --preview
```

The `workers exec --local` commands validate local wiring and one callback. For
a complete deployed preview, follow the `nextContext` continuation loop from
the Quickstart until `hasMore` is false.

For live verification, confirm that names are resolved, removed upstream values
clear their prior Notion properties, source and conference links open safely,
the two-way Incident → Service relation resolves, and resolution duration agrees
with the source timestamps.
For services, confirm Response State matches PagerDuty, Primary On Call contains
only current level-one responders, Primary Coverage reflects that level rather
than every fallback, Coverage Checked matches the snapshot instant, and
integrations and support hours match the service. Also confirm EU accounts use
the EU host, all open incidents are present regardless of age, and Resolved
history stops at the configured lookback.

The offline suite cannot prove workspace permissions, API-key visibility, the
current person on call, live conference access, or plan-specific fields such as
priorities. A permission or completeness failure must stop the preview or sync;
do not reinterpret it as an empty or healthy result.

## Learn more

- [Notion sync guide](https://developers.notion.com/workers/guides/syncs)
- [Notion secrets guide](https://developers.notion.com/workers/guides/secrets)
- [PagerDuty REST API reference](https://developer.pagerduty.com/api-reference/)
- [PagerDuty OpenAPI schema](https://github.com/PagerDuty/api-schema)
- [PagerDuty API access keys](https://support.pagerduty.com/main/docs/api-access-keys)
- [PagerDuty service regions](https://support.pagerduty.com/main/docs/service-regions)
- [PagerDuty REST API rate limits](https://support.pagerduty.com/main/docs/rest-api-rate-limits)
- [Contributing guide](../../CONTRIBUTING.md)
