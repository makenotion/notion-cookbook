import snowflake from "snowflake-sdk"

snowflake.configure({ logLevel: "ERROR" })

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export function createConnection(): snowflake.Connection {
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

export function executeSql(
  conn: snowflake.Connection,
  sqlText: string
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      complete: (err, _stmt, rows) => {
        if (err) {
          reject(err)
          return
        }
        resolve((rows ?? []) as Record<string, unknown>[])
      },
    })
  })
}

export function normalizeValue(value: unknown): JsonValue {
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

export function clamp(
  value: number | null,
  fallback: number,
  max: number
): number {
  if (value == null) return fallback
  const n = Math.floor(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(n, max)
}

export function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Build the paginated subquery string without executing it.
 * Exported so it can be tested without a Snowflake connection.
 */
export function buildPageSql(
  query: string,
  limit: number,
  offset: number
): string {
  // Strip trailing whitespace and a trailing semicolon so it doesn't break
  // the subquery wrapper. Trim again after removing the semicolon to handle
  // patterns like "SELECT 1 ;  ".
  const trimmed = query.trimEnd().replace(/;$/, "").trimEnd()
  return `SELECT * FROM (\n${trimmed}\n) AS src LIMIT ${limit} OFFSET ${offset}`
}

/**
 * Fetch one page of rows from a query using LIMIT/OFFSET pagination.
 *
 * @param query  A SELECT statement (trailing semicolon is stripped automatically).
 * @param limit  Maximum rows to return for this page.
 * @param offset Row offset to start from.
 */
export async function fetchPage(
  query: string,
  limit: number,
  offset: number
): Promise<Record<string, unknown>[]> {
  const sql = buildPageSql(query, limit, offset)
  const conn = createConnection()
  await connect(conn)
  try {
    const rows = await executeSql(conn, sql)
    return rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, normalizeValue(value)])
      )
    )
  } finally {
    await destroy(conn).catch(() => {})
  }
}
