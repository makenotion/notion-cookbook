import * as crypto from "node:crypto"
import type { SfStatementResponse } from "./types.js"

// Snowflake's SQL REST API authenticates via a short-lived JWT signed with
// the user's private key. The corresponding public key must be uploaded
// to the Snowflake user with `ALTER USER ... SET RSA_PUBLIC_KEY = '...'`.
// See https://docs.snowflake.com/en/developer-guide/sql-api/authenticating

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} is not set. Run \`ntn workers env set ${name}=...\`.`
    )
  }
  return value
}

// Build the JWT Snowflake expects:
//   iss = <ACCOUNT>.<USER>.SHA256:<public-key-fingerprint>
//   sub = <ACCOUNT>.<USER>
//   iat / exp — 1 hour validity
//
// The public key fingerprint is derived from the private key so the user
// only has to provide one secret. Snowflake-identifier components are
// upper-cased to match how the database stores them.
function mintJwt(): string {
  const account = requireEnv("SNOWFLAKE_ACCOUNT").toUpperCase()
  const user = requireEnv("SNOWFLAKE_USER").toUpperCase()
  const pem = requireEnv("SNOWFLAKE_PRIVATE_KEY")

  const privateKey = crypto.createPrivateKey(pem)
  const publicKeyDer = crypto
    .createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
  const fingerprint = `SHA256:${crypto
    .createHash("sha256")
    .update(publicKeyDer)
    .digest("base64")}`

  const qualifiedUser = `${account}.${user}`
  const now = Math.floor(Date.now() / 1000)

  const header = base64UrlEncode(
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  )
  const payload = base64UrlEncode(
    Buffer.from(
      JSON.stringify({
        iss: `${qualifiedUser}.${fingerprint}`,
        sub: qualifiedUser,
        iat: now,
        exp: now + 3600,
      })
    )
  )

  const signingInput = `${header}.${payload}`
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(signingInput)
    .sign(privateKey)

  return `${signingInput}.${base64UrlEncode(signature)}`
}

// Refuse anything that isn't a read-only SELECT/WITH query, and reject
// multi-statement input to keep the tool safe to expose to an agent.
function assertReadOnly(query: string): string {
  const cleaned = query.trim().replace(/;\s*$/, "")
  if (cleaned.includes(";")) {
    throw new Error(
      "Multi-statement queries are not allowed. Submit one SELECT or WITH statement."
    )
  }
  if (!/^(select|with)\b/i.test(cleaned)) {
    throw new Error("Only SELECT and WITH queries are permitted.")
  }
  return cleaned
}

export async function runQuery(
  rawQuery: string,
  requestedRowLimit: number | null
) {
  const safeQuery = assertReadOnly(rawQuery)

  // Clamp the row limit. The agent can ask for fewer rows; we never
  // return more than the hard cap to keep responses small.
  const cap = 1000
  const limit = Math.max(1, Math.min(cap, requestedRowLimit ?? 100))

  // Wrap the user query so the warehouse enforces the cap — cheaper
  // than fetching everything and slicing client-side.
  const wrapped = `SELECT * FROM (${safeQuery}) LIMIT ${limit + 1}`

  const account = requireEnv("SNOWFLAKE_ACCOUNT")
  const warehouse = requireEnv("SNOWFLAKE_WAREHOUSE")
  const role = requireEnv("SNOWFLAKE_ROLE")
  const database = process.env.SNOWFLAKE_DATABASE
  const schema = process.env.SNOWFLAKE_SCHEMA

  const jwt = mintJwt()
  const url = `https://${account}.snowflakecomputing.com/api/v2/statements`

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      statement: wrapped,
      warehouse,
      role,
      ...(database ? { database } : {}),
      ...(schema ? { schema } : {}),
    }),
  })

  // 202 = query still running. Polling would 2x the code; for an
  // example, we tell the caller to optimize their query instead.
  if (res.status === 202) {
    throw new Error(
      "Query took longer than the synchronous timeout. Run a smaller query or aggregate server-side."
    )
  }
  if (!res.ok) {
    throw new Error(`Snowflake API error: ${res.status} ${await res.text()}`)
  }

  const body = (await res.json()) as SfStatementResponse
  const columns = body.resultSetMetaData?.rowType.map((c) => c.name) ?? []
  const rawRows = body.data ?? []

  // We requested `limit + 1` rows so we can detect truncation: if the
  // warehouse returned the extra row, the user's result set has more
  // data than the cap allowed us to return.
  const truncated = rawRows.length > limit
  const rows = truncated ? rawRows.slice(0, limit) : rawRows

  return { columns, rows, rowCount: rows.length, truncated }
}
