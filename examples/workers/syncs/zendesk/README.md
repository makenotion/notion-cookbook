# Worker sync: Zendesk

Syncs your Zendesk data into Notion databases that stay up to date
automatically. One deploy gives you six synced databases covering tickets,
organizations, users, CSAT ratings, ticket metrics, and SLA policies.

You don't need to create the Notion databases yourself. The worker declares the
schemas and Notion creates and manages each database for you (these are called
"managed databases").

## What you get

| Database | Zendesk resource | Schedule | Plan |
| --- | --- | --- | --- |
| **Support Tickets** | Tickets | Every 2 min | All |
| **Zendesk Organizations** | Organizations | Every 5 min | All |
| **Zendesk Users** | Users (agents + end-users) | Every 5 min | All |
| **Zendesk CSAT Ratings** | Satisfaction Ratings | Every 5 min | Professional+ |
| **Zendesk Ticket Metrics** | Ticket Metrics | Every 5 min | All |
| **Zendesk SLA Policies** | SLA Policies | Manual trigger | Professional+ |

### Support Tickets

| Notion property | Zendesk field               | Type        |
| --------------- | --------------------------- | ----------- |
| Subject         | `subject`                   | title       |
| Status          | `status`                    | select      |
| Priority        | `priority`                  | select      |
| Assignee        | agent name (resolved)       | richText    |
| Group           | group name (resolved)       | richText    |
| Ticket link     | clickable link to ticket    | url         |
| Updated at      | `updated_at`                | date        |
| Requester       | requester name (resolved)   | richText    |
| Organization    | org name (resolved)         | richText    |
| Type            | `type`                      | select      |
| Channel         | `via.channel`               | select      |
| Tags            | `tags`                      | multiSelect |
| CSAT score      | `satisfaction_rating.score` | select      |
| Created at      | `created_at`                | date        |
| Ticket ID       | `id`                        | richText    |

