/**
 * Replace mode — paginated API.
 *
 * Fetches all records page by page. Each cycle re-fetches everything.
 * The runtime deletes any records not seen during the cycle.
 *
 * This pattern is also used for backfill syncs (with schedule: "manual"),
 * where you want to re-import all data on demand rather than on a timer.
 *
 * Key points:
 * - State is just within-cycle pagination: { page: number }
 * - State effectively resets between cycles (each cycle starts from page 1)
 * - hasMore: true while there are more pages to fetch
 * - Batch size ~100 to avoid overloading a single execute call
 * - A pacer rate-limits API calls to avoid hitting upstream rate limits
 */

import { Worker } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

const worker = new Worker()
export default worker

const productsDb = worker.database("productsDb", {
  type: "managed",
  initialTitle: "Products",
  primaryKeyProperty: "Product ID",
  schema: {
    properties: {
      Name: Schema.title(),
      "Product ID": Schema.richText(),
    },
  },
})

// Rate-limit API calls: 10 requests per second
const apiPacer = worker.pacer("exampleApi", {
  allowedRequests: 10,
  intervalMs: 1000,
})

// State is simple — just track which page we're on within this cycle
type PaginationState = { page: number }

worker.sync("productsSync", {
  database: productsDb,
  mode: "replace",
  execute: async (state: PaginationState | undefined) => {
    const page = state?.page ?? 1
    const pageSize = 100

    // Wait for the pacer before each API call
    await apiPacer.wait()

    // Fetch one page from the API
    const response = await fetch(
      `https://api.example.com/products?page=${page}&limit=${pageSize}`,
      { headers: { Authorization: `Bearer ${process.env.API_TOKEN}` } }
    )
    const data = await response.json()

    const hasMore = data.products.length === pageSize

    return {
      changes: data.products.map((product: { id: string; name: string }) => ({
        type: "upsert" as const,
        key: product.id,
        properties: {
          Name: Builder.title(product.name),
          "Product ID": Builder.richText(product.id),
        },
      })),
      hasMore,
      // Next page, or undefined if done (cycle complete)
      nextState: hasMore ? { page: page + 1 } : undefined,
    }
  },
})
