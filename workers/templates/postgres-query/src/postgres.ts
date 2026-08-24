import pg from "pg"

import { buildBoundedQuery } from "./sql.js"

const HARD_MAX_ROWS = 1000
const DEFAULT_MAX_ROWS = Math.min(
  readPositiveInt("POSTGRES_MAX_ROWS", 100),
  HARD_MAX_ROWS
)
const TIMEOUT_SECONDS = Math.min(
  readPositiveInt("POSTGRES_QUERY_TIMEOUT_SECONDS", 60),
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
  const result = await executeSelect(buildBoundedQuery(sql, maxRows))
  return capRows(result, maxRows)
}

// information_schema queries can't be wrapped in a subquery the same way,
// so run them directly and cap the rows in memory.
export async function runCommand(query: {
  text: string
  values: unknown[]
}): Promise<QueryResult> {
  const result = await executeCommand(query)
  return capRows(result, HARD_MAX_ROWS)
}

function capRows(result: QueryResult, maxRows: number): QueryResult {
  const truncated = result.rows.length > maxRows
  const rows = truncated ? result.rows.slice(0, maxRows) : result.rows
  return { ...result, rows, rowCount: rows.length, truncated }
}

// Run a SELECT inside a read-only transaction for defense in depth.
// assertSelectOnly already validated the SQL; this is an extra layer.
async function executeSelect(sql: string): Promise<QueryResult> {
  const client = createClient()
  await client.connect()
  try {
    await client.query("BEGIN")
    await client.query("SET TRANSACTION READ ONLY")
    if (TIMEOUT_SECONDS > 0) {
      await client.query(
        `SET LOCAL statement_timeout = ${TIMEOUT_SECONDS * 1000}`
      )
    }
    const result = await client.query(sql)
    // We only read, so rollback is the clean path (avoids any savepoint overhead).
    await client.query("ROLLBACK")
    return toQueryResult(result)
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {})
    throw err
  } finally {
    await client.end().catch(() => {})
  }
}

// Run a parameterized information_schema query (no transaction needed — read-only by construction).
async function executeCommand(query: {
  text: string
  values: unknown[]
}): Promise<QueryResult> {
  const client = createClient()
  await client.connect()
  try {
    const result = await client.query(query)
    return toQueryResult(result)
  } finally {
    await client.end().catch(() => {})
  }
}

function toQueryResult(result: pg.QueryResult): QueryResult {
  // pg exposes field names but not type names or nullability at query time;
  // use describeTable for full column introspection.
  const columns: ColumnInfo[] = result.fields.map((field) => ({
    name: field.name,
    type: null,
    nullable: null,
  }))

  return {
    rows: (result.rows as Record<string, unknown>[]).map(normalizeRow),
    columns,
    rowCount: result.rows.length,
    truncated: false,
  }
}

function createClient(): pg.Client {
  const url = process.env.DATABASE_URL
  const host = process.env.PGHOST
  const database = process.env.PGDATABASE
  const user = process.env.PGUSER

  if (!url && !(host && database && user)) {
    throw new Error(
      "Missing Postgres configuration. Set DATABASE_URL, or set PGHOST, PGDATABASE, and PGUSER."
    )
  }

  // If DATABASE_URL is set, pass it directly; otherwise pg reads PG* vars automatically.
  return url ? new pg.Client({ connectionString: url }) : new pg.Client()
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
