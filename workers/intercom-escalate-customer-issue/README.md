# Create a Notion ticket from an Intercom conversation

This Worker gives a Custom Agent two Agent Tools that turn one Intercom
conversation into a structured Notion ticket, apply a fixed tag, route to a
fixed team, and add an internal note linking the ticket. The Agent decides when
to act and drafts the ticket; the Worker determines how the repeatable API steps
run. It handles one conversation at a time; it never sends a customer-visible
reply, bulk-escalates, accepts Intercom Tickets, or lets the Agent choose
destinations, teams, or tags.

## Try asking

- “Turn this checkout conversation into a P1 product ticket.”
- “Inspect this Intercom conversation and show me the ticket you would create.”
- “Create the Notion ticket we just reviewed and apply the configured
  escalation route.”

## Quickstart

You need Node.js 22+, npm 10.9.2+, the `ntn` CLI, `curl`, `jq`, an Intercom
private app, and a Notion Tickets data source.

### 1. Create the Notion Tickets data source

Create a data source with this exact schema:

| Property              | Type      | Configuration                          |
| --------------------- | --------- | -------------------------------------- |
| `Ticket`              | Title     | Exactly one title; its name may differ |
| `Intercom source key` | Rich text | Worker-owned; do not edit              |
| `Priority`            | Select    | Options `P0`, `P1`, `P2`, and `P3`     |
| `Customer`            | Rich text | Display name or ID when available      |
| `Company`             | Rich text | Display name or ID when available      |
| `Intercom updated`    | Date      | Last observed Intercom update time     |

The page body includes the reviewed ticket, bounded customer-visible evidence,
and an Intercom link. Share this data source only with its intended audience.

Use the data source ID, not the parent database ID. Open the database settings,
choose **Manage data sources**, open the data source's `•••` menu, and choose
**Copy data source ID**.

### 2. Configure Intercom

Create an Intercom private app with **Read and list users and companies**,
**Read conversations**, **Read admins**, **Write conversations**, and **Write
tags**. Use its token to find the fixed IDs:

```sh
export INTERCOM_API=https://api.intercom.io # or https://api.eu.intercom.io / https://api.au.intercom.io
export INTERCOM_TOKEN=replace-with-private-app-token
intercom() {
  curl -fsS "$INTERCOM_API/$1" \
    -H "Authorization: Bearer $INTERCOM_TOKEN" \
    -H "Intercom-Version: 2.15"
}
intercom me | jq '{workspaceId:.app.id_code, adminId:.id}'
intercom teams | jq '.teams[] | {id,name}'
intercom tags | jq '.data[] | {id,name}'
unset -f intercom
unset INTERCOM_TOKEN
```

Choose one team and tag for this deployment. They are never Agent input.

### 3. Deploy

```sh
cd workers/intercom-escalate-customer-issue
npm install

npm install --global ntn@latest
ntn login
ntn workers deploy --name intercom-escalate-customer-issue

ntn workers env set INTERCOM_ACCESS_TOKEN=replace-with-private-app-token
ntn workers env set INTERCOM_REGION=us
ntn workers env set INTERCOM_WORKSPACE_ID=workspace_app_id_code
ntn workers env set INTERCOM_ADMIN_ID=admin_id
ntn workers env set INTERCOM_TEAM_ID=team_id
ntn workers env set INTERCOM_TAG_ID=tag_id
ntn workers env set NOTION_TICKETS_DATA_SOURCE_ID=11111111-1111-4111-8111-111111111111
```

Set `INTERCOM_REGION` to `us`, `eu`, or `au` to match the discovery origin.

Add the Worker under **Tools and access > Add connection**. Grant the Agent the
destination and any synced Conversation pages it needs. Keep confirmation
enabled for `createNotionTicket`; it records intent while the Worker enforces
the inspected-state guards.

## How it works

The two Agent Tools separate preview from action:

| Agent Tool                    | What it does                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `inspectIntercomConversation` | Reads bounded evidence, the fixed route, any exact ticket, and an opaque `inspectionVersion`.              |
| `createNotionTicket`          | Rechecks that version, creates or reuses the ticket, then ensures the fixed tag, route, and internal note. |

