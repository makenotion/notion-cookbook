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
  mode: "replace",
  schedule: "5m",
  execute: async (state: SyncState | undefined) => {
    await pacer.wait()

    const subdomain = requireSubdomain()
    const page = await fetchTicketsPage(state?.cursor)

    const changes = page.tickets.map((t) =>
      ticketToChange(t, subdomain, page.users)
    )

    return {
      changes,
      hasMore: page.hasMore,
      nextState: page.nextCursor ? { cursor: page.nextCursor } : undefined,
    }
  },
})

export default worker
