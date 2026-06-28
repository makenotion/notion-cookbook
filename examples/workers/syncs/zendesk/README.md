# Worker sync: Zendesk

Syncs your Zendesk support tickets into a Notion database that stays
up to date automatically. Once deployed, the worker checks Zendesk every 5
minutes and creates or updates a Notion page for each ticket — with the
subject, status, priority, assignee, tags, CSAT score, and more.

You don't need to create the Notion database yourself. The worker declares the
schema and Notion creates and manages the database for you (this is called a
"managed database").

## What you get

A Notion database with one page per Zendesk ticket, including:

| Notion property | Zendesk field               | Type        |
| --------------- | --------------------------- | ----------- |
| Subject         | `subject`                   | title       |
| Ticket ID       | `id`                        | richText    |
| Ticket link     | clickable link to ticket    | url         |
| Type            | `type`                      | select      |
| Status          | `status`                    | select      |
| Priority        | `priority`                  | select      |
| CSAT score      | `satisfaction_rating.score` | select      |
| Tags            | `tags`                      | multiSelect |
| Channel         | `via.channel`               | select      |
| Assignee        | agent name (resolved)       | richText    |
| Requester       | requester name (resolved)   | richText    |
| Created at      | `created_at`                | date        |
| Updated at      | `updated_at`                | date        |

Each page body contains the ticket description. Assignee and requester show
real names (resolved via Zendesk's
[sideloading](https://developer.zendesk.com/api-reference/introduction/side-loading/),
with no extra API calls). Tags are synced as-is from Zendesk — the multiSelect
options are created automatically as new tags appear.

## Project structure

```text
src/
├── index.ts       — worker entry point; registers the database and sync
├── schema.ts      — Notion database schema (property names and types)
├── transform.ts   — maps a Zendesk ticket to a sync upsert change
└── zendesk.ts     — Zendesk API client (auth, pagination, types)
```

## How it works

1. Every 5 minutes (or on manual trigger), the worker calls the Zendesk List
   Tickets API with cursor-based pagination (100 tickets per page).
2. Each ticket is converted to an `upsert` — a create-or-update operation keyed
   by ticket ID, so the same ticket is never duplicated.
3. The platform applies the changes to the managed database and loops until all
   pages have been fetched.
4. Because the sync uses `mode: "replace"`, tickets deleted from Zendesk are
   automatically removed from the Notion database on the next full sync.

## Prerequisites

- Node >= 22, npm >= 10.9.2
- A Zendesk account with API access enabled
- The `ntn` CLI installed and authenticated (`ntn auth login`)

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
| `ZENDESK_SYNC_DB_TITLE`  | `"Support Tickets"`  | Title of the auto-provisioned Notion database |

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
   ```

8. Run a real sync:

   ```sh
   ntn workers sync trigger ticketsSync
   ```

Once deployed, tickets sync automatically every 5 minutes. A "Support Tickets"
database will appear in your Notion workspace after the first sync.

## Adapting the schema

To change which fields are synced, edit two files:

**`src/schema.ts`** — declares the Notion database properties. Each key is a
property name; the value is a Schema factory call (`Schema.title()`,
`Schema.richText()`, `Schema.select([...])`, `Schema.multiSelect([...])`,
`Schema.date()`, `Schema.number()`, `Schema.url()`, `Schema.email()`,
`Schema.checkbox()`). The `PRIMARY_KEY` property is used by the platform to
match incoming data to existing pages — don't remove it.

**`src/transform.ts`** — maps a Zendesk ticket object to a sync change. Add or
remove `Builder.*` calls to match your schema. Optional properties should be
spread conditionally so they are omitted (not set to empty) when the source
field is absent.

## Incremental syncs for large instances

`mode: "replace"` re-syncs all tickets on every run. For large Zendesk
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

Incremental mode also supports `type: "delete"` changes for tickets that have
been permanently deleted from Zendesk.

## Local testing

Run offline tests (no Zendesk connection needed):

```sh
npm test
```

Test the worker locally against a real Zendesk instance:

```sh
ntn workers exec ticketsSync --local
```

## Learn more

- [Notion Workers documentation](https://developers.notion.com/docs/workers)
- [Zendesk API — List Tickets](https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/#list-tickets)
- [Contributing guide](../../../../CONTRIBUTING.md)
