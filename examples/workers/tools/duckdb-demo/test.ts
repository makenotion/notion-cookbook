// End-to-end tests for the DuckDB demo worker.
// Because the database is in-memory with no external dependencies, these tests
// run fully offline and cover both the SQL guard and real seeded-data queries.
// Run: npm test  (or: npx tsx test.ts)
import {
  assertSelectOnly,
  buildBoundedQuery,
  buildDescribeTable,
  buildListTables,
} from "./src/sql.js"
import { normalizeValue, runCommand, runQuery } from "./src/duckdb.js"

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

function accepts(sql: string): boolean {
  try {
    assertSelectOnly(sql)
    return true
  } catch {
    return false
  }
}

function rejects(build: () => unknown): boolean {
  try {
    build()
    return false
  } catch {
    return true
  }
}

// ---------------------------------------------------------------------------
// assertSelectOnly
// ---------------------------------------------------------------------------

// Note: assertSelectOnly is a lightweight keyword check (no SQL parser) and is
// NOT the security boundary — it can't catch keywords smuggled in comments or
// strings, nor DuckDB's in-SELECT file/network table functions. The real
// boundary is `enable_external_access: "false"` set when the engine is created
// in duckdb.ts. For parser-based guards see the postgres-query/snowflake-query examples.

console.log("assertSelectOnly accepts read-only selects:")
ok("plain select", accepts("SELECT 1"))
ok(
  "select from table",
  accepts("SELECT id, name FROM customers WHERE country = 'US'")
)
ok("with/cte", accepts("WITH t AS (SELECT 1 AS x) SELECT * FROM t"))
ok("trailing semicolon", accepts("SELECT 1;"))
ok("lowercase keyword", accepts("select current_date"))
ok("trailing line comment", accepts("SELECT id FROM customers -- get all\n"))

console.log("assertSelectOnly rejects everything else:")
ok("delete", !accepts("DELETE FROM customers"))
ok("update", !accepts("UPDATE customers SET country = 'US'"))
ok(
  "insert",
  !accepts(
    "INSERT INTO customers VALUES (9, 'X', 'x@x.com', 'US', '2024-01-01')"
  )
)
ok("drop", !accepts("DROP TABLE customers"))
ok("create", !accepts("CREATE TABLE t (x int)"))
ok(
  "select ... into (write)",
  !accepts("SELECT * INTO new_table FROM customers")
)
ok("multi-statement", !accepts("SELECT 1; SELECT 2"))
ok("select then delete", !accepts("SELECT 1; DELETE FROM customers"))
ok("empty", !accepts(""))
ok("garbage", !accepts("not sql at all"))

// ---------------------------------------------------------------------------
// buildBoundedQuery
// ---------------------------------------------------------------------------

console.log("buildBoundedQuery:")
ok(
  "wraps and fetches one extra row",
  buildBoundedQuery("SELECT 1", 10) ===
    "SELECT * FROM (\nSELECT 1\n) AS query_result LIMIT 11"
)
ok(
  "strips a trailing semicolon",
  buildBoundedQuery("SELECT 1;", 5) ===
    "SELECT * FROM (\nSELECT 1\n) AS query_result LIMIT 6"
)
ok(
  "trailing line comment can't swallow the LIMIT",
  buildBoundedQuery("SELECT id FROM customers -- c", 10) ===
    "SELECT * FROM (\nSELECT id FROM customers -- c\n) AS query_result LIMIT 11"
)

// ---------------------------------------------------------------------------
// buildListTables / buildDescribeTable
// ---------------------------------------------------------------------------

console.log("buildListTables:")
ok(
  "queries information_schema.tables in main schema",
  buildListTables().includes("information_schema.tables") &&
    buildListTables().includes("'main'")
)

console.log("buildDescribeTable:")
ok(
  "includes table name as string literal",
  buildDescribeTable("orders").includes("'orders'")
)
ok(
  "queries information_schema.columns",
  buildDescribeTable("orders").includes("information_schema.columns")
)
ok(
  "rejects invalid table name",
  rejects(() => buildDescribeTable("bad; DROP"))
)
ok("accepts underscores", !rejects(() => buildDescribeTable("order_items")))

