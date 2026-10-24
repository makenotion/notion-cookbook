import { DatabaseSync } from "node:sqlite"

import { buildBoundedQuery } from "./sql.js"
import { SCHEMA_SQL, SEED_SQL } from "./seed.js"

const HARD_MAX_ROWS = 1000
const DEFAULT_MAX_ROWS = 100

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

// Module-level singleton: the DB is opened and seeded once per process,
// then reused for every tool call.
let _db: DatabaseSync | null = null

function getDb(): DatabaseSync {
  if (_db === null) {
    const db = new DatabaseSync(":memory:")
    db.exec(SCHEMA_SQL)
    db.exec(SEED_SQL)
    _db = db
  }
  return _db
}

export async function runQuery(
  sql: string,
  requestedMaxRows: number | null
): Promise<QueryResult> {
  const maxRows = clamp(requestedMaxRows, DEFAULT_MAX_ROWS, HARD_MAX_ROWS)
  // Fetch one extra row so we can report whether the result was truncated.
  const bounded = buildBoundedQuery(sql, maxRows)
  const db = getDb()
  const rows = db.prepare(bounded).all() as Record<string, unknown>[]
  return capRows(toQueryResult(rows), maxRows)
}

// Run a catalog or PRAGMA query (list tables, describe table) and cap in memory.
export async function runCommand(sql: string): Promise<QueryResult> {
  const db = getDb()
  const rows = db.prepare(sql).all() as Record<string, unknown>[]
  return capRows(toQueryResult(rows), HARD_MAX_ROWS)
}

function capRows(result: QueryResult, maxRows: number): QueryResult {
  const truncated = result.rows.length > maxRows
  const rows = truncated ? result.rows.slice(0, maxRows) : result.rows
  return { ...result, rows, rowCount: rows.length, truncated }
}

function toQueryResult(rows: Record<string, unknown>[]): QueryResult {
  // Derive column names from the first row's keys (SQLite doesn't expose
  // field metadata separately from the result set).
  const columns: ColumnInfo[] =
    rows.length > 0
      ? Object.keys(rows[0]).map((name) => ({
          name,
          type: null,
          nullable: null,
        }))
      : []

  return {
    rows: rows.map(normalizeRow),
    columns,
    rowCount: rows.length,
    truncated: false,
  }
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
  // SQLite returns bigint for INTEGER columns when the value exceeds
  // Number.MAX_SAFE_INTEGER; keep precision by stringifying when needed.
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
      value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString()
  }
  // SQLite BLOBs come back as Buffer (Node.js Buffer or Uint8Array).
  if (Buffer.isBuffer(value)) return value.toString("base64")
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64")
  if (Array.isArray(value)) return value.map(normalizeValue)
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
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