Each page body contains the ticket description. Assignee, requester, group,
and organization show real names (resolved via Zendesk's
[sideloading](https://developer.zendesk.com/api-reference/introduction/side-loading/),
with no extra API calls).

### Zendesk Organizations

| Notion property | Zendesk field   | Type        |
| --------------- | --------------- | ----------- |
| Name            | `name`          | title       |
| Domains         | `domain_names`  | richText    |
| Tags            | `tags`          | multiSelect |
| Details         | `details`       | richText    |
| Updated at      | `updated_at`    | date        |
| Org ID          | `id`            | richText    |
| Created at      | `created_at`    | date        |

Page body contains the organization's `notes` field.

### Zendesk Users

| Notion property  | Zendesk field      | Type        |
| ---------------- | ------------------ | ----------- |
| Name             | `name`             | title       |
| Role             | `role`             | select      |
| Email            | `email`            | email       |
| Last login       | `last_login_at`    | date        |
| Tags             | `tags`             | multiSelect |
| Updated at       | `updated_at`       | date        |
| Organization ID  | `organization_id`  | richText    |
| Phone            | `phone`            | richText    |
| Suspended        | `suspended`        | checkbox    |
| User ID          | `id`               | richText    |
| Created at       | `created_at`       | date        |

### Zendesk CSAT Ratings

| Notion property | Zendesk field   | Type     |
| --------------- | --------------- | -------- |
| Comment         | `comment`       | title    |
| Score           | `score`         | select   |
| Ticket ID       | `ticket_id`     | richText |
| Reason          | `reason`        | richText |
| Created at      | `created_at`    | date     |
| Rating ID       | `id`            | richText |

### Zendesk Ticket Metrics

| Notion property        | Zendesk field                            | Type   |
| ---------------------- | ---------------------------------------- | ------ |
| Ticket ID              | `ticket_id`                              | title  |
| First Reply (min)      | `reply_time_in_minutes.calendar`         | number |
| Full Resolution (min)  | `full_resolution_time_in_minutes`        | number |
| Reopens                | `reopens`                                | number |
| Agents Touched         | `assignee_stations`                      | number |
| Groups Touched         | `group_stations`                         | number |
| Solved at              | `solved_at`                              | date   |
| First Resolution (min) | `first_resolution_time_in_minutes`       | number |
| Replies                | `replies`                                | number |
| On Hold (min)          | `on_hold_time_in_minutes.calendar`       | number |
| Agent Wait (min)       | `agent_wait_time_in_minutes.calendar`    | number |
| Requester Wait (min)   | `requester_wait_time_in_minutes`         | number |
| Updated at             | `updated_at`                             | date   |
| Created at             | `created_at`                             | date   |

Times use calendar minutes by default. To switch to business hours, change
`.calendar` to `.business` in `src/ticket-metrics.ts`.

### Zendesk SLA Policies

| Notion property              | Zendesk field                  | Type     |
| ---------------------------- | ------------------------------ | -------- |
| Title                        | `title`                        | title    |
| Urgent First Reply (min)     | `policy_metrics` (flattened)   | number   |
| High First Reply (min)       | `policy_metrics` (flattened)   | number   |
| Normal First Reply (min)     | `policy_metrics` (flattened)   | number   |
| Low First Reply (min)        | `policy_metrics` (flattened)   | number   |
| Position                     | `position`                     | number   |
| Urgent Resolution (min)      | `policy_metrics` (flattened)   | number   |
| High Resolution (min)        | `policy_metrics` (flattened)   | number   |
| Normal Resolution (min)      | `policy_metrics` (flattened)   | number   |
| Low Resolution (min)         | `policy_metrics` (flattened)   | number   |
| Policy ID                    | `id`                           | richText |
| Updated at                   | `updated_at`                   | date     |
| Created at                   | `created_at`                   | date     |

SLA targets are flattened from the `policy_metrics` array into individual
columns by priority level, so managers can compare targets at a glance.
Page body contains the policy description.

## Project structure

```text
src/
├── index.ts                 — registers all databases and syncs
├── zendesk.ts               — API client (auth, pagination, types for all resources)
├── schema.ts                — ticket schema
├── transform.ts             — ticket transform + shared helpers (dateOnly, formatLabel)
├── organizations.ts         — organization schema + transform
├── users.ts                 — user schema + transform
├── satisfaction-ratings.ts  — CSAT rating schema + transform
├── ticket-metrics.ts        — ticket metric schema + transform
└── sla-policies.ts          — SLA policy schema + transform
```

## How it works

1. On each sync run, the worker calls the appropriate Zendesk API endpoint
   with cursor-based pagination (100 records per page).
2. Each record is converted to an `upsert` — a create-or-update operation keyed
   by the resource ID, so the same record is never duplicated.
3. The platform applies the changes to the managed database and loops until all
   pages have been fetched.
4. Because all syncs use `mode: "replace"`, records deleted from Zendesk are
   automatically removed from the Notion database on the next full sync.

All syncs share a single rate limiter (`worker.pacer`) to stay within Zendesk's
API limits (400 requests per minute on most plans).

## Prerequisites

- Node >= 22, npm >= 10.9.2
- A Zendesk account with API access enabled
- The `ntn` CLI installed and authenticated (`ntn auth login`)

Satisfaction Ratings and SLA Policies require a Zendesk Professional+ plan.
If your plan doesn't include these features, those syncs will return errors
from the API — you can remove them from `src/index.ts` if needed.

### Getting a Zendesk API token

1. In Zendesk, go to **Admin Center > Apps and integrations > Zendesk API**
2. Enable **Token Access** if it isn't already
3. Click **Add API token**, give it a name, and copy the token
4. Note the email address of the admin account — you'll need it for
   `ZENDESK_API_USER_EMAIL`

## Environment variables

### Required

| Variable                 | Description                                                |
| ------------------------ | ---------------------------------------------------------- |
| `ZENDESK_SUBDOMAIN`      | Your Zendesk subdomain (e.g. `acme` for acme.zendesk.com) |
| `ZENDESK_API_TOKEN`      | Zendesk API token (from Admin Center)                      |
| `ZENDESK_API_USER_EMAIL` | Email of the Zendesk user associated with the API token    |

### Optional

| Variable                 | Default              | Description                                   |
| ------------------------ | -------------------- | --------------------------------------------- |
| `ZENDESK_SYNC_DB_TITLE`  | `"Support Tickets"`  | Title of the tickets Notion database          |

Alternatively, you can set `ZENDESK_BASIC_AUTH_TOKEN` (a base64-encoded
`email:password` string) instead of `ZENDESK_API_TOKEN` + `ZENDESK_API_USER_EMAIL`.

No `NOTION_API_TOKEN` is needed — the platform handles Notion credentials
automatically.

## Setup and deploy

1. Install the Notion Workers CLI:

   ```sh
   npm install -g @notionhq/ntn
   ```

2. Clone and install:

   ```sh
   cd examples/workers/syncs/zendesk
   npm install
   ```

3. Typecheck and test:

   ```sh
   npm run check
   npm test
   ```

4. Log in to Notion:

   ```sh
   ntn auth login
   ```

5. Deploy the worker:

   ```sh
   ntn workers deploy
   ```

6. Set environment variables on the deployed worker:

   ```sh
   ntn workers env set ZENDESK_SUBDOMAIN=acme
   ntn workers env set ZENDESK_API_TOKEN=your-api-token
   ntn workers env set ZENDESK_API_USER_EMAIL=agent@example.com
   ```

7. Preview a sync without writing to Notion:

   ```sh
   ntn workers sync trigger ticketsSync --preview
   ntn workers sync trigger organizationsSync --preview
   ntn workers sync trigger usersSync --preview
   ```

8. Run a real sync:

   ```sh
   ntn workers sync trigger ticketsSync
   ```

Once deployed, syncs run automatically on their configured schedules. Six
databases will appear in your Notion workspace after the first run.

## Triggering syncs manually

```sh
ntn workers sync trigger ticketsSync
ntn workers sync trigger organizationsSync
ntn workers sync trigger usersSync
ntn workers sync trigger satisfactionRatingsSync
ntn workers sync trigger ticketMetricsSync
ntn workers sync trigger slaPoliciesSync
```

SLA Policies only runs on manual trigger (it's a small, rarely-changing
dataset).

## Adapting the schema

Each resource has its own file with a schema and transform function. To change
which fields are synced for a resource, edit that resource's file:

| Resource | File |
| --- | --- |
| Tickets | `src/schema.ts` + `src/transform.ts` |
| Organizations | `src/organizations.ts` |
| Users | `src/users.ts` |
| CSAT Ratings | `src/satisfaction-ratings.ts` |
| Ticket Metrics | `src/ticket-metrics.ts` |
| SLA Policies | `src/sla-policies.ts` |

To add a new Zendesk field to any resource:

1. Add the field to the resource's type in `src/zendesk.ts`
2. Add a property to the schema with the appropriate `Schema.*` type
3. Add a `Builder.*` call in the transform function

The `PRIMARY_KEY` property is used by the platform to match incoming data to
existing pages — don't remove it.

## Incremental syncs for large instances

`mode: "replace"` re-syncs all records on every run. For large Zendesk
instances, switch to `mode: "incremental"` and filter by `updated_at`:

```ts
// In execute():
const since = state?.updatedSince ?? "1970-01-01"
const url = `...&sort_by=updated_at&sort_order=asc&start_time=${since}`
// ...
return {
  changes,
  hasMore: false,
  nextState: { updatedSince: latestUpdatedAt },
}
```

Incremental mode also supports `type: "delete"` changes for records removed
from the source.

## Local testing

Run offline tests (no Zendesk connection needed):

```sh
npm test
```

Test a specific sync locally against a real Zendesk instance:

```sh
ntn workers exec ticketsSync --local
ntn workers exec organizationsSync --local
```

## Learn more

- [Notion Workers documentation](https://developers.notion.com/docs/workers)
- [Zendesk API — Tickets](https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/)
- [Zendesk API — Organizations](https://developer.zendesk.com/api-reference/ticketing/organizations/organizations/)
- [Zendesk API — Users](https://developer.zendesk.com/api-reference/ticketing/users/users/)
- [Zendesk API — Satisfaction Ratings](https://developer.zendesk.com/api-reference/ticketing/ticket-management/satisfaction_ratings/)
- [Zendesk API — Ticket Metrics](https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_metrics/)
- [Zendesk API — SLA Policies](https://developer.zendesk.com/api-reference/ticketing/business-rules/sla_policies/)
- [Contributing guide](../../../../CONTRIBUTING.md)
