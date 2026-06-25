import {
  Client,
  collectPaginatedAPI,
  isFullPage,
  iteratePaginatedAPI,
} from "@notionhq/client"
import type { QueryDataSourceResponse } from "@notionhq/client"
import { config } from "dotenv"

config()

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Set ${name} in your .env file`)
  }
  return value
}

// NOTION_BASE_URL and NOTION_VERSION are optional overrides for non-default
// hosts. Leave them blank to use api.notion.com and the SDK's default version.
const notion = new Client({
  auth: requireEnv("NOTION_API_KEY"),
  baseUrl: process.env.NOTION_BASE_URL || undefined,
  notionVersion: process.env.NOTION_VERSION || undefined,
})

const dataSourceId = requireEnv("NOTION_DATA_SOURCE_ID")

type DataSourceRow = QueryDataSourceResponse["results"][number]

// A single query (one filter + sort) returns at most a fixed number of rows:
// 10,000 by default. When that limit is reached, has_more becomes false and the
// response carries request_status.type === "incomplete". The SDK pagination
// helpers follow next_cursor until has_more is false, so on a data source
// larger than the limit they stop at 10,000 and silently return a partial set.
//
// queryAllRows below works around the limit. See the README for the why.

// The simple way, for data sources under the limit. iteratePaginatedAPI streams
// one row at a time so you never hold the whole data source in memory.
async function streamFirstRows(limit: number): Promise<void> {
  let shown = 0
  for await (const row of iteratePaginatedAPI(notion.dataSources.query, {
    data_source_id: dataSourceId,
    page_size: Math.min(limit, 100),
  })) {
    console.log(`  ${row.id}`)
    shown += 1
    if (shown >= limit) break
  }
}

// Also the simple way: collectPaginatedAPI gathers every row into an array.
// Only use it when you know the result fits in memory and under the limit.
async function collectAll(): Promise<DataSourceRow[]> {
  return collectPaginatedAPI(notion.dataSources.query, {
    data_source_id: dataSourceId,
  })
}

// Get every row, even when the data source exceeds the per-query limit.
//
// The trick: the limit is per query, where a query is identified by its filter
// and sort. Change the filter and you get a fresh query with its own budget. So
// we walk the data source in created_time windows. Sort by created_time
// ascending; each time a window hits the limit, start a new query filtered to
// created_time on_or_after the last row we saw. Rows on a window boundary share
// that timestamp and repeat across windows, so we de-duplicate by id.
//
// created_time is used because it never changes. last_edited_time would move
// rows between windows as they are edited, which would drop or double-count
// rows.
async function queryAllRows(): Promise<DataSourceRow[]> {
  const rowsById = new Map<string, DataSourceRow>()
  let windowStart: string | undefined = undefined

  for (;;) {
    let limitReached = false
    let lastCreatedTime: string | undefined = undefined
    let cursor: string | undefined = undefined

    // Drain one window: page through it until has_more is false. This loop also
    // ends when the per-query limit is hit, because the limit sets has_more to
    // false (and request_status to incomplete).
    do {
      const response: QueryDataSourceResponse = await notion.dataSources.query({
        data_source_id: dataSourceId,
        sorts: [{ timestamp: "created_time", direction: "ascending" }],
        filter: windowStart
          ? {
              timestamp: "created_time",
              created_time: { on_or_after: windowStart },
            }
          : undefined,
        start_cursor: cursor,
        page_size: 100,
      })

      for (const row of response.results) {
        rowsById.set(row.id, row)
        // created_time lives on full page objects only.
        if (isFullPage(row)) {
          lastCreatedTime = row.created_time
        }
      }

      if (response.request_status?.type === "incomplete") {
        limitReached = true
      }
      cursor = response.next_cursor ?? undefined
    } while (cursor)

    // The window finished under the limit: we have everything.
    if (!limitReached) {
      break
    }
    // The window hit the limit but every row shares one created_time, so we
    // cannot advance by time. Narrow the query with another filter instead.
    if (!lastCreatedTime || lastCreatedTime === windowStart) {
      throw new Error(
        `More than the per-query limit share created_time ${lastCreatedTime}. ` +
          "Add another filter to split this window."
      )
    }

    windowStart = lastCreatedTime
    console.log(`  hit the limit; continuing from created_time ${windowStart}`)
  }

  return [...rowsById.values()]
}

async function main(): Promise<void> {
  console.log(`Data source: ${dataSourceId}\n`)

  console.log("First few rows (streamed with iteratePaginatedAPI):")
  await streamFirstRows(5)

  console.log("\nFetching every row (created_time windowing):")
  const started = Date.now()
  const all = await queryAllRows()
  console.log(`\nGot ${all.length} rows in ${Date.now() - started}ms`)

  // collectAll (above) is the one-liner you reach for when the data source is
  // small enough to fit in memory and under the limit. Uncomment to compare; on
  // a large data source it stops at the per-query limit.
  // const capped = await collectAll()
  // console.log(`collectPaginatedAPI returned ${capped.length} rows`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
