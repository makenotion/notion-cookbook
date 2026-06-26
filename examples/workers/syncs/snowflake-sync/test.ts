// Offline tests for the snowflake-sync worker.
// No Snowflake connection is made — all assertions run against pure functions.
// Run: npm test  (or: npx tsx test.ts)

import { buildPageSql } from "./src/snowflake.js"
import { rowToChange } from "./src/transform.js"

let passed = 0
let failed = 0

function ok(name: string, cond: boolean) {
  if (cond) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}`)
  }
}

// ---------------------------------------------------------------------------
// buildPageSql — wraps query in a subquery with LIMIT/OFFSET
// ---------------------------------------------------------------------------

console.log("buildPageSql:")

ok(
  "wraps query with LIMIT and OFFSET",
  buildPageSql("SELECT id FROM t", 200, 0) ===
    "SELECT * FROM (\nSELECT id FROM t\n) AS src LIMIT 200 OFFSET 0"
)

ok(
  "strips a trailing semicolon",
  buildPageSql("SELECT id FROM t;", 200, 0) ===
    "SELECT * FROM (\nSELECT id FROM t\n) AS src LIMIT 200 OFFSET 0"
)

ok(
  "strips semicolon with trailing whitespace",
  buildPageSql("SELECT id FROM t ;  ", 200, 0) ===
    "SELECT * FROM (\nSELECT id FROM t\n) AS src LIMIT 200 OFFSET 0"
)

ok(
  "applies non-zero offset",
  buildPageSql("SELECT id FROM t", 200, 400) ===
    "SELECT * FROM (\nSELECT id FROM t\n) AS src LIMIT 200 OFFSET 400"
)

ok(
  "preserves a trailing line comment (comment cannot swallow LIMIT)",
  buildPageSql("SELECT id FROM t -- filter", 50, 0) ===
    "SELECT * FROM (\nSELECT id FROM t -- filter\n) AS src LIMIT 50 OFFSET 0"
)

// ---------------------------------------------------------------------------
// rowToChange — maps Snowflake row to a sync upsert change
// ---------------------------------------------------------------------------

console.log("rowToChange — UPPERCASE keys (Snowflake default):")

const uppercaseRow = {
  ID: "user-1",
  NAME: "Alice",
  EMAIL: "alice@example.com",
  STATUS: "Active",
  UPDATED_AT: "2024-03-15",
}

const upperChange = rowToChange(uppercaseRow)

ok("returns non-null", upperChange !== null)
ok("type is upsert", upperChange?.type === "upsert")
ok("key equals ID", upperChange?.key === "user-1")
ok(
  "Name property set",
  (upperChange?.properties.Name as { content?: string } | undefined)
    ?.content === "Alice" ||
    JSON.stringify(upperChange?.properties.Name).includes("Alice")
)
ok(
  "Email property set",
  JSON.stringify(upperChange?.properties.Email).includes("alice@example.com")
)
ok(
  "Status property set",
  JSON.stringify(upperChange?.properties.Status).includes("Active")
)
ok(
  "Updated At property set",
  JSON.stringify(upperChange?.properties["Updated At"]).includes("2024-03-15")
)

console.log("rowToChange — lowercase keys:")

const lowercaseRow = {
  id: "user-2",
  name: "Bob",
  email: "bob@example.com",
  status: "Inactive",
  updated_at: "2024-06-01T08:00:00Z",
}

const lowerChange = rowToChange(lowercaseRow)

ok("returns non-null", lowerChange !== null)
ok("key equals id", lowerChange?.key === "user-2")
ok(
  "Updated At truncates ISO timestamp to date",
  JSON.stringify(lowerChange?.properties["Updated At"]).includes("2024-06-01")
)

console.log("rowToChange — edge cases:")

ok("null ID returns null", rowToChange({ ID: null, NAME: "Ghost" }) === null)
ok(
  "missing ID returns null",
  rowToChange({ NAME: "No ID Row" } as Record<string, unknown>) === null
)
ok("empty string ID returns null", rowToChange({ ID: "" }) === null)

ok(
  "null UPDATED_AT omits the Updated At property",
  rowToChange({ ID: "x", UPDATED_AT: null })?.properties["Updated At"] ===
    undefined
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
