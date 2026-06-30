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

// Module-level singleton — the in-memory database is created once per process
// and reused across all sync executions. Seeding is instant.
let connectionPromise: Promise<DuckDBConnection> | null = null

function getConnection(): Promise<DuckDBConnection> {
  if (!connectionPromise) {
    connectionPromise = (async () => {
      // Disable DuckDB's external file/network access as a hardening default.
      // This worker only runs fixed internal SELECTs, but keeping external
      // access off matches the duckdb-query tool and is the safe default for any
      // engine you might later point at agent-supplied SQL.
      const instance = await DuckDBInstance.create(":memory:", {
        enable_external_access: "false",
      })
      const conn = await instance.connect()
      await seedDatabase(conn)
      return conn
    })()
  }
  return connectionPromise
}

// Run a fixed internal SELECT and return plain JS objects with JSON-safe values.
export async function fetchRows(
  sql: string
): Promise<Record<string, unknown>[]> {
  const conn = await getConnection()
  const reader = await conn.runAndReadAll(sql)
  const rawRows = reader.getRowObjects() as Record<string, unknown>[]
  return rawRows.map(normalizeRow)
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeValue(value)])
  )
}

// DuckDB returns native JS types for most columns, but DATE, TIMESTAMP, and
// DECIMAL come back as special value objects. BigInt appears for BIGINT columns.
// We convert everything to a JSON-safe primitive.
export function normalizeValue(value: unknown): unknown {
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
