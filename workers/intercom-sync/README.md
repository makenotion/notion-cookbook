# Worker sync: Intercom

Turn Intercom into a connected support workspace in Notion. One deploy creates
four related databases—**Companies**, **Contacts**, **Conversations**, and
**Tickets**—so support and customer-success teams can triage work, spot account
risk, and understand service quality without assembling separate recipes.

The sync is read-only. Intercom remains the system of record, and later syncs
overwrite edits to managed properties in Notion.

## Quickstart

You need Node.js 22+, an Intercom workspace, and a token from a
[private Intercom app](https://developers.intercom.com/docs/build-an-integration/learn-more/authentication).
Grant only these permissions:

- **Read and list users and companies**
- **Read tags**
- **Read conversations**
- **Read admins**
- **Read tickets**

Tickets API access also depends on your Intercom plan. If your workspace does
not use Tickets, remove the clearly labeled Tickets import, database, and sync
blocks from `src/index.ts`; the other three databases work independently.

From the repository root:

```sh
npm install --global ntn
cd workers/intercom-sync
npm install
ntn login
ntn workers deploy --name intercom-sync
ntn workers env set INTERCOM_ACCESS_TOKEN=your-private-app-token
```

US-hosted workspaces need no region setting. For EU or Australia hosting, add
one of:

```sh
ntn workers env set INTERCOM_REGION=eu
ntn workers env set INTERCOM_REGION=au
```

Preview in dependency order, then remove `--preview` to write to Notion:

```sh
ntn workers sync trigger companiesSync --preview
ntn workers sync trigger contactsSync --preview
ntn workers sync trigger conversationsSync --preview
ntn workers sync trigger ticketsSync --preview
```

Notion creates and manages the databases; you do not provide a Notion API
token. The first runs backfill all records visible to the private app. New
Conversation and Ticket changes inside the one-minute consistency buffer arrive
on the next scheduled cycle.

## What you get

| Database          | Useful questions                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Companies**     | Which accounts are active, high-usage, high-spend, or in a key segment? What support work and contacts belong to each account?                       |
| **Contacts**      | Who are our users and leads, who owns them, and who is inactive or cannot receive email? Which companies, conversations, and tickets relate to them? |
| **Conversations** | Which open, unread, or priority conversations are waiting? Where are reply time, handling time, reopen, SLA, CSAT, or AI-resolution signals weak?    |
| **Tickets**       | Which structured requests are open, waiting on a customer, snoozed, or unassigned? Which customer and teammate own the next step?                    |

Relations connect Companies to Contacts and Conversations, and Contacts to
Conversations and Tickets. Each related property is visible from both sides.

## Sync behavior

| Capability                    | Database      | Mode        | Schedule | Why it exists                                                         |
| ----------------------------- | ------------- | ----------- | -------- | --------------------------------------------------------------------- |
| `companiesSync`               | Companies     | replace     | hourly   | Refresh the canonical Company scroll and remove missing records.      |
| `contactsSync`                | Contacts      | replace     | hourly   | Avoid unsafe day-granularity Contact timestamp cursors.               |
| `conversationsSync`           | Conversations | incremental | 2 min    | Deliver changed Conversations quickly with a buffered, pinned window. |
| `conversationsReconciliation` | Conversations | replace     | daily    | Repair drift and remove deleted or newly hidden records.              |
| `ticketsSync`                 | Tickets       | incremental | 2 min    | Deliver changed Tickets quickly with the same overlap strategy.       |
| `ticketsReconciliation`       | Tickets       | replace     | daily    | Repair drift and remove Tickets no longer returned by Intercom.       |

Incremental searches pin their upper timestamp across every page, sort by
immutable Intercom ID, wait one minute for indexing, and replay a five-minute
overlap. Daily replacement is still necessary because Intercom search cursors
are not snapshots and deleted records do not appear in search results. Ticket
replacement also aborts if Intercom's `total_count` changes or the completed
sweep does not match it, preventing an incomplete run from removing Notion
rows.

Every record is keyed by Intercom's immutable API `id`. The human-facing
`ticket_id` is copied only as **Inbox Ticket ID** and is never used for API
queries.

## Data copied

- Companies: plan, industry, website, employee/user/session counts, monthly
  spend, activity, tags, segments, and timestamps.
- Contacts: identity, role, owner, email/phone, company relations, tags,
  country, activity, and email restrictions.
- Conversations: state, priority, contacts/company, assignment, channel, tags,
  SLA, CSAT, first/median reply time, handling time, last reply, reopens, and AI
  resolution. The page body contains a sanitized opening message and rating
  comment when present.
- Tickets: state, type, category, contacts, assignment, visibility, snooze and
  timestamps. The page body contains only the sanitized default description.

Arbitrary custom attributes, full Conversation transcripts, Ticket parts,
attachments, internal notes, and temporary file URLs are deliberately omitted.
They vary by workspace, can expose sensitive data, or are incomplete in list
responses. Add only fields your team has reviewed and needs.

The copied data can include customer names, contact details, support messages,
and rating comments. Review the managed databases' Notion sharing settings
before granting broader access, and store the Intercom token only with
`ntn workers env set`.

## Project map and extension points

```text
src/
├── index.ts          — database registration, schedules, pacing, and caches
├── intercom.ts       — regional Intercom client, API types, and lookups
├── pagination.ts     — bounded starting_after cursor protection
├── companies.ts      — Company schema, transform, and scroll execution
├── contacts.ts       — Contact schema, transform, and replacement execution
├── conversations.ts  — Conversation schema, transform, windows, and execution
├── tickets.ts        — Ticket schema, transform, windows, and execution
└── helpers.ts        — timestamps, text sanitization, and formatting
```

For an agent extending one resource, start in that resource file: its schema,
transform, state policy, and page executor live together. Then update the API
DTO in `intercom.ts`, this README, and `test.ts`. Preserve these invariants:

- emit `[]` when an upstream nullable value clears;
- use API `id` as the key and `updated_at` as `upstreamUpdatedAt`;
- keep incremental time bounds fixed while a cursor is active;
- bound text and pagination state;
- add custom attributes through an explicit allowlist, not a generic dump.

Good extensions include selected Company/Contact/Ticket custom attributes,
webhook-triggered refreshes, or a reviewed subset of Conversation parts.
Intercom publishes no supported Company, Conversation, or Ticket Inbox deep-link
format, so this example does not invent one.

## Limitations

- Intercom permits only one active Company scroll per app, expires it after one
  idle minute, and may return the same scroll token for multiple distinct pages.
  Do not overlap manual Company runs. The Worker detects repeated pages and
  performs at most two safe restarts for expired or documented server-error
  sessions.
- Company Scroll omits Companies with no associated users.
- A Contact embeds at most ten Companies and ten Tags; those relation/tag lists
  can therefore be partial when `has_more` is true.
- Ticket APIs can return `403 api_plan_restricted` when the workspace plan does
  not include them.
- Full transcripts are not copied; Intercom caps returned Conversation/Ticket
  parts and those parts may include internal or redacted content.

See Intercom's official guides for
[regional hosts and API versioning](https://developers.intercom.com/docs/build-an-integration/learn-more/rest-apis),
[cursor behavior](https://developers.intercom.com/docs/build-an-integration/learn-more/rest-apis/pagination),
and [Company Scroll](https://developers.intercom.com/docs/references/rest-api/api.intercom.io/Companies/scrollOverAllCompanies).

## Verify

Offline checks make no Intercom or Notion calls:

```sh
npm run check
npm test
npm run build
```

For a live smoke test, preview each capability in the Quickstart order. Confirm
that Company and Contact counts are plausible, relations resolve, a recently
updated Conversation and Ticket appear after the consistency buffer, and no
unexpected message or custom-attribute content is copied. Then run without
`--preview` and compare a small sample against Intercom.