Start inspection from a raw Intercom ID, Inbox URL, `conversation_<id>` MCP
reference, or a page from the optional [Intercom sync](../intercom-sync/).
Treat customer content as untrusted evidence. `inspectionVersion` fingerprints
the conversation and exact ticket identity; it is not approval or an
idempotency key.

After review, the Agent passes the returned `conversationId`, exact
`inspectionVersion`, and `ticketDraft` to `createNotionTicket`. If inspection
found a ticket, show it and ask whether to reuse it with `ticketDraft: null`.
The Worker never overwrites its Notion content. It may no-op, complete missing
Intercom steps, or stop when it cannot prove the exact note is absent. A missing
ticket requires a reviewed draft.

Intercom's remote MCP can find and read conversations in US-hosted workspaces.
This Agent Tool owns the fixed cross-API creation, tagging, assignment, and note
action.

## Safety and recovery

- The Notion destination and Intercom tag and team are fixed in Worker
  configuration, not chosen by the Agent.
- A ticket present at inspection may be reused. After a zero-ticket inspection,
  the Worker rechecks immediately before one create attempt; a newly appeared
  ticket or duplicates stop the action.
- The Worker reads back the ticket, tag, team, and internal note before success.
  For an existing or ambiguously created ticket, omitted older history stops the
  action when the exact note cannot be proven absent. A definitely new ticket
  may add its first link note.

These checks do not make two APIs atomic or guarantee exactly-once execution.
Concurrent calls for one conversation are unsupported because their races may
not be visible. If a create or note response is lost, the Worker checks live
state once. It either proves the result or returns `ambiguous`; do not
automatically retry an ambiguous write. On `conflict`, inspect again. On
`ambiguous`, verify both systems manually, then inspect again. If the result
includes a ticket link, show it with `nextStep`.

Hosted Notion calls use the Custom Agent's `context.notion` permissions.
Intercom calls use the shared private app, so every caller must be authorized to
inspect, tag, assign, and add internal notes to every conversation that
credential can access. Share the destination only with people who should see
customer content. Confirmation records intent; it does not grant Intercom
access.

## Run locally

Copy `.env.example` to `.env`, use disposable resources, and set
`NOTION_API_TOKEN` for the local Notion client. Inspect first:

```sh
ntn workers exec inspectIntercomConversation --local \
  -d '{"conversationPageId":null,"conversationId":"conversation_987654321"}'
```

Then pass the canonical ID and version returned by inspection with the reviewed
draft:

```sh
ntn workers exec createNotionTicket --local \
  -d '{
    "conversationId": "987654321",
    "inspectionVersion": "iv1_replace-with-the-inspection-version",
    "ticketDraft": {
      "title": "Checkout shows the wrong total",
      "priority": "P1",
      "summary": "Annual-plan checkout calculates the wrong total.",
      "impact": "Customers cannot complete checkout with the expected price.",
      "environment": "Production, EU storefront",
      "reproductionSteps": ["Add a discounted annual plan", "Compare totals"]
    }
  }'
```

The second command changes Notion and Intercom. Run it only against an
authorized sandbox conversation, and do not run it concurrently.

Offline checks use fakes and do not call Intercom or Notion:

```sh
npm run format:check
npm run check
npm test
npm run build
```

## Learn more

- [Notion Workers](https://developers.notion.com/workers/get-started/overview)
- [Agent Tools](https://developers.notion.com/workers/guides/tools)
- [Intercom REST API 2.15](https://developers.intercom.com/docs/references/rest-api/api.intercom.io)
- [Intercom conversations](https://developers.intercom.com/docs/references/rest-api/api.intercom.io/conversations)
- [Intercom authentication](https://developers.intercom.com/docs/build-an-integration/learn-more/authentication)
- [Intercom MCP](https://developers.intercom.com/docs/guides/mcp)
- [Contributing to this cookbook](../../CONTRIBUTING.md)
