// Snowflake Query — read-only agent tool.
//
// Lets a Notion agent run a SELECT/WITH query against a Snowflake
// warehouse and returns structured results. Auth is key-pair JWT against
// the SQL REST API — no native Snowflake SDK needed inside the worker
// sandbox.
//
// Safety:
//   - Only SELECT and WITH statements are accepted.
//   - Multi-statement input (`;`) is rejected.
//   - The user's query is wrapped with a `LIMIT` so the warehouse caps
//     the row count, not the worker.
//   - The warehouse and role come from secrets, not user input — point
//     them at a read-only role to harden further.

import { Worker } from "@notionhq/workers"
import { j } from "@notionhq/workers/schema-builder"
import { runQuery } from "./snowflake.js"

const worker = new Worker()
export default worker

worker.tool("runQuery", {
  title: "Run Snowflake Query",
  description:
    "Run a read-only SQL query against Snowflake and return the rows. Only SELECT and WITH queries are permitted. Useful for asking questions like 'how many active customers do we have in EMEA?' when a Notion agent needs to look up live data from the warehouse.",
  schema: j.object({
    query: j
      .string()
      .describe(
        "A single SQL SELECT or WITH statement. Do not include a trailing semicolon. The warehouse, role, database, and schema are fixed by the worker's configuration."
      ),
    rowLimit: j
      .integer()
      .nullable()
      .describe("Maximum rows to return. Defaults to 100. Capped at 1000."),
  }),
  outputSchema: j.object({
    columns: j
      .array(j.string())
      .describe("Column names in the order rows are arranged."),
    rows: j
      .array(j.array(j.string().nullable()))
      .describe(
        "Row data. Snowflake's SQL API returns all values as JSON strings (or null); the agent can parse numeric columns as needed."
      ),
    rowCount: j.integer().describe("Number of rows in `rows`."),
    truncated: j
      .boolean()
      .describe(
        "True if the original result set had more rows than `rowLimit`."
      ),
  }),
  execute: ({ query, rowLimit }) => runQuery(query, rowLimit ?? null),
})
