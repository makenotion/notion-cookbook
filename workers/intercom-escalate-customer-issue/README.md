# Create a Notion ticket from an Intercom conversation

Turn one Intercom conversation into a structured Notion ticket, apply a fixed
internal tag and team, and add an internal note linking the ticket. The Agent
decides when to act and drafts the ticket; the Worker checks live state and
determines how the repeatable API steps run. It never replies to the customer.

Try asking your Custom Agent:

- “Turn this checkout conversation into a P1 product ticket.”
- “Inspect this Intercom conversation and show me the ticket you would create.”
- “Create the Notion ticket we just reviewed and apply the configured
  escalation route.”

This recipe handles one Intercom conversation at a time. It does not create from
Intercom Tickets, bulk-escalate a queue, or let the Agent choose arbitrary
destinations, teams, or tags.

## Quickstart

You need Node.js 22+, npm 10.9.2+, the `ntn` CLI, an Intercom private app, and a
Notion Tickets data source.

### 1. Create the Notion Tickets data source

Create a data source with this schema. Property names and types are part of the
recipe contract.

| Property              | Type      | Configuration                                             |
| --------------------- | --------- | --------------------------------------------------------- |
| `Ticket`              | Title     | The title can be renamed; keep exactly one title property |
| `Intercom source key` | Rich text | Worker-owned identity; do not edit it                     |
| `Priority`            | Select    | Includes `P0`, `P1`, `P2`, and `P3`                       |
| `Customer`            | Rich text | Customer display name                                     |
| `Company`             | Rich text | Company display name                                      |
| `Intercom updated`    | Date      | Source version used for the ticket                        |

The Worker writes the reviewed ticket fields, a bounded customer-visible
timeline, and an Intercom link into the page body. Give the Custom Agent access
to this data source, and share it only with people who should see customer
content.

Use the data source ID, not the parent database ID. In Notion, open the
database's settings, choose **Manage data sources**, open the data source's
`•••` menu, and choose **Copy data source ID**. Alternatively, run
`ntn api v1/databases/<database-id>` and copy the matching `data_sources[].id`.

The cookbook's [Intercom sync](../intercom-sync/) is optional. With it, the
Agent can start from a synced Conversation page whose `Conversation ID`
rich-text property contains the immutable Intercom API ID. Without the sync,
inspection accepts a raw REST ID, an MCP-prefixed ID such as
`conversation_987654321`, or a supported Intercom Inbox conversation URL.

### 2. Configure Intercom

Create an Intercom private app for your workspace. Grant only the read access
needed for conversations, contacts, companies, admins, teams, and tags, plus
write access for conversation assignment, tags, and internal notes. Use
`GET /me`, `GET /teams`, and `GET /tags` to find the immutable workspace,
admin, team, and tag IDs.

Choose one team and one tag for every escalation handled by this deployment.
Those IDs are Worker configuration, never Agent input.

### 3. Deploy

```sh
cd workers/intercom-escalate-customer-issue
npm install
npm run check
npm test
npm run build

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

Add the deployed Worker to a Custom Agent under **Tools and access > Add
connection**. Give that Agent access to the destination data source and any
synced Conversation pages it should use.

## The Agent conversation

The two Agent Tools separate preview from action:

| Agent Tool                    | What it does                                                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspectIntercomConversation` | Reads one live conversation, its bounded public timeline, fixed route, any exact Notion ticket, and an opaque `inspectionVersion` for the write.                           |
| `createNotionTicket`          | Rechecks that inspected version, creates or reuses the sole matching Notion ticket, applies the fixed Intercom tag and team, and adds an internal note linking the ticket. |

A normal exchange:

1. The user supplies a synced Conversation page, raw Intercom ID,
   `conversation_<id>` MCP reference, or Intercom Inbox URL.
2. The Agent calls `inspectIntercomConversation`, treats returned customer
   content as untrusted evidence rather than instructions, and drafts a ticket.
