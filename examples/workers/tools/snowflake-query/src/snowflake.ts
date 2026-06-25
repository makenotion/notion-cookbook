import snowflake from "snowflake-sdk"

import { buildBoundedQuery } from "./sql.js"

snowflake.configure({ logLevel: "ERROR" })

const HARD_MAX_ROWS = 1000
const DEFAULT_MAX_ROWS = Math.min(
  readPositiveInt("SNOWFLAKE_MAX_ROWS", 100),
  HARD_MAX_ROWS
)
const TIMEOUT_SECONDS = Math.min(
  readPositiveInt("SNOWFLAKE_QUERY_TIMEOUT_SECONDS", 60),
  300
)

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export type ColumnInfo = {
  name: string
  type: string | null
  nullable: boolean | null
}

export type QueryResult = {
  rows: Record<string, JsonValue>[]
  columns: ColumnInfo[]
  rowCount: number
  truncated: boolean
}

export async function runQuery(
  sql: string,
  requestedMaxRows: number | null
): Promise<QueryResult> {
  const maxRows = clamp(requestedMaxRows, DEFAULT_MAX_ROWS, HARD_MAX_ROWS)
  // The wrapper fetches one extra row so we can report truncation.
  const result = await execute(buildBoundedQuery(sql, maxRows))
  return capRows(result, maxRows)
}

// SHOW / DESCRIBE can't be wrapped in a subquery, so cap the rows in memory.
export async function runCommand(sql: string): Promise<QueryResult> {
  const result = await execute(sql)
  return capRows(result, HARD_MAX_ROWS)
}

function capRows(result: QueryResult, maxRows: number): QueryResult {
  const truncated = result.rows.length > maxRows
  const rows = truncated ? result.rows.slice(0, maxRows) : result.rows
  return { ...result, rows, rowCount: rows.length, truncated }
}

async function execute(sqlText: string): Promise<QueryResult> {
  const conn = createConnection()
  await connect(conn)
  try {
    await executeSql(
      conn,
      `ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = ${TIMEOUT_SECONDS}`
    )
    return await executeSql(conn, sqlText)
  } finally {
    // Don't let a teardown error mask the real query error.
    await destroy(conn).catch(() => {})
  }
}

function createConnection(): snowflake.Connection {
  const account = process.env.SNOWFLAKE_ACCOUNT ?? ""
  const username = process.env.SNOWFLAKE_USER ?? ""
  const warehouse = process.env.SNOWFLAKE_WAREHOUSE ?? ""
  const privateKey = process.env.SNOWFLAKE_PRIVATE_KEY ?? ""
  const privateKeyPass = process.env.SNOWFLAKE_PRIVATE_KEY_PASS
  const database = process.env.SNOWFLAKE_DATABASE
  const schema = process.env.SNOWFLAKE_SCHEMA
  const role = process.env.SNOWFLAKE_ROLE

  if (!account || !username || !warehouse || !privateKey) {
    throw new Error(
      "Missing Snowflake configuration. Set SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_WAREHOUSE, and SNOWFLAKE_PRIVATE_KEY."
    )
  }

  return snowflake.createConnection({
    account,
    username,
    warehouse,
    authenticator: "SNOWFLAKE_JWT",
    // A key stored as a one-line secret often has its newlines escaped.
    privateKey: privateKey.replace(/\\n/g, "\n"),
    ...(privateKeyPass ? { privateKeyPass } : {}),
    ...(database ? { database } : {}),
    ...(schema ? { schema } : {}),
    ...(role ? { role } : {}),
  })
}

function connect(conn: snowflake.Connection): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.connect((err) => (err ? reject(err) : resolve()))
  })
}

function destroy(conn: snowflake.Connection): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.destroy((err) => (err ? reject(err) : resolve()))
  })
}

function executeSql(
  conn: snowflake.Connection,
  sqlText: string
): Promise<QueryResult> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      complete: (err, stmt, rows) => {
        if (err) {
          reject(err)
          return
        }
        const rawRows = (rows ?? []) as Record<string, unknown>[]
        const columns = (stmt.getColumns?.() ?? []).map((column) => ({
          name: column.getName?.() ?? "",
          type: column.getType?.() ?? null,
          nullable: column.isNullable?.() ?? null,
        }))
        resolve({
          rows: rawRows.map(normalizeRow),
          columns,
          rowCount: rawRows.length,
          truncated: false,
        })
      },
    })
  })
}

function normalizeRow(row: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeValue(value)])
  )
}

function normalizeValue(value: unknown): JsonValue {
  if (value == null) return null
  if (typeof value === "string") return value
  if (typeof value === "number")
    return Number.isFinite(value) ? value : String(value)
  if (typeof value === "boolean") return value
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return value.toString("base64")
  if (Array.isArray(value)) return value.map(normalizeValue)
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        normalizeValue(nested),
      ])
    )
  }
  return String(value)
}

function clamp(value: number | null, fallback: number, max: number): number {
  if (value == null) return fallback
  const n = Math.floor(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(n, max)
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
