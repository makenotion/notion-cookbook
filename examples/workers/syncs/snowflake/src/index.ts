import { Worker } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

import { runQuery, type JsonValue } from "./snowflake.js"

const worker = new Worker()
export default worker

// A generic Snowflake → Notion sync. It runs a single SELECT and writes each
// row to a Notion database. By default it syncs the table catalog of your
// configured database/schema (INFORMATION_SCHEMA.TABLES) — a query every role
// can run, so it works out of the box on any account without special grants.
//
// To sync your own data instead, set SNOWFLAKE_SYNC_QUERY to your SELECT (no
// LIMIT / OFFSET — the sync paginates for you) and update the schema and
// `rowToEntry` mapping below so the columns line up.

// Lists the tables and views in the connection's current schema. Requires
// SNOWFLAKE_DATABASE and SNOWFLAKE_SCHEMA to be set so CURRENT_SCHEMA() resolves.
const DEFAULT_QUERY = `SELECT
		TABLE_CATALOG || '.' || TABLE_SCHEMA || '.' || TABLE_NAME AS FULL_NAME,
		TABLE_NAME,
		TABLE_SCHEMA,
		TABLE_TYPE,
		COALESCE(ROW_COUNT, 0) AS ROW_COUNT
	FROM INFORMATION_SCHEMA.TABLES
	WHERE TABLE_SCHEMA = CURRENT_SCHEMA()
	ORDER BY TABLE_NAME`

const BASE_QUERY = process.env.SNOWFLAKE_SYNC_QUERY?.trim() || DEFAULT_QUERY

// Rows per execute call. The runtime calls execute again with the next offset
// until a page comes back short, so the whole result set syncs across the cycle.
const BATCH_SIZE = 100

type SyncState = { offset: number }

const tables = worker.database("snowflakeTables", {
  type: "managed",
  initialTitle: "Snowflake Tables",
  primaryKeyProperty: "Full Name",
  schema: {
    properties: {
      Name: Schema.title(),
      "Full Name": Schema.richText(),
      Schema: Schema.richText(),
      Type: Schema.richText(),
      Rows: Schema.number(),
    },
  },
})

worker.sync("snowflakeSync", {
  database: tables,
  // A plain SELECT has no change feed, so re-pull the full result set each cycle.
  // After the final page, rows that disappeared from the query are deleted.
  mode: "replace",
  // Runs on a schedule; tune to taste ("15m", "1h", "1d", "continuous", ...).
  schedule: "1h",
  execute: async (state: SyncState | undefined) => {
    const offset = state?.offset ?? 0
    const { rows } = await runQuery(
      `${BASE_QUERY}\nLIMIT ${BATCH_SIZE} OFFSET ${offset}`
    )

    const changes = rows.map((row) => ({
      type: "upsert" as const,
      key: String(row.FULL_NAME),
      properties: rowToEntry(row),
    }))

    const hasMore = rows.length === BATCH_SIZE
    return {
      changes,
      hasMore,
      nextState: hasMore ? { offset: offset + BATCH_SIZE } : undefined,
    }
  },
})

function rowToEntry(row: Record<string, JsonValue>) {
  return {
    Name: Builder.title(str(row.TABLE_NAME)),
    "Full Name": Builder.richText(str(row.FULL_NAME)),
    Schema: Builder.richText(str(row.TABLE_SCHEMA)),
    Type: Builder.richText(str(row.TABLE_TYPE)),
    Rows: Builder.number(num(row.ROW_COUNT)),
  }
}

function str(value: JsonValue): string {
  return value == null ? "" : String(value)
}

function num(value: JsonValue): number {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}