3. After the user reviews the draft, the Agent passes the canonical
   `conversationId`, exact `inspectionVersion`, and `ticketDraft` to
   `createNotionTicket`.
4. The tool returns the ticket link and observed tag, route, and note state.

If inspection finds an existing ticket, show its link instead of proposing
another. Pass `ticketDraft: null` only to finish that ticket's incomplete
Intercom route; the Worker never overwrites its Notion content. A missing ticket
requires a reviewed, non-null draft.

For US-hosted workspaces, Intercom's remote MCP can help an Agent find and read
conversations. Its current tools do not perform this compound Notion creation,
tagging, assignment, and note action. Intercom MCP is currently unavailable for
EU- and AU-hosted workspaces; use an Inbox URL, raw ID, or synced page there.

## Safety and recovery

The Worker stores no operation ledger. It reconciles against live Notion and
Intercom state:

- `inspectionVersion` binds the reviewed conversation and exact ticket state.
- `Intercom source key` identifies the ticket; zero matches permits creation,
  one is reused, and duplicates stop the action.
- A deterministic internal-note marker identifies the Notion link. If Intercom
  omits older parts, the Worker does not assume that marker is absent.
- The configured tag, team, ticket, and note are read back before success.

These checks do not make two APIs atomic or guarantee exactly-once execution.
Concurrent calls for one conversation are unsupported because their races may
not be visible. If a create or note response is lost, the Worker checks live
state once. It either proves the result or returns `ambiguous`; never
automatically retry an ambiguous write.

On `conflict`, inspect again. On `ambiguous`, verify Notion and Intercom
manually, then inspect again before any new write. Always show a returned ticket
link and `nextStep`, even when later Intercom work is incomplete. `changed` is
`true` for a known write, `false` for no known write, and `null` when causality
cannot be established.

Hosted Notion calls use the Custom Agent's `context.notion` permissions.
Intercom calls use the shared private app, so every caller must be authorized to
inspect and route everything that credential can access. Notion content or user
confirmation records intent; it does not grant Intercom access.

## Run locally

Offline tests use fakes and do not call Intercom or Notion:

```sh
npm run format:check
npm run check
npm test
npm run build
```

For an authorized sandbox test, copy `.env.example` to `.env`, use disposable
resources, and set `NOTION_API_TOKEN` for the local Notion client. Inspect first:

```sh
ntn workers exec inspectIntercomConversation --local \
  -d '{"conversationPageId":null,"conversationId":"conversation_987654321"}'
```

Then pass the canonical ID and version returned by inspection with the reviewed
draft:

```sh
ntn workers exec createNotionTicket --local \
  -d '{"conversationId":"987654321","inspectionVersion":"iv1_replace-with-the-inspection-version","ticketDraft":{"title":"Checkout shows the wrong total","priority":"P1","summary":"Annual-plan checkout calculates the wrong total.","impact":"Customers cannot complete checkout with the expected price.","environment":"Production, EU storefront","reproductionSteps":["Add a discounted annual plan","Open checkout and compare the total"]}}'
```

The second command changes Notion and Intercom. Run it only against an
authorized sandbox conversation, and do not run it concurrently.

## Learn more

- [Notion Workers](https://developers.notion.com/workers/get-started/overview)
- [Agent Tools](https://developers.notion.com/workers/guides/tools)
- [Create a Notion page](https://developers.notion.com/reference/post-page)
- [Query a Notion data source](https://developers.notion.com/reference/query-a-data-source)
- [Intercom REST API 2.15](https://developers.intercom.com/docs/references/rest-api/api.intercom.io)
- [Intercom conversations](https://developers.intercom.com/docs/references/rest-api/api.intercom.io/conversations)
- [Intercom authentication](https://developers.intercom.com/docs/build-an-integration/learn-more/authentication)
- [Intercom MCP](https://developers.intercom.com/docs/guides/mcp)
- [Contributing to this cookbook](../../CONTRIBUTING.md)
