import { Parser } from "node-sql-parser"

const parser = new Parser()

// We parse the statement instead of pattern-matching on keywords so comments
// and string literals can't smuggle in a write. This is a convenience check,
// not the security boundary -- that's the read-only Snowflake role (see README).
export function assertSelectOnly(sql: string): void {
  if (!sql.trim()) {
    throw new Error("sql must be a non-empty string.")
  }

  let statements
  try {
    statements = parser.astify(sql, { database: "Snowflake" })
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
  if (list[0]?.type !== "select") {
    throw new Error("Only read-only SELECT queries are allowed.")
  }
}

// Cap the result set and grab one extra row to detect truncation.
export function buildBoundedQuery(sql: string, maxRows: number): string {
  const inner = stripTrailingSemicolon(sql)
  return `SELECT * FROM (${inner}) AS query_result LIMIT ${maxRows + 1}`
}

export function buildShowTables(input: {
  database?: string | null
  schema?: string | null
  like?: string | null
}): string {
  let sql = "SHOW TABLES"

  if (input.like) {
    sql += ` LIKE '${input.like.replace(/'/g, "''")}'`
  }

  if (input.database && input.schema) {
    sql += ` IN SCHEMA ${ident(input.database, "database")}.${ident(input.schema, "schema")}`
  } else if (input.database) {
    sql += ` IN DATABASE ${ident(input.database, "database")}`
  } else if (input.schema) {
    sql += ` IN SCHEMA ${ident(input.schema, "schema")}`
  }

  return sql
}

export function buildDescribeTable(table: string): string {
  const parts = table.trim().split(".")
  if (parts.length > 3) {
    throw new Error(`Invalid table name: ${table}. Use DATABASE.SCHEMA.TABLE.`)
  }
  const validated = parts.map((part) => ident(part, "table"))
  return `DESCRIBE TABLE ${validated.join(".")}`
}

// Reject anything that isn't a bare identifier so a name can't carry extra SQL
// into a SHOW/DESCRIBE statement.
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
