// Zendesk → Notion sync.
//
// Just one sync — Zendesk publishes a purpose-built cursor-based
// incremental export for tickets, so the API is itself the change feed.
// We don't need a separate backfill: the cursor starts at `start_time=0`
// on first run and walks forward forever. Soft-deletes arrive in the
// same stream tagged with `status: "deleted"` and become `delete`
// change records in Notion.
//
// Compare this with the Linear and Salesforce syncs in this cookbook —
// same incremental idea, but the API does most of the cursor work for us.

import { Worker } from "@notionhq/workers"
import * as Schema from "@notionhq/workers/schema"
import { fetchIncrementalTickets } from "./zendesk.js"
import { ticketToChange } from "./mapping.js"

const worker = new Worker()
export default worker

// Zendesk's incremental endpoint is rate-limited at 10 req/min per token.
// We stay well below that — this also gives headroom for retries inside
// the sandbox.
const zdApi = worker.pacer("zendeskApi", {
  allowedRequests: 1,
  intervalMs: 1000,
})

const tickets = worker.database("tickets", {
  type: "managed",
  initialTitle: "Zendesk Tickets",
  primaryKeyProperty: "Ticket ID",
  schema: {
    properties: {
      Subject: Schema.title(),
      "Ticket ID": Schema.richText(),
      URL: Schema.url(),
      // Status and Priority are picklists in Zendesk but accept
      // custom values on Zendesk Suite. richText keeps the mapping
      // resilient to any workspace configuration.
      Status: Schema.richText(),
      Priority: Schema.richText(),
      "Requester ID": Schema.richText(),
      "Assignee ID": Schema.richText(),
      Tags: Schema.richText(),
      Updated: Schema.date(),
    },
  },
})

// State for the incremental sync is just the cursor returned by Zendesk.
// On first run it's null and we start at start_time=0. The cursor
// preserves itself when the API returns no advancement, so the sync
// never regresses.
type State = { cursor: string | null }

worker.sync("ticketsSync", {
  database: tickets,
  mode: "incremental",
  schedule: "15m",
  execute: async (state: State | undefined) => {
    const cursor = state?.cursor ?? null

    await zdApi.wait()
    const page = await fetchIncrementalTickets(cursor)

    return {
      changes: page.tickets.map(ticketToChange),
      hasMore: !page.end_of_stream,
      // Preserve the existing cursor if Zendesk returns null
      // (frontier reached but the stream hasn't moved).
      nextState: { cursor: page.after_cursor ?? cursor },
    }
  },
})
