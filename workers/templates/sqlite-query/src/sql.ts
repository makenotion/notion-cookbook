import { Parser } from "node-sql-parser"

const parser = new Parser()

// We parse the statement instead of pattern-matching on keywords so comments
// and string literals can't smuggle in a write. The demo has no external
// security boundary, so this is the only write guard — keep it strict.
export function assertSelectOnly(sql: string): void {
  if (!sql.trim()) {
    throw new Error("sql must be a non-empty string.")
  }

  let statements
  try {
    statements = parser.astify(sql, { database: "Sqlite" })
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

// List all user-created tables in the database.
export function buildListTables(): string {
  return (
    "SELECT name FROM sqlite_master" +
    " WHERE type = 'table' AND name NOT LIKE 'sqlite_%'" +
    " ORDER BY name"
  )
}

// Return column metadata for a table via PRAGMA table_info.
// PRAGMA statements cannot be parameterized, so we validate the identifier
// with a strict regex before interpolating it (mirrors snowflake-query's ident()).
export function buildDescribeTable(table: string): string {
  const trimmed = table.trim()
  if (!/^[A-Za-z0-9_$]+$/.test(trimmed)) {
    throw new Error(`Invalid table name: ${table}`)
  }
  return `PRAGMA table_info(${trimmed})`
}

function stripTrailingSemicolon(sql: string): string {
  const trimmed = sql.trim()
  return trimmed.endsWith(";") ? trimmed.slice(0, -1).trim() : trimmed
}
