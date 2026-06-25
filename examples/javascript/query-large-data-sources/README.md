# Query large data sources

A single Notion data source query returns at most 10,000 rows. That limit is per
query, not per data source: once a query reaches it, `has_more` becomes `false`
and the response includes `request_status.type === "incomplete"` with
`incomplete_reason: "query_result_limit_reached"`. Plain pagination stops there,
so a naive loop over a 25,000-row database silently returns 10,000 rows and
looks like it finished.

This example shows how to read every row anyway, by splitting the data source
into `created_time` windows that each stay under the limit.

## What you need

- Node.js 18 or newer
- A Notion integration token, with the target database shared to it
- A data source ID for a database you want to read

## Setup

```bash
npm install
cp .env.example .env
```

Then fill in `.env`:

- `NOTION_API_KEY`: your integration token
- `NOTION_DATA_SOURCE_ID`: the data source to read

## Run it

```bash
npm run ts-run
```

The script streams the first few rows with the SDK pagination helper, then
fetches the complete data source with the windowing approach and prints the
total row count.

## How it works

The limit applies to one query, and a query is identified by its filter and
sort. Change the filter and you get a fresh query with its own 10,000-row
budget. `queryAllRows` uses that:

1. Sort by `created_time` ascending.
2. Page through the results until `has_more` is `false`.
3. If the response came back `incomplete`, the limit was hit. Start a new query
   filtered to `created_time` on or after the last row's timestamp, and repeat.
4. Rows on a window boundary share that timestamp and appear in both windows, so
   de-duplicate by page ID.

`created_time` is the right key because it never changes. `last_edited_time`
would move rows between windows as they are edited, which drops or double-counts
rows.

## When a window can't be split

If more than 10,000 rows share a single `created_time` (down to the minute,
which is the granularity Notion stores), the window cannot advance by time
alone, and the script throws. Add another filter to narrow the query, for
example a property your data divides on, so each window stays under the limit.

## Views

The same 10,000-row limit applies to view queries
(`GET /v1/views/{view_id}/queries/{query_id}`), but you cannot window them the
same way. A view query paginates a fixed, already-capped result set and does not
accept a filter while paginating. To read every row behind a view, query its
underlying data source with the approach here, and apply the view's filter and
sort yourself if you need them.

## See also

- [Query large data sources](https://developers.notion.com/guides/data-apis/query-large-data-sources)
  in the Notion API docs
- [Query a data source](https://developers.notion.com/reference/query-a-data-source)
  endpoint reference
- The Notion JS SDK is adding `iterateAllDataSourceRows` and
  `collectAllDataSourceRows` helpers that wrap this pattern.
