import { Worker } from "@notionhq/workers"
import { j } from "@notionhq/workers/schema-builder"

import { runCommand, runQuery } from "./postgres.js"
import { assertSelectOnly, buildDescribeTable, buildListTables } from "./sql.js"

const worker = new Worker()
export default worker

// Three tools an agent can chain to answer questions about a database:
// find a table, check its columns, then query it.

worker.tool("listTables", {
  title: "List Tables",
  description:
    "List tables in the Postgres database. Optionally scope to a schema, or filter names with an ILIKE pattern (e.g. '%orders%'). Use this to discover what data is available before querying.",
  schema: j.object({
    schema: j
      .string()
      .nullable()
      .describe("Schema to list from. Defaults to 'public'."),
    like: j
      .string()
      .nullable()
      .describe(
        "Case-insensitive ILIKE pattern to filter table names, e.g. '%order%'."
      ),
  }),
  execute: async ({ schema, like }) =>
    safely(() => runCommand(buildListTables({ schema, like }))),
})

worker.tool("describeTable", {
  title: "Describe Table",
  description:
    "Describe a table's columns (name, type, nullability) so you know its shape before querying. Pass the table name, optionally with a schema (default public).",
  schema: j.object({
    table: j.string().describe("Table name to describe."),
    schema: j
      .string()
      .nullable()
      .describe("Schema the table lives in. Defaults to 'public'."),
  }),
  execute: async ({ table, schema }) =>
    safely(() => runCommand(buildDescribeTable({ table, schema }))),
})

worker.tool("query", {
  title: "Query Postgres",
  description:
    "Run a read-only SQL SELECT against Postgres and return the rows. Only a single SELECT (or WITH ... SELECT) is allowed; writes and other statements are rejected. Results are capped at maxRows.",
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