// ---------------------------------------------------------------------------
// normalizeValue
// ---------------------------------------------------------------------------

console.log("normalizeValue:")
ok("null passthrough", normalizeValue(null) === null)
ok("boolean passthrough", normalizeValue(true) === true)
ok("string passthrough", normalizeValue("hello") === "hello")
ok("finite number passthrough", normalizeValue(3.14) === 3.14)
ok("non-finite number → string", normalizeValue(Infinity) === "Infinity")
ok("safe bigint → number", normalizeValue(BigInt(42)) === 42)
ok(
  "unsafe bigint → string",
  normalizeValue(BigInt("9007199254740994")) === "9007199254740994"
)
ok("array recursion", JSON.stringify(normalizeValue([1, null])) === "[1,null]")

// ---------------------------------------------------------------------------
// Live seeded-data queries (fully offline — no network, no disk DB)
// ---------------------------------------------------------------------------

async function runLiveTests() {
  console.log("runCommand(buildListTables()) — seeded tables:")
  const tableResult = await runCommand(buildListTables())
  ok("returns 4 tables", tableResult.rows.length === 4)
  const tableNames = tableResult.rows.map((r) => r.table_name).sort()
  ok(
    "table names are customers/order_items/orders/products",
    JSON.stringify(tableNames) ===
      '["customers","order_items","orders","products"]'
  )

  console.log("runCommand(buildDescribeTable('customers')) — column names:")
  const descResult = await runCommand(buildDescribeTable("customers"))
  const colNames = descResult.rows.map((r) => r.column_name)
  ok("customers has 5 columns", colNames.length === 5)
  ok(
    "customers columns are id/name/email/country/signup_date",
    JSON.stringify(colNames) === '["id","name","email","country","signup_date"]'
  )

  console.log("runQuery — COUNT(*) FROM customers:")
  const countResult = await runQuery(
    "SELECT COUNT(*) AS n FROM customers",
    null
  )
  ok("returns 1 row", countResult.rows.length === 1)
  ok("count is 8", countResult.rows[0].n === 8)

  console.log("runQuery — top customer by spend:")
  const spendResult = await runQuery(
    `SELECT c.name, SUM(o.total) AS total_spend
     FROM customers c
     JOIN orders o ON o.customer_id = c.id
     WHERE o.status = 'completed'
     GROUP BY c.id, c.name
     ORDER BY total_spend DESC
     LIMIT 1`,
    null
  )
  ok("returns 1 row", spendResult.rows.length === 1)
  ok(
    "top spender is Delta Dynamics",
    spendResult.rows[0].name === "Delta Dynamics"
  )

  console.log("runQuery — order count by status:")
  const statusResult = await runQuery(
    "SELECT status, COUNT(*) AS n FROM orders GROUP BY status ORDER BY status",
    null
  )
  ok("returns multiple statuses", statusResult.rows.length >= 3)
  const statuses = statusResult.rows.map((r) => r.status)
  ok(
    "includes completed/pending/refunded",
    statuses.includes("completed") &&
      statuses.includes("pending") &&
      statuses.includes("refunded")
  )

  console.log("runQuery — truncation flag:")
  const truncResult = await runQuery(
    "SELECT * FROM order_items",
    3 // fewer than 30 seeded rows
  )
  ok("truncated is true", truncResult.truncated === true)
  ok("only 3 rows returned", truncResult.rowCount === 3)

  console.log("runQuery — date column normalizes to ISO date string:")
  const dateResult = await runQuery(
    "SELECT signup_date FROM customers WHERE id = 1",
    null
  )
  ok(
    "signup_date is an ISO date string",
    dateResult.rows[0].signup_date === "2023-01-15"
  )

  console.log("runQuery — decimal column normalizes to number:")
  const priceResult = await runQuery(
    "SELECT price FROM products WHERE id = 1",
    null
  )
  ok("price is a JS number", typeof priceResult.rows[0].price === "number")
  ok("price value is 49", priceResult.rows[0].price === 49)
}

runLiveTests()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`)
    if (failed > 0) process.exit(1)
  })
  .catch((err) => {
    console.error("Unexpected error:", err)
    process.exit(1)
  })
