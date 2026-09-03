import { Parser } from "node-sql-parser"

const parser = new Parser()

// We parse the statement instead of pattern-matching on keywords so comments
// and string literals can't smuggle in a write. This is a convenience check,
// not the security boundary — that's the read-only Postgres role (see README).
export function assertSelectOnly(sql: string): void {
  if (!sql.trim()) {
    throw new Error("sql must be a non-empty string.")
  }

  let statements
  try {
    statements = parser.astify(sql, { database: "Postgresql" })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Could not parse SQL as a read-only SELECT query: ${detail}`
    )
  }

  const list = Array.isArray(statements) ? statements : [statements]
  if (list.length !== 1) {
    throw new Error("Only one SQL statement is allowed.")
  }
  // WITH ... SELECT parses as a select node with a .with clause.
  const statement = list[0]
  if (statement?.type !== "select") {
    throw new Error("Only read-only SELECT queries are allowed.")
  }
  // `SELECT ... INTO <target>` parses as a select but writes; reject it.
  // A normal select has `into: { position: null }`; an INTO clause sets `expr`.
  const into = (statement as { into?: { expr?: unknown } }).into
  if (into?.expr != null) {
    throw new Error("Only read-only SELECT queries are allowed.")
  }
}

// Cap the result set and grab one extra row to detect truncation. The inner
// query sits on its own line so a trailing line comment (-- ...) can't swallow
// the closing paren and LIMIT.
export function buildBoundedQuery(sql: string, maxRows: number): string {
  const inner = stripTrailingSemicolon(sql)
  return `SELECT * FROM (\n${inner}\n) AS query_result LIMIT ${maxRows + 1}`
}

// Returns a parameterized query for listing tables from information_schema.
// Using $1/$2 placeholders means no quoting or injection is possible.
export function buildListTables(input: {
  schema?: string | null
  like?: string | null
}): { text: string; values: unknown[] } {
  const schema = input.schema ?? "public"

  if (input.like) {
    return {
      text:
        "SELECT table_schema, table_name, table_type" +
        " FROM information_schema.tables" +
        " WHERE table_schema = $1 AND table_name ILIKE $2" +
        " ORDER BY table_name",
      values: [schema, input.like],
    }
  }

  return {
    text:
      "SELECT table_schema, table_name, table_type" +
      " FROM information_schema.tables" +
      " WHERE table_schema = $1" +
      " ORDER BY table_name",
    values: [schema],
  }
}

// Returns a parameterized query for describing a table's columns.
export function buildDescribeTable(input: {
  table: string
  schema?: string | null
}): { text: string; values: unknown[] } {
  const schema = input.schema ?? "public"
  return {
    text:
      "SELECT column_name, data_type, is_nullable" +
      " FROM information_schema.columns" +
      " WHERE table_schema = $1 AND table_name = $2" +
      " ORDER BY ordinal_position",
    values: [schema, input.table],
  }
}

function stripTrailingSemicolon(sql: string): string {
  const trimmed = sql.trim()
  return trimmed.endsWith(";") ? trimmed.slice(0, -1).trim() : trimmed
}
