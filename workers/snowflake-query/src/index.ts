import { Worker } from "@notionhq/workers"
import { j } from "@notionhq/workers/schema-builder"

import { runCommand, runQuery } from "./snowflake.js"
import { assertSelectOnly, buildDescribeTable, buildShowTables } from "./sql.js"

const worker = new Worker()
export default worker

// Three tools an agent can chain to answer questions about a warehouse:
// find a table, check its columns, then query it.

worker.tool("listTables", {
  title: "List Tables",
  description:
    "List tables in the Snowflake warehouse. Optionally scope to a database and schema, or filter names with a SQL LIKE pattern (e.g. '%ORDERS%'). Use this to discover what data is available before querying.",
  schema: j.object({
    database: j
      .string()
      .nullable()
      .describe(
        "Database to list from. Defaults to the worker's configured database."
      ),
    schema: j
      .string()
      .nullable()
      .describe(
        "Schema to list from. Defaults to the worker's configured schema."
      ),
    like: j
      .string()
      .nullable()
      .describe(
        "Case-insensitive LIKE pattern to filter table names, e.g. '%ORDER%'."
      ),
  }),
  execute: async ({ database, schema, like }) =>
    safely(() => runCommand(buildShowTables({ database, schema, like }))),
})

worker.tool("describeTable", {
  title: "Describe Table",
  description:
    "Describe a table's columns (name, type, nullability) so you know its shape before querying. Pass a fully qualified name like DATABASE.SCHEMA.TABLE.",
  schema: j.object({
    table: j
      .string()
      .describe(
        "Table to describe, ideally fully qualified as DATABASE.SCHEMA.TABLE."
      ),
  }),
  execute: async ({ table }) =>
    safely(() => runCommand(buildDescribeTable(table))),
})

worker.tool("query", {
  title: "Query Snowflake",
  description:
    "Run a read-only SQL SELECT against Snowflake and return the rows. Only a single SELECT (or WITH ... SELECT) is allowed; writes and other statements are rejected. Results are capped at maxRows.",
  schema: j.object({
    sql: j
      .string()
      .describe("A single read-only SELECT or WITH ... SELECT statement."),
    maxRows: j
      .number()
      .nullable()
      .describe("Maximum rows to return. Defaults to 100; capped at 1000."),
  }),
  execute: async ({ sql, maxRows }) =>
    safely(() => {
      assertSelectOnly(sql)
      return runQuery(sql, maxRows)
    }),
})

// Hand the agent a readable error instead of throwing, so it can correct itself.
async function safely<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn()
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
