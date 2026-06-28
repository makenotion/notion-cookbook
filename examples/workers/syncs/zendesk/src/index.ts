// Entry point — wires together the database schema, Zendesk API client, and
// sync schedule. Most customization happens in schema.ts and transform.ts;
// this file rarely needs changes unless you're adjusting the sync mode,
// schedule, or pagination strategy.

import { Worker } from "@notionhq/workers"

import { fetchTicketsPage, requireSubdomain } from "./zendesk.js"
import { INITIAL_TITLE, PRIMARY_KEY, ticketSchema } from "./schema.js"
import { ticketToChange } from "./transform.js"

type SyncState = {
  cursor: string
}

const worker = new Worker()

// Zendesk rate-limits API calls to 400 requests per minute on most plans.
const pacer = worker.pacer("zendesk", {
  allowedRequests: 380,
  intervalMs: 60_000,
})

const tickets = worker.database("tickets", {
  type: "managed",
  initialTitle: INITIAL_TITLE,
  primaryKeyProperty: PRIMARY_KEY,
  schema: ticketSchema,
})

worker.sync("ticketsSync", {
  database: tickets,
  // "replace" re-syncs all tickets each run and auto-deletes removed ones.
  // Switch to "incremental" for large instances — see README.
  mode: "replace",
  // How often the sync runs. Options: "manual", "5m", "15m", "30m", "1h", "1d".
  schedule: "5m",
  execute: async (state: SyncState | undefined) => {
    await pacer.wait()

    const subdomain = requireSubdomain()
    const page = await fetchTicketsPage(state?.cursor)

    const changes = page.tickets.map((t) =>
      ticketToChange(t, subdomain, page.users)
    )

    // The platform calls execute() repeatedly while hasMore is true,
    // passing nextState back as the state parameter on the next call.
    return {
      changes,
      hasMore: page.hasMore,
      nextState: page.nextCursor ? { cursor: page.nextCursor } : undefined,
    }
  },
})

export default worker
