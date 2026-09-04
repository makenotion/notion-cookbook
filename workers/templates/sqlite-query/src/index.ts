import { Worker } from "@notionhq/workers"
import { j } from "@notionhq/workers/schema-builder"

import { runCommand, runQuery } from "./sqlite.js"
import { assertSelectOnly, buildDescribeTable, buildListTables } from "./sql.js"

const worker = new Worker()
export default worker

// Three tools an agent can chain to explore and query the demo database:
// discover tables, inspect columns, then run a SELECT.

worker.tool("listTables", {
  title: "List Tables",
  description:
    "List the tables available in the demo SQLite database. This database is seeded with sample sales data: customers, products, orders, and order_items. Use this first to discover what data is available.",
  schema: j.object({}),
  execute: async () => safely(() => runCommand(buildListTables())),
})

worker.tool("describeTable", {
  title: "Describe Table",
  description:
    "Describe a table's columns (name, type, constraints) so you know its shape before querying. Pass the table name exactly as returned by listTables.",
  schema: j.object({
    table: j
      .string()
      .describe("Table name to describe, e.g. 'orders' or 'customers'."),
  }),
  execute: async ({ table }) =>
    safely(() => runCommand(buildDescribeTable(table))),
})

worker.tool("query", {
  title: "Query Demo Database (SQLite)",
  description:
    "Run a read-only SQL SELECT against the in-memory SQLite demo database and return the rows. Only a single SELECT (or WITH ... SELECT) is allowed; writes are rejected. Results are capped at maxRows (default 100, max 1000).\n\nExample questions you can answer:\n- 'Who are the top customers by total spend?'\n- 'What is revenue by product category?'\n- 'How many orders are in each status?'\n- 'Which products appear most often in completed orders?'",
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
