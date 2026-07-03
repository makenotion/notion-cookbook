# Worker sync: PagerDuty

Bring PagerDuty incidents and service readiness into Notion so operations,
engineering, support, and leadership can share the same view of active response
and recent reliability work. The worker creates two related databases and keeps
them current every five minutes.

PagerDuty remains the place to page, acknowledge, escalate, and resolve. This is
a read-only coordination view with direct links back to the live source.

## Quickstart

You need Node.js 22+, npm 10.9.2+, a PagerDuty account, and a read-only REST API
key. From the repository root:

```sh
npm install --global ntn
cd workers/pagerduty-sync
npm install
ntn login
ntn workers deploy --name pagerduty-sync
ntn workers env set PAGERDUTY_API_TOKEN=your-read-only-api-key
```

EU service-region accounts also set:

```sh
ntn workers env set PAGERDUTY_REGION=eu
```

Both databases refresh automatically every five minutes. To preview without
writing, or populate them immediately instead of waiting for the first scheduled
run, use these optional commands:

```sh
ntn workers sync trigger servicesSync --preview
ntn workers sync trigger incidentsSync --preview

ntn workers sync trigger servicesSync
ntn workers sync trigger incidentsSync
```

Run Services first when populating immediately so Incident relations can
resolve. No `NOTION_API_TOKEN` is needed; the Workers platform handles Notion
authentication. Review the two databases' sharing settings before giving a
broader audience access to incident and on-call details.

## What you can answer

| Managed database        | Questions it helps answer                                                                                                                                                                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PagerDuty Incidents** | Which high-urgency incidents still need acknowledgment, who is handling them, and which services are affected? Will an incident escalate, change urgency, or resolve automatically next—and when? Which services have the most recent incidents or longest resolution times? |
| **PagerDuty Services**  | Which services are awaiting response, already responding, or in maintenance? Where is primary on-call coverage missing, and who is currently on call elsewhere? How do support hours, paging urgency, auto-resolution, and re-trigger timing differ by service?              |

## Reference

### Synced databases and schedules

| Database                | PagerDuty resource            | Schedule    | Default scope                                       |
| ----------------------- | ----------------------------- | ----------- | --------------------------------------------------- |
| **PagerDuty Incidents** | Incidents                     | Every 5 min | All open incidents plus the last 90 days of history |
| **PagerDuty Services**  | Services and current on-calls | Every 5 min | All services visible to the API key                 |

#### PagerDuty Incidents

| Notion property           | PagerDuty field or meaning                      | Type        |
| ------------------------- | ----------------------------------------------- | ----------- |
| Title                     | `title`                                         | title       |
| Status                    | `status`                                        | select      |
| Urgency                   | `urgency`                                       | select      |
| Assigned To               | `assignments[].assignee` names                  | multiSelect |
| Incident Link             | `html_url`                                      | url         |
| Service                   | relation keyed by `service.id`                  | relation    |
| Incident Type             | `incident_type.name`                            | select      |
| Last Changed By           | `last_status_change_by` name                    | select      |
| Next Automatic Action     | earliest valid `pending_actions[]` entry        | select      |
| Next Action At            | time of the next automatic action               | date        |
| Conference Link           | safe HTTP(S) `conference_bridge.conference_url` | url         |
| Conference Dial-in        | `conference_bridge.conference_number`           | richText    |
| Resolution Duration (min) | time from `created_at` to `resolved_at`         | number      |
| Priority                  | `priority.summary` or `priority.name`           | select      |
| Teams                     | `teams[]` names                                 | multiSelect |
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
| Incident Number           | human-facing `incident_number`                  | number      |
| PagerDuty Incident ID     | immutable `id`; the Notion primary key          | richText    |

The **Service** relation uses PagerDuty's immutable service ID and adds the
reciprocal **Incidents** property. Each page contains a bounded initial-trigger
summary; assignments and acknowledgements reflect current response state.

#### PagerDuty Services

| Notion property            | PagerDuty field or meaning                       | Type        |
| -------------------------- | ------------------------------------------------ | ----------- |
| Name                       | `name`                                           | title       |
| Response State             | readable `status`                                | select      |
| Primary On Call            | current level-one on-call names                  | multiSelect |
| Primary Coverage           | level-one coverage status                        | select      |
| Teams                      | `teams[]` names                                  | multiSelect |
| Service Link               | `html_url`                                       | url         |
| Coverage Checked           | sync cycle's pinned observation time             | date        |
| Integrations               | `integrations[]` names                           | multiSelect |
| Integration Count          | unique returned integration IDs                  | number      |
| Support Hours              | readable `support_hours` window and time zone    | richText    |
| Last Incident              | `last_incident_timestamp`                        | date        |
| Escalation Policy          | `escalation_policy` name                         | select      |
| Description                | `description`                                    | richText    |
| Urgency Rule               | readable `incident_urgency_rule`                 | richText    |
| Auto Resolve (min)         | `auto_resolve_timeout` converted from seconds    | number      |
| Re-trigger After Ack (min) | `acknowledgement_timeout` converted from seconds | number      |
| Created                    | `created_at`                                     | date        |
| PagerDuty Service ID       | immutable `id`; the Notion primary key           | richText    |

