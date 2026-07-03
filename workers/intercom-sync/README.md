# Worker sync: Intercom

Turn Intercom into a connected support workspace in Notion. One deploy creates
four related databases—**Companies**, **Contacts**, **Conversations**, and
**Tickets**—so support and customer-success teams can triage work, spot account
risk, and understand service quality without assembling separate recipes.

The Worker only reads from Intercom. It writes to managed Notion databases;
Intercom remains the system of record, and later syncs overwrite edits to
managed properties in Notion.

## Quickstart

You need Node.js 22+, Notion CLI 0.18.1 or newer, an Intercom workspace,
and a token from a
[private Intercom app](https://developers.intercom.com/docs/build-an-integration/learn-more/authentication).
Grant only these permissions:

- **Read and list users and companies**
- **Read conversations**
- **Read admins**
- **Read tickets**—only when you intend to sync Tickets

Tickets API access also depends on your Intercom plan. If your workspace does
not use Tickets, leave `ticketsSync` paused and do not trigger
`ticketsReconciliation`. The other three databases work independently; you do
not need to edit the bundle.

### Preview locally

Install the example and preview one page from each core resource locally before
deploying. Local preview calls Intercom but never writes to Notion:

```sh
npm install --global ntn@latest
ntn --version
cd workers/intercom-sync
npm install
cp .env.example .env
# Add INTERCOM_ACCESS_TOKEN and the correct INTERCOM_REGION to .env.
ntn workers sync trigger contactsSync --local --preview
ntn workers sync trigger conversationsSync --local --preview
ntn workers sync trigger companiesSync --local --preview
```

Run the optional Ticket preview too if you intend to use Tickets. A successful
preview confirms that the private app and workspace plan can read them:

```sh
ntn workers sync trigger ticketsSync --local --preview
```

Company preview opens Intercom's single app-wide Company Scroll. `--preview`
executes one page. To inspect every preview page, rerun the command with
`--context '<nextContext>'` from the previous result until it completes. After
the last Company preview request, let its scroll expire before deployment:

```sh
sleep 65
```

### Deploy and initialize

Now deploy without cloud credentials and pause every schedule:

```sh
ntn login
ntn workers deploy --name intercom-sync
for sync in companiesSync contactsSync conversationsSync ticketsSync; do
  ntn workers sync pause "$sync"
done
ntn workers sync status --no-watch
```

Stop here unless status reports all four scheduled capabilities paused with no
active run. Then set the region before the token:

```sh
ntn workers env set INTERCOM_REGION=us
ntn workers env set INTERCOM_ACCESS_TOKEN=your-private-app-token
```

Use `eu` or `au` instead of `us` for those hosting regions. Trigger each core
backfill in dependency order and wait for it to complete before continuing.
Each status command watches the run; press Ctrl-C after it reports completion.

```sh
ntn workers sync trigger companiesSync
ntn workers sync status companiesSync
ntn workers sync trigger contactsSync
ntn workers sync status contactsSync
ntn workers sync trigger conversationsSync
ntn workers sync status conversationsSync
```

If the Ticket preview succeeded, initialize and enable Tickets too. Otherwise
leave Ticket syncing disabled:

```sh
ntn workers sync trigger ticketsSync
ntn workers sync status ticketsSync
ntn workers sync resume ticketsSync
```

Finally, enable the core schedules:

```sh
for sync in companiesSync contactsSync conversationsSync; do
  ntn workers sync resume "$sync"
done
```

These first runs backfill every Company, Contact, and Conversation visible to
the private app and returned by these APIs. The optional Ticket run does the
same for Tickets.

Notion creates and manages all four databases; you do not provide a Notion API
token. New Conversation and Ticket changes inside the one-minute consistency
buffer arrive on the next five-minute cycle.

### Redeploy safely

Use `--name intercom-sync` only for the first deployment. Before redeploying an
existing credentialed Worker, pause every capability that is scheduled or
running and wait for status to show no active run because stored credentials
survive deployments. Older versions also scheduled both reconciliation keys,
so pause those while upgrading. If a Company run did not finish successfully,
wait another 65 seconds before redeploying so its Intercom scroll expires.

Then update the existing Worker:

```sh
ntn workers deploy
```

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
| `conversationsSync`           | Conversations | incremental | 5 min    | Deliver changed Conversations quickly with a buffered, pinned window. |
| `conversationsReconciliation` | Conversations | replace     | manual   | Repair drift and remove deleted or newly hidden records.              |
| `ticketsSync`                 | Tickets       | incremental | 5 min    | Deliver changed Tickets quickly with the same overlap strategy.       |
| `ticketsReconciliation`       | Tickets       | replace     | manual   | Repair drift and remove Tickets no longer returned by Intercom.       |

Incremental searches pin their upper timestamp across every page, request and
verify ascending order by immutable Intercom ID, wait one minute for indexing,
and replay a five-minute overlap. Manual replacement is still necessary because
Intercom search cursors are not snapshots and deleted records do not appear in
search results. Conversation and Ticket replacements pin Intercom's
`total_count` and abort if it changes or the completed sweep does not match it,
so incomplete or count-drifting runs fail before replacement deletion.

Trigger the manual reconciliations when you need to repair drift or remove
deleted or newly hidden records, such as after an outage or access change.

Keep replacement and delta runs from overlapping: pause `conversationsSync` or
`ticketsSync`, use `ntn workers sync status <key>` to confirm it is idle,
trigger the matching reconciliation, wait for that run to finish, then resume
the delta. This follows the Workers backfill pattern and prevents a replacement
from deleting a newer row written by a concurrent delta.

```sh
ntn workers sync pause conversationsSync
ntn workers sync status conversationsSync
ntn workers sync trigger conversationsReconciliation
ntn workers sync status conversationsReconciliation
ntn workers sync resume conversationsSync
```

For Tickets, use `ticketsSync` and `ticketsReconciliation` in the same sequence.

Every record is keyed by Intercom's immutable API `id`. The human-facing
`ticket_id` is copied only as **Inbox Ticket ID** and is never used for API
queries.

## Data copied

- Companies: plan, industry, website, employee/user/session counts, monthly
  spend, activity, tags, segments, and timestamps.
- Contacts: identity, role, owner, email/phone, company relations, tags,
  association completeness, country, activity, and email restrictions.
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
├── pagination.ts     — bounded cursor and record-order protection
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
  Never overlap Company runs, previews, or deployments that share a private-app
  token. The Worker detects expired/repeated pages, performs at most two full
  restarts, and fails before replacement deletion if it cannot finish safely.
- Company Scroll omits Companies with no associated users.
- Companies and Contacts use hourly replacement sweeps. Notion recommends
  replacement for sources with fewer than roughly 10,000 records; above that,
  validate runtime and API load, then lower the cadence or adapt the example
  before production use.
- A Contact embeds at most ten Companies and ten Tags; those relation/tag lists
  can therefore be partial. Filter **Incomplete Associations** for affected
  Contacts before relying on either list as exhaustive.
- Ticket APIs can return `403 api_plan_restricted` when the workspace plan does
  not include them. Keep `ticketsSync` paused and do not trigger
  `ticketsReconciliation` in that case.
- Ticket requests use pages of 20 because Intercom may include large
  `ticket_parts` collections even though this example does not copy them.
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

For a live smoke test, follow the Quickstart's local-preview and paused-deploy
flow. Confirm that the Company run reaches a terminal state, Company and Contact
counts are plausible, relations resolve, and a recently updated Conversation
and optional Ticket appear after the consistency buffer. Compare a small sample
against Intercom and check **Incomplete Associations** before treating Contact
relations or tags as exhaustive.
