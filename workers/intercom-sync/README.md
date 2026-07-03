# Worker sync: Intercom

Bring Intercom companies, contacts, conversations, and tickets into one
connected workspace in Notion. Use the resulting databases to review customer
context, triage support work, and spot service trends without sending every
collaborator into Intercom.

The worker creates and maintains all four databases for you. Companies and
contacts refresh every hour. Conversation and ticket changes arrive every five
minutes, with an automatic daily refresh to repair drift and remove records
that are no longer visible.

## Quickstart

You need Node.js 22+, an Intercom workspace, and a
[private-app access token](#intercom-access-and-credentials). Give the app these
permissions:

- **Read and list users and companies**
- **Read conversations**
- **Read admins**
- **Read tickets**, if your Intercom plan includes Tickets

From the repository root:

```sh
npm install --global ntn@latest
cd workers/intercom-sync
npm install
ntn login
ntn workers deploy --name intercom-sync
ntn workers env set INTERCOM_REGION=us
ntn workers env set INTERCOM_ACCESS_TOKEN=your-private-app-token
```

Use `eu` or `au` instead of `us` when that is where Intercom hosts your data.
The schedules start automatically after deployment; no recurring CLI action is
required.

The synced records can include contact details and selected support content.
Review the managed databases' Notion sharing settings before giving them a
broader audience.

## What you can answer

| Managed database  | Questions it helps answer                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Companies**     | Which high-spend or high-usage accounts have gone quiet? Which segments are generating the most conversations, and which contacts belong to each account?                                         |
| **Contacts**      | Which users or leads need follow-up based on when they were last seen, contacted, or replied? Who owns them, and who is unsubscribed, marked as spam, or hard bounced?                            |
| **Conversations** | Which open, unread, or priority conversations have waited longest, missed SLA, or lack an assignee? Which teams and channels have slow replies, low ratings, repeated reopens, or AI escalations? |
| **Tickets**       | Which open tickets are unassigned, waiting on a customer, or ready for follow-up after snoozing? How is the queue distributed by team, ticket type, and category?                                 |

## Reference

### Synced databases and schedules

| Database          | Intercom resource | Schedule                         |
| ----------------- | ----------------- | -------------------------------- |
| **Companies**     | Companies         | Full refresh every hour          |
| **Contacts**      | Contacts          | Full refresh every hour          |
| **Conversations** | Conversations     | Changes every 5 min + daily full |
| **Tickets**       | Tickets           | Changes every 5 min + daily full |

#### Companies

| Notion property     | Intercom field or meaning         | Type        |
| ------------------- | --------------------------------- | ----------- |
| Name                | `name`                            | title       |
| Plan                | `plan.name`                       | select      |
| Industry            | `industry`                        | select      |
| Website             | `website`                         | url         |
| Employees           | `size`                            | number      |
| Users               | `user_count`                      | number      |
| Sessions            | `session_count`                   | number      |
| Monthly Spend       | `monthly_spend`                   | number      |
| Last Active         | `last_request_at`                 | date        |
| Tags                | `tags.tags[].name`                | multiSelect |
| Segments            | `segments.segments[].name`        | multiSelect |
| Updated             | `updated_at`                      | date        |
| Created             | `created_at`                      | date        |
| Created at Source   | `remote_created_at`               | date        |
| External Company ID | `company_id`                      | richText    |
| Contacts            | Related Intercom contact IDs      | relation    |
| Conversations       | Related Intercom conversation IDs | relation    |
| Company ID          | Immutable Intercom `id`           | richText    |

Intercom's Company Scroll omits companies with no associated users. Those
companies do not appear until Intercom includes them in that result.

#### Contacts

| Notion property         | Intercom field or meaning                  | Type        |
| ----------------------- | ------------------------------------------ | ----------- |
| Name                    | `name`, then an available identity field   | title       |
| Role                    | `role`                                     | select      |
| Owner                   | Admin name resolved from `owner_id`        | richText    |
| Updated                 | `updated_at`                               | date        |
| Email                   | `email`                                    | email       |
| Phone                   | `phone`                                    | phoneNumber |
| Companies               | `companies.data[].id`                      | relation    |
| Country                 | `location.country`                         | select      |
| Tags                    | `tags.data[].name`                         | multiSelect |
| Incomplete Associations | Companies or Tags when the list is partial | multiSelect |
| Last Seen               | `last_seen_at`                             | date        |
| Signed Up               | `signed_up_at`                             | date        |
| Last Contacted          | `last_contacted_at`                        | date        |
| Last Replied            | `last_replied_at`                          | date        |
| Email Restrictions      | Unsubscribe, spam, and bounce flags        | multiSelect |
| Created                 | `created_at`                               | date        |
| External ID             | `external_id`                              | richText    |
| Conversations           | Related Intercom conversation IDs          | relation    |
| Tickets                 | Related Intercom ticket IDs                | relation    |
| Contact ID              | Immutable Intercom `id`                    | richText    |

Intercom embeds at most ten companies and ten tags in a Contact result. When
more exist, **Incomplete Associations** identifies the list that may be
partial.

#### Conversations

| Notion property     | Intercom field or meaning                            | Type        |
| ------------------- | ---------------------------------------------------- | ----------- |
| Title               | `title`, subject, or opening-message fallback        | title       |
| State               | `state`                                              | select      |
| Priority            | `priority`                                           | checkbox    |
| Unread              | Inverse of `read`                                    | checkbox    |
| Contacts            | `contacts.contacts[].id`                             | relation    |
| Assignee            | Admin name resolved from `admin_assignee_id`         | richText    |
| Team                | Team name resolved from `team_assignee_id`           | richText    |
| Updated             | `updated_at`                                         | date        |
| Waiting Since       | `waiting_since`                                      | date        |
| Channel             | `source.type`                                        | select      |
| Tags                | `tags.tags[].name`                                   | multiSelect |
| SLA Status          | `sla_applied.sla_status`                             | select      |
| Rating              | `conversation_rating.rating`                         | number      |
| Company             | `company.id`                                         | relation    |
| First Reply (min)   | `statistics.time_to_admin_reply`, converted to min   | number      |
| Median Reply (min)  | `statistics.median_time_to_reply`, converted to min  | number      |
| Handling Time (min) | Adjusted or standard handling time, converted to min | number      |
| Last Contact Reply  | `statistics.last_contact_reply_at`                   | date        |
| Reopens             | `statistics.count_reopens`                           | number      |
| AI Resolution       | `ai_agent.resolution_state`                          | select      |
| Snoozed Until       | `snoozed_until`                                      | date        |
| Created             | `created_at`                                         | date        |
| Conversation ID     | Immutable Intercom `id`                              | richText    |

Each page body contains the sanitized opening message and customer rating
comment when available. It does not copy the full transcript, attachments, or
internal notes.

#### Tickets

| Notion property      | Intercom field or meaning                    | Type     |
| -------------------- | -------------------------------------------- | -------- |
| Title                | Default title, then ticket type and number   | title    |
| State                | Internal or external ticket-state label      | select   |
| State Category       | `ticket_state.category`                      | select   |
| Ticket Type          | `ticket_type.name`                           | select   |
| Category             | `category`                                   | select   |
| Contacts             | `contacts.contacts[].id`                     | relation |
| Assignee             | Admin name resolved from `admin_assignee_id` | richText |
| Team                 | Team name resolved from `team_assignee_id`   | richText |
| Updated              | `updated_at`                                 | date     |
| Open                 | `open`                                       | checkbox |
| Snoozed Until        | `snoozed_until`                              | date     |
| Shared with Customer | `is_shared`                                  | checkbox |
| Created              | `created_at`                                 | date     |
| Inbox Ticket ID      | Human-facing `ticket_id`                     | richText |
| Ticket ID            | Immutable Intercom `id`                      | richText |

Each page body contains only the sanitized default Ticket description.
Arbitrary custom attributes and Ticket parts are not copied.

### Project structure

```text
src/
├── index.ts          — registers the databases and schedules
├── intercom.ts       — regional API client and Intercom types
├── pagination.ts     — shared cursor and ordering safeguards
├── companies.ts      — Company schema, transform, and sync
├── contacts.ts       — Contact schema, transform, and sync
├── conversations.ts  — Conversation schema, transform, and syncs
├── tickets.ts        — Ticket schema, transform, and syncs
└── helpers.ts        — timestamps, safe text, and formatting
```

### How it works

1. The worker creates four managed databases and connects them with relations
   based on immutable Intercom IDs.
2. Companies and contacts receive a complete refresh every hour. Records that
   Intercom no longer returns are removed after a successful refresh.
3. Conversation and ticket changes are applied every five minutes. Intercom's
   search index can lag briefly, so a very recent change may arrive on the next
   cycle.
4. An automatic daily full refresh catches missed changes and removes deleted
   or newly hidden conversations and tickets. Incomplete refreshes do not
   remove records from a partial result.

### Intercom access and credentials

1. Open Intercom's **Developer Hub**, select **Your Apps**, and click **New
   App**.
2. Name the app and select the workspace whose data you want to sync.
3. Under **Configure > Authentication**, grant the read permissions listed in
   the [Quickstart](#quickstart).
4. Copy the app's access token from the same Authentication page.

Private apps do not require OAuth or App Store review. Store the token with
`ntn workers env set`, not in source control.

### Configuration reference

| Variable                | Required | Default | Description                                     |
| ----------------------- | -------- | ------- | ----------------------------------------------- |
| `INTERCOM_ACCESS_TOKEN` | Yes      | —       | Token from one workspace's private Intercom app |
| `INTERCOM_REGION`       | No       | `us`    | Data-hosting region: `us`, `eu`, or `au`        |

No `NOTION_API_TOKEN` is needed—the Workers platform supplies Notion access.
Tickets run automatically when the plan and private app include access. If the
workspace does not use Tickets, pause those two schedules; the other databases
continue independently:

```sh
ntn workers sync pause ticketsSync
ntn workers sync pause ticketsReconciliation
```

To enable Tickets later, add **Read tickets** and resume the same two schedule
names.

### Adapting the schema

Each resource keeps its schema and transform in one file:

| Resource      | File                   |
| ------------- | ---------------------- |
| Companies     | `src/companies.ts`     |
| Contacts      | `src/contacts.ts`      |
| Conversations | `src/conversations.ts` |
| Tickets       | `src/tickets.ts`       |

To add an Intercom field:

1. Add the provider field to its narrow type in `src/intercom.ts`.
2. Add the Notion property to the resource schema and transform.
3. Update this README and add tests for present and missing values. Add custom
   attributes through an explicit allowlist.

### Local testing

Run the offline checks; they make no Intercom or Notion calls:

```sh
npm run check
npm test
npm run build
```

For an optional live preview, copy `.env.example` to `.env`, add credentials
for a test workspace, and preview one sync without writing to Notion:

```sh
ntn workers sync trigger contactsSync --local --preview
```

You can substitute `conversationsSync` or `ticketsSync`; preview Tickets only
when the plan supports them.

## Learn more

- [Notion Workers overview](https://developers.notion.com/workers/get-started/overview)
- [Intercom authentication](https://developers.intercom.com/docs/build-an-integration/learn-more/authentication)
- [Intercom regional hosts and versioning](https://developers.intercom.com/docs/build-an-integration/learn-more/rest-apis)
- [Intercom pagination](https://developers.intercom.com/docs/build-an-integration/learn-more/rest-apis/pagination)
- [Intercom Company Scroll](https://developers.intercom.com/docs/references/rest-api/api.intercom.io/Companies/scrollOverAllCompanies)
- [Contributing guide](../../CONTRIBUTING.md)
