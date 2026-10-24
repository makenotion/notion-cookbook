// This is a lightweight convenience check (single statement, must start with
// SELECT/WITH, rejects INTO), NOT the security boundary. DuckDB can read host
// files and the network from INSIDE a SELECT via table functions (read_csv,
// read_text, glob, httpfs) — a keyword guard cannot catch those. The real
// boundary is in duckdb.ts, which creates the engine with
// `enable_external_access: "false"` so those functions are disabled; the query
// path also never calls conn.run(), so writes can't persist. For a full
// parser-based guard see the postgres-query or snowflake-query examples.

export function assertSelectOnly(sql: string): void {
  const stripped = stripTrailingSemicolon(sql)

  if (!stripped) {
    throw new Error("sql must be a non-empty string.")
  }

  // Reject anything with a semicolon after the trailing one is removed —
  // that implies multiple statements.
  if (stripped.includes(";")) {
    throw new Error("Only one SQL statement is allowed.")
  }

  // Must start with SELECT or WITH (covers WITH ... SELECT CTEs).
  if (!/^\s*(select|with)\b/i.test(stripped)) {
    throw new Error("Only read-only SELECT queries are allowed.")
  }

  // Block SELECT ... INTO <target>, which writes a new table.
  if (/\binto\b/i.test(stripped)) {
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

// Returns a plain SQL string for listing tables in the demo database.
// No user input is accepted — DuckDB's default schema is 'main'.
export function buildListTables(): string {
  return (
    "SELECT table_name, table_type" +
    " FROM information_schema.tables" +
    " WHERE table_schema = 'main'" +
    " ORDER BY table_name"
  )
}

// Returns a plain SQL string for describing a table's columns.
// The table name is validated as a bare identifier to prevent SQL injection
// (no bind parameters needed for information_schema string literals in DuckDB,
// but we still guard the name).
export function buildDescribeTable(table: string): string {
  const validated = ident(table, "table")
  return (
    "SELECT column_name, data_type, is_nullable" +
    " FROM information_schema.columns" +
    " WHERE table_schema = 'main'" +
    ` AND table_name = '${validated}'` +
    " ORDER BY ordinal_position"
  )
}

// Reject anything that isn't a bare identifier so a name can't carry extra SQL
// into a query string.
function ident(value: string, label: string): string {
  const trimmed = value.trim()
  if (!/^[A-Za-z0-9_$]+$/.test(trimmed)) {
    throw new Error(`Invalid ${label} name: ${value}`)
  }
  return trimmed
}

function stripTrailingSemicolon(sql: string): string {
  const trimmed = sql.trim()
  return trimmed.endsWith(";") ? trimmed.slice(0, -1).trim() : trimmed
}
