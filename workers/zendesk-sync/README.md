# Worker sync: Zendesk

Bring your support operation into Notion so teams and agents can investigate
queue health, customer feedback, response performance, and SLA targets without
leaving the workspace. One deploy creates six managed databases and keeps them
updated from Zendesk automatically.

You do not need to build the Notion databases or supply a Notion API token. The
worker declares their schemas, and Notion creates and manages them for you.

## Quickstart

The default worker needs Zendesk Support Professional or Suite Growth (or
higher), the updated CSAT experience, and an admin API user. If your account
does not include CSAT or SLA APIs, see [Zendesk plan compatibility](#zendesk-plan-compatibility).

Create a [Zendesk API token](#zendesk-api-token), then, from the repository
root, install the worker, connect your workspace, and deploy:

```sh
npm install --global ntn
cd workers/zendesk-sync
npm install
ntn login
ntn workers deploy --name zendesk-sync
```

Configure the deployed worker:

```sh
ntn workers env set ZENDESK_SUBDOMAIN=acme
ntn workers env set ZENDESK_API_TOKEN=your-api-token
ntn workers env set ZENDESK_API_USER_EMAIL=agent@example.com
```

Preview the ticket sync without changing Notion. Then populate Organizations
and Users before Tickets so the first ticket pass can resolve its relation
targets:

```sh
ntn workers sync trigger ticketsSync --preview
ntn workers sync trigger organizationsSync
ntn workers sync trigger usersSync
ntn workers sync trigger ticketsSync
```

The other three databases populate on their schedules, or you can
[trigger them manually](#triggering-syncs-manually).

These databases can contain ticket descriptions, organization notes, user
emails and phone numbers, and CSAT feedback. Review their Notion sharing
settings before giving a broader audience access.

## What this helps you answer

| Managed database              | Example questions                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| Support Tickets               | Which urgent tickets are still open? Who owns them? Which channels or organizations drive volume?  |
| Zendesk Organizations         | How are customer accounts tagged? Which organization records changed recently?                     |
| Zendesk Users                 | Who are the agents and admins? Which users are suspended or have not logged in recently?           |
| Zendesk CSAT Survey Responses | Which responses have bad ratings? What feedback are customers sharing?                             |
| Zendesk Ticket Metrics        | Which tickets have slow first replies or resolutions? Which are reopened or require many handoffs? |
| Zendesk SLA Policies          | What are the first-reply and resolution targets for each priority? How do policies differ?         |

## Reference

### Zendesk plan compatibility

To populate all six databases as written, use Zendesk Support Professional or
higher, or Zendesk Suite Growth or higher, with the updated CSAT experience
enabled and an admin API user with API token access. Accounts that do not meet
this configuration can still use the core ticket, organization, user, and
ticket-metric syncs after removing the CSAT and SLA sync registrations.

### Synced databases

| Database                          | Zendesk resource           | Schedule                    | Plan                                 |
| --------------------------------- | -------------------------- | --------------------------- | ------------------------------------ |
| **Support Tickets**               | Tickets                    | Every 5 min + manual repair | All                                  |
| **Zendesk Organizations**         | Organizations              | Every 5 min                 | All                                  |
| **Zendesk Users**                 | Users (agents + end-users) | Every 5 min                 | All                                  |
| **Zendesk CSAT Survey Responses** | CSAT Survey Responses      | Daily                       | Support Professional / Suite Growth+ |
| **Zendesk Ticket Metrics**        | Ticket Metrics             | Every 5 min + manual repair | All                                  |
| **Zendesk SLA Policies**          | SLA Policies               | Daily                       | Support Professional / Suite Growth+ |

#### Support Tickets

| Notion property     | Zendesk field             | Type        |
| ------------------- | ------------------------- | ----------- |
| Subject             | `subject`                 | title       |
| Status              | `status`                  | select      |
| Priority            | `priority`                | select      |
| Assignee            | agent name (resolved)     | richText    |
| Assignee Record     | `assignee_id`             | relation    |
| Group               | group name (resolved)     | richText    |
| Ticket link         | clickable link to ticket  | url         |
| Updated at          | `updated_at`              | date        |
| Requester           | requester name (resolved) | richText    |
| Requester Record    | `requester_id`            | relation    |
| Organization        | org name (resolved)       | richText    |
| Organization Record | `organization_id`         | relation    |
| Type                | `type`                    | select      |
| Channel             | `via.channel`             | select      |
| Tags                | `tags`                    | multiSelect |
| Created at          | `created_at`              | date        |
| Ticket ID           | `id`                      | richText    |

Each page body contains the ticket description. Assignee, requester, group,
and organization show real names (resolved via Zendesk's
[sideloading](https://developer.zendesk.com/api-reference/introduction/side-loading/),
with no extra API calls). The incremental export includes archived tickets and
uses `support_type_scope=all`, so both human-agent and AI-agent tickets are
included.

#### Zendesk Organizations

| Notion property | Zendesk field  | Type        |
| --------------- | -------------- | ----------- |
| Name            | `name`         | title       |
| Domains         | `domain_names` | richText    |
| Tags            | `tags`         | multiSelect |
| Details         | `details`      | richText    |
| Updated at      | `updated_at`   | date        |
| Org ID          | `id`           | richText    |
| Created at      | `created_at`   | date        |

Page body contains the organization's `notes` field.

#### Zendesk Users

| Notion property     | Zendesk field     | Type        |
| ------------------- | ----------------- | ----------- |
| Name                | `name`            | title       |
| Role                | `role`            | select      |
| Email               | `email`           | email       |
| Last login          | `last_login_at`   | date        |
| Tags                | `tags`            | multiSelect |
| Updated at          | `updated_at`      | date        |
| Organization ID     | `organization_id` | richText    |
| Organization Record | `organization_id` | relation    |
| Phone               | `phone`           | richText    |
| Suspended           | `suspended`       | checkbox    |
| User ID             | `id`              | richText    |
| Created at          | `created_at`      | date        |

#### Zendesk CSAT Survey Responses

| Notion property  | Zendesk field                               | Type     |
| ---------------- | ------------------------------------------- | -------- |
| Response         | ticket ID or response ID (derived)          | title    |
| Rating           | customer-satisfaction `rating_scale` answer | number   |
| Rating category  | `rating_category`                           | select   |
| Feedback         | non-empty `open_ended` answers              | richText |
| Subject          | `subjects[0].zrn`                           | richText |
| Ticket ID        | ticket subject `id`                         | richText |
| Ticket Record    | ticket subject `id`                         | relation |
| Responder ID     | `responder_id`                              | richText |
| Responder Record | `responder_id`                              | relation |
| Survey ID        | `survey.id`                                 | richText |
| Survey version   | `survey.version`                            | number   |
| Survey state     | `survey.state`                              | select   |
| Updated at       | latest answer `updated_at`                  | date     |
| Expires at       | `expires_at`                                | date     |
| Response ID      | `id`                                        | richText |

This database uses Zendesk's current CSAT Survey Responses API. Open-ended
feedback is also copied into the page body. It uses a daily replace sweep so
answers edited after the response was first offered are refreshed correctly.

#### Zendesk Ticket Metrics

| Notion property        | Zendesk field                         | Type     |
| ---------------------- | ------------------------------------- | -------- |
| Ticket ID              | `ticket_id`                           | title    |
| Ticket Record          | `ticket_id`                           | relation |
| First Reply (min)      | `reply_time_in_minutes.calendar`      | number   |
| Full Resolution (min)  | `full_resolution_time_in_minutes`     | number   |
| Reopens                | `reopens`                             | number   |
| Agents Touched         | `assignee_stations`                   | number   |
| Groups Touched         | `group_stations`                      | number   |
| Solved at              | `solved_at`                           | date     |
| First Resolution (min) | `first_resolution_time_in_minutes`    | number   |
| Replies                | `replies`                             | number   |
| On Hold (min)          | `on_hold_time_in_minutes.calendar`    | number   |
| Agent Wait (min)       | `agent_wait_time_in_minutes.calendar` | number   |
| Requester Wait (min)   | `requester_wait_time_in_minutes`      | number   |
| Updated at             | `updated_at`                          | date     |
| Created at             | `created_at`                          | date     |

Times use calendar minutes by default. To switch to business hours, change
`.calendar` to `.business` in `src/ticket-metrics.ts`.

#### Zendesk SLA Policies

| Notion property          | Zendesk field                | Type     |
| ------------------------ | ---------------------------- | -------- |
| Title                    | `title`                      | title    |
| Urgent First Reply (min) | `policy_metrics` (flattened) | number   |
| High First Reply (min)   | `policy_metrics` (flattened) | number   |
| Normal First Reply (min) | `policy_metrics` (flattened) | number   |
| Low First Reply (min)    | `policy_metrics` (flattened) | number   |
| Position                 | `position`                   | number   |
| Urgent Resolution (min)  | `policy_metrics` (flattened) | number   |
| High Resolution (min)    | `policy_metrics` (flattened) | number   |
| Normal Resolution (min)  | `policy_metrics` (flattened) | number   |
| Low Resolution (min)     | `policy_metrics` (flattened) | number   |
| Policy ID                | `id`                         | richText |
| Updated at               | `updated_at`                 | date     |
| Created at               | `created_at`                 | date     |

SLA targets are flattened from the `policy_metrics` array into individual
columns by priority level, so managers can compare targets at a glance.
Page body contains the policy description.

### Relations and clearing behavior

Relations use immutable Zendesk IDs while keeping readable name and ID columns.
Tickets link to users and organizations; users link to organizations; CSAT
responses link to tickets and responders; and metrics link to tickets.
Relations are two-way; SLA policies remain standalone.

Every transform emits every declared property. Missing nullable values are sent
as explicit empty values so stale Notion properties and CSAT page content clear.

### Project structure

```text
src/
├── index.ts                 — registers all databases and syncs
├── zendesk.ts               — API client (auth, pagination, types for all resources)
├── tickets.ts               — ticket schema + transform
├── formatters.ts            — shared date and label formatting helpers
├── organizations.ts         — organization schema + transform
├── users.ts                 — user schema + transform
├── survey-responses.ts      — current CSAT response schema + transform
├── ticket-metrics.ts        — ticket metric schema + transform
└── sla-policies.ts          — SLA policy schema + transform
```

### How it works

1. Tickets and ticket metrics sync incrementally every five minutes, including
   archived records and explicit ticket deletions.
2. Manual repairs combine Search Export with an incremental tail and complete
   replacement only after the tail reaches `end_of_stream`.
3. Organizations and users use cursor-paginated list endpoints with 100 records
   per page and `mode: "replace"`.
4. CSAT survey responses use a cursor-paginated daily replace sweep. Zendesk
   exposes creation-time filters but no update-time cursor, so a full sweep
   safely catches submitted or edited answers.
5. SLA policies use Zendesk's offset pagination and refresh daily.
6. Every record uses its stable Zendesk ID as the Notion sync key, preventing
   duplicates across pages and scheduled runs.

API families are paced separately, and 429 responses honor `Retry-After`.

### Zendesk API token

1. In Zendesk, go to **Admin Center > Apps and integrations > Zendesk API**
2. Enable **Token Access** if it isn't already
3. Click **Add API token**, give it a name, and copy the token
4. Note the email address of the admin account — you'll need it for
   `ZENDESK_API_USER_EMAIL`

### Environment variables

#### Required

| Variable                 | Description                                               |
| ------------------------ | --------------------------------------------------------- |
| `ZENDESK_SUBDOMAIN`      | Your Zendesk subdomain (e.g. `acme` for acme.zendesk.com) |
| `ZENDESK_API_TOKEN`      | Zendesk API token (from Admin Center)                     |
| `ZENDESK_API_USER_EMAIL` | Email of the Zendesk user associated with the API token   |

#### Optional

| Variable                | Default             | Description                          |
| ----------------------- | ------------------- | ------------------------------------ |
| `ZENDESK_SYNC_DB_TITLE` | `"Support Tickets"` | Title of the tickets Notion database |

Alternatively, you can set `ZENDESK_BASIC_AUTH_TOKEN` (a base64-encoded
`email:password` string) instead of `ZENDESK_API_TOKEN` + `ZENDESK_API_USER_EMAIL`.

No `NOTION_API_TOKEN` is needed — the platform handles Notion credentials
automatically.

### Triggering syncs manually

```sh
ntn workers sync trigger organizationsSync
ntn workers sync trigger usersSync
ntn workers sync trigger ticketsSync
ntn workers sync trigger surveyResponsesSync
ntn workers sync trigger ticketMetricsSync
ntn workers sync trigger slaPoliciesSync
```

SLA Policies refreshes daily, but it can also be triggered manually after a
policy change.

Repairs are manual because replace mode deletes unseen keys and must not overlap
the incremental syncs. After upgrading, run this once to backfill relations and
clear stale nullable values: pause both incrementals and wait for in-flight runs
to finish, then reset and trigger both repairs. Resume only after `sync status`
reports completion:

```sh
ntn workers sync pause ticketsSync
ntn workers sync pause ticketMetricsSync
ntn workers sync status

ntn workers sync state reset ticketsReconciliationSync
ntn workers sync state reset ticketMetricsReconciliationSync
ntn workers sync trigger ticketsReconciliationSync
ntn workers sync trigger ticketMetricsReconciliationSync
ntn workers sync status

ntn workers sync resume ticketsSync
ntn workers sync resume ticketMetricsSync
```

### Adapting the schema

Each synced resource has a file containing its schema and transform function.
To change which fields are synced for a resource, edit that resource's file:

| Resource              | File                      |
| --------------------- | ------------------------- |
| Tickets               | `src/tickets.ts`          |
| Organizations         | `src/organizations.ts`    |
| Users                 | `src/users.ts`            |
| CSAT Survey Responses | `src/survey-responses.ts` |
| Ticket Metrics        | `src/ticket-metrics.ts`   |
| SLA Policies          | `src/sla-policies.ts`     |

To add a new Zendesk field to any resource:

1. Add the field to the resource's type in `src/zendesk.ts`
2. Add a property to the schema with the appropriate `Schema.*` type
3. Add a `Builder.*` call in the transform function

Keep every schema property in its transform, using `[]` for missing nullable
values. Do not remove `PRIMARY_KEY` or the stable-ID relations.

### Incremental history and repairs

Tickets and ticket metrics already use Zendesk's cursor-based incremental
export. The initial request sends `start_time=1` as Unix epoch seconds. Every
later page and scheduled run sends the prior `after_cursor`; `end_of_stream`
ends the current cycle without discarding that checkpoint. Do not replace this
with an ISO timestamp or restart from `start_time` on every schedule—both can
skip or repeatedly export data.

Deleted tickets remain in Zendesk's export for a limited retention window. The
worker converts `status: "deleted"` records to explicit Notion deletes. Resetting
the sync state starts a new retained-history backfill:

```sh
ntn workers sync state reset ticketsSync
ntn workers sync state reset ticketMetricsSync
```

Search Export cursors expire after one hour. Incomplete repairs do not commit
replacement deletions; reset and trigger the repair again.

### Local testing

Run deterministic checks without contacting Zendesk or Notion:

```sh
npm run check
npm test
npm run build
```

Test a specific sync locally against a real Zendesk instance:

```sh
ntn workers exec ticketsSync --local
ntn workers exec organizationsSync --local
```

## Learn more

- [Notion Workers documentation](https://developers.notion.com/docs/workers)
- [Zendesk API — Tickets](https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/)
- [Zendesk API — Search Export](https://developer.zendesk.com/api-reference/ticketing/ticket-management/search/#export-search-results)
- [Zendesk API — Organizations](https://developer.zendesk.com/api-reference/ticketing/organizations/organizations/)
- [Zendesk API — Users](https://developer.zendesk.com/api-reference/ticketing/users/users/)
- [Zendesk API — CSAT Survey Responses](https://developer.zendesk.com/api-reference/ticketing/ticket-management/csat_survey_responses/)
- [Zendesk API — Ticket Metrics](https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_metrics/)
- [Zendesk API — SLA Policies](https://developer.zendesk.com/api-reference/ticketing/business-rules/sla_policies/)
- [Contributing guide](../../CONTRIBUTING.md)
