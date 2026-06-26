import { Worker } from "@notionhq/workers"

import { fetchPage } from "./snowflake.js"
import { INITIAL_TITLE, PRIMARY_KEY, rowSchema } from "./schema.js"
import { rowToChange } from "./transform.js"

// How many rows to fetch per page. 200 is a safe balance between round-trips
// and memory pressure. Increase for very wide tables or decrease for very
// narrow ones.
const PAGE_SIZE = 200

// State carried between execute() calls while hasMore is true.
type SyncState = {
  offset: number
}

const worker = new Worker()

const database = worker.database("rows", {
  type: "managed",
  initialTitle: INITIAL_TITLE,
  primaryKeyProperty: PRIMARY_KEY,
  schema: rowSchema,
})

worker.sync("snowflakeSync", {
  database,
  mode: "replace",
  schedule: "manual",
  execute: async (state: SyncState | undefined, _context) => {
    const query = process.env.SNOWFLAKE_SYNC_QUERY
    if (!query || !query.trim()) {
      throw new Error(
        "SNOWFLAKE_SYNC_QUERY is not set. " +
          "Set it to a SELECT statement whose rows should be synced into Notion."
      )
    }

    const offset = state?.offset ?? 0
    const rows = await fetchPage(query, PAGE_SIZE, offset)

    // A full page means there may be more rows; a partial page means we're done.
    const hasMore = rows.length === PAGE_SIZE

    const changes = rows.flatMap((row) => {
      const change = rowToChange(row)
      return change !== null ? [change] : []
    })

    return {
      changes,
      hasMore,
      nextState: hasMore ? { offset: offset + rows.length } : undefined,
    }
  },
})

export default worker
