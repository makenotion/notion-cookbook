# Worker webhook: Zendesk

A live Zendesk ticket tracker for Notion. When a Zendesk trigger fires, this
worker creates or updates the ticket's row in your Notion database. The page
properties show its current status, requester, and assignee; the page body
contains the description and full comment thread.

Unlike [Zendesk sync](../zendesk-sync/README.md), this worker updates a database
you create whenever Zendesk sends an event. Use it when selected ticket events
should appear in Notion immediately.

## Quickstart

1. Create a Notion database using the
   [required schema](#required-notion-database-schema). Create a
   [Notion internal integration](https://www.notion.so/profile/integrations/internal),
   connect it to that database, then copy the database ID or URL and the
   integration token.

2. From the repository root, install the CLI and worker, connect your workspace,
   and deploy:

   ```sh
   npm install --global ntn
   cd workers/zendesk-webhook
   npm install
   ntn login
   ntn workers deploy --name zendesk-webhook
   ```

   Copy the webhook URL printed by the deploy command.

3. In Zendesk Admin, go to **Apps and integrations > Webhooks > Create
   webhook**. Use the worker URL as the endpoint, enable signing, and copy the
   signing secret.

4. Configure the deployed worker using an admin API token. If you need one,
   follow the [Zendesk API token steps](../zendesk-sync/README.md#zendesk-api-token).

   ```sh
   ntn workers env set ZENDESK_WEBHOOK_SECRET=your-signing-secret
   ntn workers env set ZENDESK_NOTION_DATABASE_ID=your-database-id-or-url
   ntn workers env set NOTION_API_TOKEN=your-notion-integration-token
   ntn workers env set ZENDESK_SUBDOMAIN=acme
   ntn workers env set ZENDESK_API_TOKEN=your-api-token
   ntn workers env set ZENDESK_API_USER_EMAIL=admin@example.com
   ```

5. Create a Zendesk trigger for the events you want, such as ticket created or
   ticket updated. Add **Notify by > Active webhook**, select this webhook, and
   use the following JSON body after replacing `acme` with your subdomain:

   ```json
   {
     "ticket_id": "{{ticket.id}}",
     "ticket_url": "https://acme.zendesk.com/agent/tickets/{{ticket.id}}",
     "email": "{{ticket.requester.email}}",
     "subject": "{{ticket.title}}",
     "description": "{{ticket.verbatim_description}}",
     "assignee": "{{ticket.assignee.name}}",
     "status": "{{ticket.status}}",
     "latest_comment": "{{ticket.latest_comment}}",
     "created_at": "{{ticket.created_at_with_timestamp}}"
   }
   ```

When the trigger next fires, the ticket appears in your Notion database. Later
events update the same row by its Zendesk Ticket ID.

Comment enrichment includes internal Zendesk comments. Share the destination
database only with people who are allowed to read them.

## What this enables

- A shared Notion queue organized by ticket status, requester, or assignee
- A durable case page with the latest description and complete conversation
- Notion views and workflows that react to the Zendesk events you choose

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

## Environment variables

| Variable                     | Required                  | Description                                                                                                |
| ---------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `ZENDESK_WEBHOOK_SECRET`     | Yes                       | Signing secret from the Zendesk webhook (Reveal secret).                                                   |
| `ZENDESK_NOTION_DATABASE_ID` | Yes                       | ID or URL of the Notion database to sync tickets into.                                                     |
| `NOTION_API_TOKEN`           | Yes                       | Internal integration token connected to the destination database.                                          |
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
canonical ticket status. If an API request fails after credentials are loaded,
the worker falls back to the fields from the webhook payload and logs the error
— the ticket row is still upserted.

The full comment thread includes **internal (non-public) Zendesk comments**,
which are synced into the Notion database alongside public ones. If your Notion
database is more widely accessible than your Zendesk agent workspace, filter
these out before syncing.

## Local testing

The offline unit tests cover signature verification, replay protection, ticket
parsing, status mapping, and ID normalization — no credentials required:

```sh
npm test
```

Use Zendesk's webhook test action or the configured trigger to exercise a full
signed delivery.

## Learn more

- [Notion Workers documentation](https://developers.notion.com/docs/workers)
- [Zendesk webhooks documentation](https://developer.zendesk.com/documentation/webhooks/)
- [Contribute to this cookbook](../../CONTRIBUTING.md)
