# Worker webhook: Zendesk

A Notion worker that listens for Zendesk webhook events and keeps a Notion
database in sync with your ticket activity. Each delivery creates or updates a
row for the ticket, then fetches the full comment thread from the Zendesk API
and writes it to the page body.

## How it works

1. Zendesk sends an HTTP POST to the worker's webhook URL on ticket events
   (create, update, close, etc.).
2. The worker verifies the HMAC-SHA256 signature on every delivery. It also
   rejects replayed requests whose timestamp is older than 5 minutes.
3. `parseZendeskTicket` extracts ticket fields from the payload. Flat and nested
   (`{ticket:{...}}`) shapes are both supported.
4. `enrichTicketWithComments` fetches the full comment thread and canonical
   status from the Zendesk REST API and merges them into the ticket.
5. `upsertZendeskTicket` queries the Notion database for an existing row
   matching the Zendesk Ticket ID. It updates the row if found, otherwise
   creates a new page. The page body is replaced with the formatted description
   and comment thread.

## Project structure

```text
src/
  index.ts          — re-exports registerZendeskToNotionWebhook
  webhook.ts        — registers the "zendeskToNotion" webhook handler
  constants.ts      — Notion property names and status options (edit to match your DB)
  notion.ts         — normalizeNotionDatabaseId, upsertZendeskTicket
  parse-ticket.ts   — parseZendeskTicket, formatDescriptionWithComments
  zendesk/
    types.ts        — shared TypeScript types
    config.ts       — signature verification (+ replay protection), auth helpers
    client.ts       — zendeskFetchJson (URL allowlist enforced)
    comments.ts     — fetchAllTicketComments, enrichTicketWithComments
    ticket.ts       — fetchZendeskTicket
    status.ts       — Zendesk API status → Notion Status option mapping
test.ts             — offline unit tests (no network required)
```

## Setup

### 1. Install the Notion Workers CLI

```zsh
npm install -g @notionhq/workers-cli
```

### 2. Clone and install

```zsh
git clone https://github.com/makenotion/notion-cookbook.git
cd notion-cookbook/examples/workers/webhooks/zendesk
npm install
```

### 3. Create the Notion database

Create a Notion database with the properties listed in the
[database schema](#required-notion-database-schema) table. The property names
are case-sensitive.

### 4. Connect to your workspace

```zsh
ntn login
```

### 5. Deploy

```zsh
ntn workers deploy --name zendesk
```

After deploying, copy the worker's webhook URL from the output.

### 6. Create the Zendesk webhook

In Zendesk Admin, go to **Apps and integrations > Webhooks > Create webhook**.
Set the endpoint URL to the worker's webhook URL, enable signing, and copy the
signing secret.

### 7. Set environment variables

```zsh
ntn workers env set ZENDESK_WEBHOOK_SECRET <signing-secret>
ntn workers env set ZENDESK_NOTION_DATABASE_ID <database-id-or-url>
ntn workers env set ZENDESK_API_TOKEN <api-token>
ntn workers env set ZENDESK_API_USER_EMAIL <admin-email>
```

### 8. Create a Zendesk trigger

Create a trigger in Zendesk that fires on the events you want (e.g. ticket
created, ticket updated) and calls the webhook you just created.

## Environment variables

| Variable                     | Required                  | Description                                                                                                |
| ---------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `ZENDESK_WEBHOOK_SECRET`     | Yes                       | Signing secret from the Zendesk webhook (Reveal secret).                                                   |
| `ZENDESK_NOTION_DATABASE_ID` | Yes                       | ID or URL of the Notion database to sync tickets into.                                                     |
| `ZENDESK_SUBDOMAIN`          | No                        | Zendesk subdomain (e.g. `acme` for `acme.zendesk.com`). Not needed if every payload includes `ticket_url`. |
| `ZENDESK_BASIC_AUTH_TOKEN`   | One of three              | Base64-encoded `email/token:api_token`, or `Basic <base64>`.                                               |
| `ZENDESK_AUTHORIZATION`      | One of three              | Full Authorization header value (`Basic …` or `Bearer …`).                                                 |
| `ZENDESK_API_TOKEN`          | One of three (with email) | Zendesk API token. Combine with `ZENDESK_API_USER_EMAIL`.                                                  |
| `ZENDESK_API_USER_EMAIL`     | With API token            | Admin email for API token auth.                                                                            |

Exactly one of `ZENDESK_BASIC_AUTH_TOKEN`, `ZENDESK_AUTHORIZATION`, or
`ZENDESK_API_TOKEN + ZENDESK_API_USER_EMAIL` is required to fetch comments.

## Required Notion database schema

| Property name       | Notion type | Notes                                                         |
| ------------------- | ----------- | ------------------------------------------------------------- |
| `Zendesk Ticket ID` | Title       | Used as the upsert key.                                       |
| `Subject`           | Rich text   |                                                               |
| `URL`               | URL         | Link back to the ticket in Zendesk.                           |
| `Requester`         | Rich text   | Requester email from the webhook payload.                     |
| `Status`            | Status      | Options: New, Open, Pending, On-hold, Solved, Closed.         |
| `Assignee`          | Rich text   |                                                               |
| `Description`       | Rich text   | First 2000 characters of the description (also in page body). |
| `Latest comment`    | Rich text   |                                                               |
| `Created at`        | Date        |                                                               |

Property names are case-sensitive. Edit `src/constants.ts` if your database
uses different names.

## Notes

### Signature verification and replay protection

Every delivery is verified against the HMAC-SHA256 signature that Zendesk
attaches via the `x-zendesk-webhook-signature` and
`x-zendesk-webhook-signature-timestamp` headers (per the
[Zendesk webhook verification docs](https://developer.zendesk.com/documentation/webhooks/verifying/)).

Replays are rejected: the timestamp must be within 5 minutes of the current
clock. This prevents an attacker who captures a valid signed request from
reusing it.

### Comment enrichment

The worker calls the Zendesk REST API to fetch the full comment thread and the
canonical ticket status. If the API call fails (e.g. credentials not set,
network error), the worker falls back to the fields from the webhook payload and
logs the error — the ticket row is still upserted.

The full comment thread includes **internal (non-public) Zendesk comments**, which
are synced into the Notion database alongside public ones. If your Notion database
is more widely accessible than your Zendesk agent workspace, filter these out
before syncing.

## Local testing

The offline unit tests cover signature verification, replay protection, ticket
parsing, status mapping, and ID normalization — no credentials required:

```zsh
npm test
```

To exercise the full webhook flow locally with a signed payload:

```zsh
ntn workers exec zendeskToNotion --local -d '<signed-zendesk-payload-json>'
```

See the
[Notion Workers docs](https://developers.notion.com/docs/workers)
for how to sign a test payload with `ntn workers sign`.

## Learn more

- [Notion Workers documentation](https://developers.notion.com/docs/workers)
- [Zendesk webhooks documentation](https://developer.zendesk.com/documentation/webhooks/)
- [Contribute to this cookbook](../../../../CONTRIBUTING.md)
