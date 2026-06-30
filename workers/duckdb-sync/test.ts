// Offline test harness — uses the real in-memory seeded DuckDB.
// No Notion credentials required.
// Run: npm test  (or: npx tsx test.ts)

import { fetchRows } from "./src/duckdb.js"
import { customerToChange } from "./src/transform.js"

let passed = 0
let failed = 0

function ok(label: string, condition: boolean): void {
  if (condition) {
    passed++
    console.log(`  ok   ${label}`)
  } else {
    failed++
    console.log(`  FAIL ${label}`)
  }
}

async function runTests() {
  // fetchRows returns all 8 seeded customers
  console.log("fetchRows — customers:")
  const rows = await fetchRows(
    "SELECT id, name, email, country, signup_date FROM customers ORDER BY id"
  )

  ok("returns 8 rows", rows.length === 8)

  // Known seed row: id=1, Acme Corp, acme@example.com, US, 2023-01-15
  const first = rows[0] as {
    id: unknown
    name: unknown
    email: unknown
    country: unknown
    signup_date: unknown
  }

  ok("first row id is 1", String(first.id) === "1")
  ok("first row name is Acme Corp", String(first.name) === "Acme Corp")
  ok(
    "first row email is acme@example.com",
    String(first.email) === "acme@example.com"
  )
  ok("first row country is US", String(first.country) === "US")
  ok(
    "first row signup_date is 2023-01-15",
    String(first.signup_date) === "2023-01-15"
  )

  // customerToChange produces the expected shape
  console.log("customerToChange — known row:")
  const change = customerToChange(first)

  ok("change type is upsert", change.type === "upsert")
  ok("change key matches id", change.key === "1")

  // Builder values are objects — verify text content via JSON roundtrip
  const p = change.properties
  ok(
    "Name property contains Acme Corp",
    JSON.stringify(p["Name"]).includes("Acme Corp")
  )
  ok(
    "Customer ID property contains 1",
    JSON.stringify(p["Customer ID"]).includes("1")
  )
  ok(
    "Email property contains acme@example.com",
    JSON.stringify(p["Email"]).includes("acme@example.com")
  )
  ok(
    "Country property contains US",
    JSON.stringify(p["Country"]).includes("US")
  )
  ok(
    "Signup Date property contains 2023-01-15",
    JSON.stringify(p["Signup Date"]).includes("2023-01-15")
  )

  // All 8 changes have type upsert and non-empty key
  console.log("all changes — type and key:")
  const allChanges = rows.map((row) =>
    customerToChange(
      row as {
        id: unknown
        name: unknown
        email: unknown
        country: unknown
        signup_date: unknown
      }
    )
  )

  ok(
    "all changes have type upsert",
    allChanges.every((c) => c.type === "upsert")
  )
  ok(
    "all changes have non-empty key",
    allChanges.every((c) => c.key.length > 0)
  )
}

runTests()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`)
    if (failed > 0) process.exit(1)
  })
  .catch((err) => {
    console.error("Unexpected error:", err)
    process.exit(1)
  })
