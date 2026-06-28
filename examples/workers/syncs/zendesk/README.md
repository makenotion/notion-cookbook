# Worker sync: Zendesk

Syncs Zendesk support tickets into a managed Notion database. The worker
declares the schema; Notion auto-provisions and owns the database. Every 5
minutes the worker pages through all tickets using Zendesk's cursor-based
pagination and upserts each one by ticket ID. Tickets removed from Zendesk are
removed from the Notion database on the next full sync (`mode: "replace"`).

## Project structure

```text
src/
├── index.ts       — worker entry point; registers the database and sync
├── schema.ts      — Notion database schema (property names and types)
├── transform.ts   — maps a Zendesk ticket to a sync upsert change
└── zendesk.ts     — Zendesk API client (auth, pagination, types)
```

## How it works

1. On each sync run the worker calls the Zendesk List Tickets API
   (`/api/v2/tickets.json`) with cursor-based pagination (100 tickets per page).
2. Each ticket is mapped to an `upsert` change keyed by ticket ID.
3. The platform applies those changes to the managed database and loops until
   `hasMore` is false.

## Prerequisites

- Node >= 22, npm >= 10.9.2
- A Zendesk account with API access enabled.
- The `ntn` CLI installed and authenticated (`ntn auth login`).

## Environment variables

### Required

| Variable                 | Description                                                |
| ------------------------ | ---------------------------------------------------------- |
| `ZENDESK_SUBDOMAIN`      | Your Zendesk subdomain (e.g. `acme` for acme.zendesk.com) |
| `ZENDESK_API_TOKEN`      | Zendesk API token                                          |
| `ZENDESK_API_USER_EMAIL` | Email of the Zendesk user associated with the API token    |

### Optional

| Variable                 | Default              | Description                                   |
| ------------------------ | -------------------- | --------------------------------------------- |
| `ZENDESK_SYNC_DB_TITLE`  | `"Support Tickets"`  | Title of the auto-provisioned Notion database |

Alternatively, you can set `ZENDESK_BASIC_AUTH_TOKEN` (a base64-encoded
`email:password` string) instead of `ZENDESK_API_TOKEN` + `ZENDESK_API_USER_EMAIL`.

No `NOTION_API_TOKEN` is needed. The platform manages the database and handles
the Notion credentials automatically.

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

Once deployed, tickets sync automatically every 5 minutes.

## Adapting the schema

The example syncs these properties:

| Notion property | Zendesk field               | Type        |
| --------------- | --------------------------- | ----------- |
| Tickets         | `subject`                   | title       |
| Ticket ID       | `id`                        | richText    |
| Ticket link     | `id` (derived URL)          | url         |
| Type            | `type`                      | select      |
| Status          | `status`                    | select      |
| Priority        | `priority`                  | select      |
| CSAT score      | `satisfaction_rating.score` | select      |
| Feature tags    | `tags`                      | multiSelect |
| Channel         | `via.channel`               | select      |
| Assignee        | `assignee_id` (resolved)    | richText    |
| Requester       | `requester_id` (resolved)   | richText    |
| Created at      | `created_at`                | date        |

Each Notion page body is populated with the ticket `description` via
`pageContentMarkdown`, and `upstreamUpdatedAt` is set from `updated_at` for
conflict resolution.

Assignee and Requester names are resolved via Zendesk's
[sideloading](https://developer.zendesk.com/api-reference/introduction/side-loading/)
(`?include=users`), which returns user objects alongside tickets in the same API
call with no extra requests. If a user ID is missing from the sideloaded data,
the numeric ID is used as a fallback.

To change the schema, edit two files:

**`src/schema.ts`** — declares the Notion database properties. Each key is a
property name; the value is a Schema factory call. Supported types include
`Schema.title()`, `Schema.richText()`, `Schema.email()`, `Schema.date()`,
`Schema.select([...])`, `Schema.multiSelect([...])`, `Schema.number()`,
`Schema.url()`, and `Schema.checkbox()`.

**`src/transform.ts`** — maps a Zendesk ticket to a sync change. Add or remove
`Builder.*` calls to match your schema. Optional properties should be spread
conditionally so they are omitted (not set to empty) when the source field is
absent.

## Incremental syncs

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
