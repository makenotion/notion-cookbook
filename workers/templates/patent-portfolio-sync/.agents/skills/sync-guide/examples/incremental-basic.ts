/**
 * Delta sync — opaque cursor for incremental change tracking.
 *
 * This is the delta half of a backfill+delta pair. It handles ongoing
 * change detection for APIs that sort results by updated_at and return
 * an opaque pagination cursor. On each cycle, the cursor picks up where
 * the last cycle left off, fetching only newly modified records.
 *
 * Example: Shopify GraphQL (sortKey: UPDATED_AT), any API with opaque
 * cursor pagination that returns results in modification order.
 *
 * Key points:
 * - State is just { cursor: string | null } — no phase discrimination
 * - First run: cursor is null, starts from the beginning
 * - Subsequent runs: cursor picks up where the last cycle left off
 * - The cursor never resets in incremental mode — it persists forever
 * - Cursor preservation: if the API returns no endCursor (empty page at
 *   frontier), keep the existing cursor rather than regressing to null
 *
 * For a full dataset load (backfill), add a separate replace-mode sync
 * targeting the same database — see replace-paginated.ts for the pattern.
 * Trigger it via CLI:
 *   ntn workers sync state reset ordersBackfill && ntn workers sync trigger ordersBackfill
 */

import { Worker } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

const worker = new Worker()
export default worker

// Database shared between backfill (replace) and delta (incremental) syncs
const orders = worker.database("orders", {
  type: "managed",
  initialTitle: "Orders",
  primaryKeyProperty: "Order ID",
  schema: {
    properties: {
      Title: Schema.title(),
      "Order ID": Schema.richText(),
    },
  },
})

// Rate-limit API calls — shared across all syncs hitting this API
const apiPacer = worker.pacer("shopify", {
  allowedRequests: 4,
  intervalMs: 1000,
})

type CursorState = { cursor: string | null }

// Delta sync: incremental mode, runs every 5 minutes to pick up changes
worker.sync("ordersDelta", {
  database: orders,
  mode: "incremental",
  schedule: "5m",
  execute: async (state: CursorState | undefined) => {
    const cursor = state?.cursor ?? null

    // GraphQL query with Relay-style pagination, sorted by UPDATED_AT
    const query = `
      query ($after: String) {
        orders(first: 100, sortKey: UPDATED_AT, after: $after) {
          edges { node { id name } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `

    await apiPacer.wait()
    const response = await fetch(
      "https://shop.example.com/admin/api/graphql.json",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Access-Token": process.env.SHOP_TOKEN ?? "",
        },
        body: JSON.stringify({ query, variables: { after: cursor } }),
      }
    )
    const { data } = await response.json()
    const { edges, pageInfo } = data.orders

    return {
      changes: edges.map((edge: { node: { id: string; name: string } }) => ({
        type: "upsert" as const,
        key: edge.node.id,
        properties: {
          Title: Builder.title(edge.node.name),
          "Order ID": Builder.richText(edge.node.id),
        },
      })),
      hasMore: pageInfo.hasNextPage,
      nextState: {
        // Preserve existing cursor if API returns null (empty frontier)
        cursor: pageInfo.endCursor ?? cursor,
      },
    }
  },
})
