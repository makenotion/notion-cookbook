import {
  DuckDBBlobValue,
  DuckDBConnection,
  DuckDBDateValue,
  DuckDBDecimalValue,
  DuckDBInstance,
  DuckDBTimestampMicrosecondsValue,
  DuckDBTimestampMillisecondsValue,
  DuckDBTimestampNanosecondsValue,
  DuckDBTimestampSecondsValue,
  DuckDBTimestampTZValue,
  DuckDBTimestampValue,
  dateFromDateValue,
  dateFromTimestampMillisecondsValue,
  dateFromTimestampNanosecondsValue,
  dateFromTimestampSecondsValue,
  dateFromTimestampTZValue,
  dateFromTimestampValue,
  doubleFromDecimalValue,
} from "@duckdb/node-api"

import { seedDatabase } from "./seed.js"
import { buildBoundedQuery } from "./sql.js"

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

// Module-level singleton — the in-memory database is created once per process
// and reused across all tool calls. Seeding is instant.
let connectionPromise: Promise<DuckDBConnection> | null = null

function getConnection(): Promise<DuckDBConnection> {
  if (!connectionPromise) {
    connectionPromise = (async () => {
      // Harden the in-process engine. Agent-supplied SQL runs here, and DuckDB's
      // file/network table functions (read_csv, read_text, glob, and httpfs
      // read_json/read_parquet) are used INSIDE a SELECT, so a keyword guard
      // can't catch them. Disabling external access closes that local-file-read
      // and SSRF surface; the memory/thread caps bound resource use per query.
      const instance = await DuckDBInstance.create(":memory:", {
        enable_external_access: "false",
        memory_limit: "512MB",
        threads: "2",
      })
      const conn = await instance.connect()
      await seedDatabase(conn)
      return conn
    })()
  }
  return connectionPromise
}

export async function runQuery(
  sql: string,
  requestedMaxRows: number | null
): Promise<QueryResult> {
  const maxRows = clamp(requestedMaxRows, DEFAULT_MAX_ROWS, HARD_MAX_ROWS)
  // Fetch one extra row so we can detect truncation without a separate COUNT.
  const bounded = buildBoundedQuery(sql, maxRows)
  const conn = await getConnection()
  const reader = await conn.runAndReadAll(bounded)
  const rawRows = reader.getRowObjects() as Record<string, unknown>[]
  const names = reader.columnNames()
  const types = reader.columnTypes()

  const columns: ColumnInfo[] = names.map((name, i) => ({
    name,
    type: types[i]?.toString() ?? null,
    nullable: null,
  }))

  const rows = rawRows.map(normalizeRow)
  return capRows(
    { rows, columns, rowCount: rows.length, truncated: false },
    maxRows
  )
}

// information_schema queries are plain strings — no user input, no injection
// risk — but we run them through the same result path for consistency.
export async function runCommand(sql: string): Promise<QueryResult> {
  const conn = await getConnection()
  const reader = await conn.runAndReadAll(sql)
  const rawRows = reader.getRowObjects() as Record<string, unknown>[]
  const names = reader.columnNames()
  const types = reader.columnTypes()

  const columns: ColumnInfo[] = names.map((name, i) => ({
    name,
    type: types[i]?.toString() ?? null,
    nullable: null,
  }))

  const rows = rawRows.map(normalizeRow)
  return capRows(
    { rows, columns, rowCount: rows.length, truncated: false },
    HARD_MAX_ROWS
  )
}

function capRows(result: QueryResult, maxRows: number): QueryResult {
  const truncated = result.rows.length > maxRows
  const rows = truncated ? result.rows.slice(0, maxRows) : result.rows
  return { ...result, rows, rowCount: rows.length, truncated }
}

function normalizeRow(row: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeValue(value)])
  )
}

// DuckDB returns native JS types for most columns, but DATE, TIMESTAMP, and
// DECIMAL come back as special value objects. BigInt appears for BIGINT columns.
// We convert everything to a JSON-safe primitive.
export function normalizeValue(value: unknown): JsonValue {
  if (value == null) return null
  if (typeof value === "boolean") return value
  if (typeof value === "string") return value
  if (typeof value === "number")
    return Number.isFinite(value) ? value : String(value)

  // BIGINT — safe as a JS number if it fits, otherwise a string
  if (typeof value === "bigint") {
    const n = Number(value)
    return Number.isSafeInteger(n) ? n : value.toString()
  }

  // DECIMAL(p, s) — convert to a JS double via the official helper
  if (value instanceof DuckDBDecimalValue) {
    return doubleFromDecimalValue(value)
  }

  // DATE — convert days-since-epoch to an ISO date string
  if (value instanceof DuckDBDateValue) {
    return dateFromDateValue(value).toISOString().slice(0, 10)
  }

  // TIMESTAMP variants — convert micros/millis/nanos/seconds to ISO string
  if (value instanceof DuckDBTimestampValue) {
    return dateFromTimestampValue(value).toISOString()
  }
  if (value instanceof DuckDBTimestampMicrosecondsValue) {
    // DuckDBTimestampValue is the microseconds variant; alias for clarity
    return dateFromTimestampValue(
      value as unknown as DuckDBTimestampValue
    ).toISOString()
  }
  if (value instanceof DuckDBTimestampMillisecondsValue) {
    return dateFromTimestampMillisecondsValue(value).toISOString()
  }
  if (value instanceof DuckDBTimestampNanosecondsValue) {
    return dateFromTimestampNanosecondsValue(value).toISOString()
  }
  if (value instanceof DuckDBTimestampSecondsValue) {
    return dateFromTimestampSecondsValue(value).toISOString()
  }
  if (value instanceof DuckDBTimestampTZValue) {
    return dateFromTimestampTZValue(value).toISOString()
  }

  // BLOB — encode as base64
  if (value instanceof DuckDBBlobValue) {
    return Buffer.from(value.bytes).toString("base64")
  }

  // Arrays and nested objects (LIST, STRUCT, MAP)
  if (Array.isArray(value)) return value.map(normalizeValue)
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        normalizeValue(v),
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