Response State translates PagerDuty's status into **No Open Incidents**,
**Response in Progress**, **Awaiting Response**, **Maintenance**, or
**Disabled**. It is the provider's service state, not a separately calculated
health score or open-incident count.

Primary Coverage describes escalation level one: **Covered**, **No Primary On
Call**, **No Escalation Policy**, or **Not Applicable** for a disabled service.
A fallback escalation level may still be staffed when the primary level is
empty. **Coverage Checked** records the sync cycle's pinned observation time;
it does not promise that the same person remains on call afterward. The
complete service description is also used as the page body.

### Project structure

```text
src/
├── index.ts       — registers the databases and sync schedules
├── pagerduty.ts   — PagerDuty client, configuration, and response validation
├── sync-state.ts  — incident and service pagination state
├── incidents.ts   — incident schema and transform
├── services.ts    — service schema, coverage context, and transform
└── helpers.ts     — labels, durations, support hours, and page formatting
```

### How it works

1. Every five minutes, **PagerDuty Incidents** reads all Triggered and
   Acknowledged incidents, regardless of age, plus every incident status created
   within the rolling lookback. An old incident remains until it is resolved and
   outside the lookback.
2. **PagerDuty Services** reads the service directory and a current level-one
   on-call snapshot for each referenced escalation policy. Services without
   recent incidents still appear.
3. Immutable PagerDuty IDs key both databases. Incident rows relate to stable
   Service rows even when the display names change.
4. A successful refresh removes records deleted upstream, hidden from the key,
   or outside the configured scope. An incomplete refresh does not remove rows
   from a partial result.

PagerDuty listings are capped at 10,000 records. For larger accounts, use
service or team filters to keep each synced scope complete.

### PagerDuty access and credentials

#### Getting a PagerDuty API key

1. Sign in as a PagerDuty Admin or Account Owner.
2. Open **Integrations > Developer Tools > API Access Keys**.
3. Create an API key dedicated to this worker and select **Read-only API Key**.
4. Copy the key and store it with `ntn workers env set`.

The worker makes only `GET` requests. A user API key also works, with visibility
limited by that user's role and team access.

### Configuration reference

| Variable                           | Required | Default | Description                                                                                          |
| ---------------------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `PAGERDUTY_API_TOKEN`              | yes      | —       | PagerDuty REST API key                                                                               |
| `PAGERDUTY_REGION`                 | no       | `us`    | `us` for `api.pagerduty.com`; `eu` for `api.eu.pagerduty.com`                                        |
| `PAGERDUTY_INCIDENT_LOOKBACK_DAYS` | no       | `90`    | Recent history from 1 through 180 days; open incidents remain regardless of age                      |
| `PAGERDUTY_SERVICE_IDS`            | no       | all     | Comma-separated service IDs; scopes both databases and directly selects service rows                 |
| `PAGERDUTY_TEAM_IDS`               | no       | all     | Comma-separated team IDs applied only to incidents; requires the PagerDuty account's `teams` ability |

Service IDs scope both databases. A missing or invisible configured service
fails the cycle instead of silently producing an incomplete directory. Team IDs
scope Incidents only, leaving Services available for relations. When both are
set, they intersect for Incidents.

### Adapting the schema

Each database has its schema and transform in one resource file:

| Resource  | File               |
| --------- | ------------------ |
| Incidents | `src/incidents.ts` |
| Services  | `src/services.ts`  |

To add a PagerDuty field:

1. Add and validate the provider field in `src/pagerduty.ts`.
2. Add its `Schema.*` property and matching `Builder.*` value in the resource
   file.
3. Preserve the immutable primary keys and Incident-to-Service relation.
4. Update this README and add tests for populated and missing values.

### Local testing

Run deterministic checks without contacting PagerDuty or Notion:

```sh
npm run check
npm test
npm run build
```

To test locally against a safe PagerDuty account, use the gitignored environment
file:

```sh
cp .env.example .env
# Add PAGERDUTY_API_TOKEN and any optional region or scope values to .env.
ntn workers exec incidentsSync --local
```

## Learn more

- [Notion sync guide](https://developers.notion.com/workers/guides/syncs)
- [PagerDuty REST API reference](https://developer.pagerduty.com/api-reference/)
- [PagerDuty API access keys](https://support.pagerduty.com/main/docs/api-access-keys)
- [PagerDuty service regions](https://support.pagerduty.com/main/docs/service-regions)
- [PagerDuty REST API rate limits](https://support.pagerduty.com/main/docs/rest-api-rate-limits)
- [Contributing guide](../../CONTRIBUTING.md)
