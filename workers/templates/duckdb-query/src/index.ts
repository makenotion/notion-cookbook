import { Worker } from "@notionhq/workers"
import { j } from "@notionhq/workers/schema-builder"

import { runCommand, runQuery } from "./duckdb.js"
import { assertSelectOnly, buildDescribeTable, buildListTables } from "./sql.js"

const worker = new Worker()
export default worker

// Three tools an agent can chain to answer questions about the demo database:
// find a table, check its columns, then query it.

worker.tool("listTables", {
  title: "List Tables",
  description:
    "List tables in the demo DuckDB database. The database is seeded with sample sales data: customers, products, orders, and order_items. Use this to discover what is available before querying.",
  schema: j.object({}),
  execute: async () => safely(() => runCommand(buildListTables())),
})

worker.tool("describeTable", {
  title: "Describe Table",
  description:
    "Describe a table's columns (name, type, nullability) so you know its shape before querying. Valid tables are: customers, products, orders, order_items.",
  schema: j.object({
    table: j.string().describe("Table name to describe."),
  }),
  execute: async ({ table }) =>
    safely(() => runCommand(buildDescribeTable(table))),
})

worker.tool("query", {
  title: "Query Demo Database (DuckDB)",
  description:
    "Run a read-only SQL SELECT against the in-memory DuckDB demo database and return the rows. Only a single SELECT (or WITH ... SELECT) is allowed; writes and other statements are rejected. Results are capped at maxRows.\n\nThe database contains sample sales data. Example questions to try:\n- Which customers have spent the most in total?\n- What is revenue by product category?\n- How many orders are in each status?\n- What is the monthly order volume trend?",
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
