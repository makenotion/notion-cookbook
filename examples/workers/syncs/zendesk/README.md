# Worker Sync: Zendesk

A Notion worker that one-way syncs tickets from a [Zendesk](https://zendesk.com) account into a managed Notion database. Uses Zendesk's cursor-based incremental tickets export, so the API itself is the change feed — soft-deletes flow through to Notion automatically.

## Prerequisites

- A Notion workspace where you can install workers.
- A Zendesk account (free Zendesk Suite trials are available at <https://www.zendesk.com/register>).
- Permission to create an API token in **Admin Center → Apps and integrations → Zendesk API**.
- Node.js ≥ 22 and the [`ntn` CLI](https://developers.notion.com/workers/get-started/quickstart) installed.

## Step 1 — Clone and install

```zsh
git clone https://github.com/makenotion/notion-cookbook.git
cd notion-cookbook/examples/workers/syncs/zendesk
npm install
ntn login
```

## Step 2 — Create a Zendesk API token

1. In Zendesk, open **Admin Center → Apps and integrations → APIs → Zendesk API**.
2. Toggle **Token access** on if it isn't already.
3. Click **Add API token**, name it, and **copy the token now** — Zendesk only shows it once.

## Step 3 — Store the credentials

```zsh
ntn workers env set ZENDESK_SUBDOMAIN=<your-subdomain>     # the "acme" in acme.zendesk.com
ntn workers env set ZENDESK_EMAIL=<admin-email>
ntn workers env set ZENDESK_API_TOKEN=<api-token>
```

The Zendesk API uses HTTP Basic auth with a username of the form `<email>/token` — `zendesk.ts` handles the encoding.

## Step 4 — Deploy

```zsh
ntn workers deploy --name zendesk-sync
```

This creates a managed database titled **Zendesk Tickets** in your workspace.

## Step 5 — Verify it works

The sync runs every 15 minutes. To kick it off immediately:

```zsh
ntn workers sync trigger ticketsSync
```

The first cycle walks the entire ticket history (one page at a time, ~1000 tickets per page) until it catches up to the present. Watch its progress:

```zsh
ntn workers sync status
```

Then open the **Zendesk Tickets** database to confirm rows appear.

## How the code is organized

- `src/index.ts` — Worker entry. Declares the managed database, a conservative pacer (Zendesk allows ~10 req/min per token), and a single incremental sync.
- `src/zendesk.ts` — Calls the cursor-based incremental tickets endpoint. Builds the HTTP Basic auth header from `ZENDESK_EMAIL` and `ZENDESK_API_TOKEN`.
- `src/mapping.ts` — `ticketToChange` maps each ticket to a Notion change record, switching to `{ type: "delete" }` when the ticket's status is `"deleted"`.
- `src/types.ts` — `ZdTicket` (the subset of fields we read) and `ZdIncrementalResponse` (the cursor envelope).

The sync state is just `{ cursor: string | null }`. The first call passes `start_time=0` (Unix epoch); after that, each response's `after_cursor` becomes the next call's `cursor`.

## Customizing

- **Add a custom field** — Zendesk returns custom fields as `[{ id, value }]`. See the commented example block in `mapping.ts` for the lookup pattern. Add a matching `Schema.richText()` entry to the schema in `index.ts`.
- **Resolve requester/assignee names** — the incremental endpoint only returns user IDs. Fetch `/api/v2/users/show_many?ids=…` in batches and stash the names in a module-scope cache.
- **Change the sync frequency** — edit `schedule: "15m"` in `index.ts` (allowed values: `5m`, `15m`, `1h`, `1d`).
- **Filter out deleted tickets entirely** — add `exclude_deleted=true` to the URL params in `fetchIncrementalTickets` (you'll lose delete propagation but reduce noise on accounts with many archived tickets).

## Troubleshooting

- **`401 Unauthorized`** — confirm `ZENDESK_EMAIL/token` matches an admin user and the API token hasn't been revoked.
- **`Sub-domain not found`** — `ZENDESK_SUBDOMAIN` should be just the prefix (e.g. `acme`), not the full URL.
- **The first run takes a long time** — expected for accounts with many years of tickets. The cursor advances ~1000 tickets per page; subsequent runs only process new/updated tickets.
- **Tickets disappear from Notion without explanation** — Zendesk soft-deletes propagate as Notion deletes. Toggle `exclude_deleted=true` (see Customizing) if you'd rather keep them.

## Learn more

- [Notion Workers documentation](https://developers.notion.com/workers/get-started/overview)
- [Syncs guide](https://developers.notion.com/workers/guides/syncs)
- [Zendesk Cursor-Based Incremental Exports](https://developer.zendesk.com/api-reference/ticketing/ticket-management/incremental_exports/)
- [Contribute to this cookbook](../../../../CONTRIBUTING.md)
