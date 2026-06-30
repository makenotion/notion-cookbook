// End-to-end tests for the SQLite demo worker.
// All tests run fully offline against the in-memory seeded database.
// Run: npm test  (or: npx tsx test.ts)
import {
  assertSelectOnly,
  buildBoundedQuery,
  buildDescribeTable,
  buildListTables,
} from "./src/sql.js"
import { runCommand, runQuery } from "./src/sqlite.js"

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

// ---------------------------------------------------------------------------
// assertSelectOnly guard
// ---------------------------------------------------------------------------

console.log("assertSelectOnly accepts read-only selects:")
ok("plain select", accepts("SELECT 1"))
ok(
  "select from table",
  accepts("SELECT id, name FROM orders WHERE status = 'open'")
)
ok("with/cte", accepts("WITH t AS (SELECT 1 AS x) SELECT * FROM t"))
ok(
  "semicolon inside string literal",
  accepts("SELECT col FROM t WHERE v = 'a;b'")
)
ok("trailing semicolon", accepts("SELECT 1;"))
ok("lowercase keyword", accepts("select 42"))
ok("trailing line comment", accepts("SELECT id FROM t -- get all\n"))

console.log("assertSelectOnly rejects writes and invalid input:")
ok("delete", !accepts("DELETE FROM customers"))
ok("update", !accepts("UPDATE customers SET name = 'x'"))
ok(
  "insert",
  !accepts("INSERT INTO customers VALUES (1,'x','x','US','2024-01-01')")
)
ok("drop", !accepts("DROP TABLE customers"))
ok("create", !accepts("CREATE TABLE t (x int)"))
ok(
  "select ... into (write)",
  !accepts("SELECT * INTO new_table FROM customers")
)
ok("multi-statement", !accepts("SELECT 1; SELECT 2"))
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
  buildBoundedQuery("SELECT id FROM t -- c", 10) ===
    "SELECT * FROM (\nSELECT id FROM t -- c\n) AS query_result LIMIT 11"
)

// ---------------------------------------------------------------------------
// buildListTables / buildDescribeTable
// ---------------------------------------------------------------------------

console.log("buildListTables:")
ok(
  "returns catalog query for sqlite_master",
  buildListTables().includes("sqlite_master")
)
ok("excludes sqlite_ internal tables", buildListTables().includes("sqlite_%"))

console.log("buildDescribeTable:")
ok(
  "valid name passes",
  (() => {
    try {
      buildDescribeTable("orders")
      return true
    } catch {
      return false
    }
  })()
)
ok(
  "result contains PRAGMA table_info",
  buildDescribeTable("orders").startsWith("PRAGMA table_info(orders)")
)
ok(
  "rejects name with spaces",
  (() => {
    try {
      buildDescribeTable("my table")
      return false
    } catch {
      return true
    }
  })()
)
ok(
  "rejects name with semicolon",
  (() => {
    try {
      buildDescribeTable("t; DROP TABLE customers")
      return false
    } catch {
      return true
    }
  })()
)

// ---------------------------------------------------------------------------
// Seeded database — real queries against in-memory data
// ---------------------------------------------------------------------------

async function runDbTests() {
  console.log("seeded database — listTables:")
  const tablesResult = await runCommand(buildListTables())
  const tableNames = tablesResult.rows.map((r) => r["name"] as string).sort()
  ok("returns exactly 4 tables", tableNames.length === 4)
  ok(
    "tables are customers, order_items, orders, products",
    JSON.stringify(tableNames) ===
      JSON.stringify(["customers", "order_items", "orders", "products"])
  )

  console.log("seeded database — describeTable:")
  const descResult = await runCommand(buildDescribeTable("customers"))
  const colNames = descResult.rows.map((r) => r["name"] as string)
  ok("customers has 5 columns", descResult.rows.length === 5)
  ok("first column is id", colNames[0] === "id")
  ok(
    "includes name, email, country, signup_date",
    ["name", "email", "country", "signup_date"].every((c) =>
      colNames.includes(c)
    )
  )

  console.log("seeded database — COUNT(*) queries:")
  const custCount = await runQuery("SELECT COUNT(*) AS n FROM customers", null)
  ok(
    "customers has 8 rows",
    custCount.rows.length === 1 && custCount.rows[0]["n"] === 8
  )
  const prodCount = await runQuery("SELECT COUNT(*) AS n FROM products", null)
  ok(
    "products has 6 rows",
    prodCount.rows.length === 1 && prodCount.rows[0]["n"] === 6
  )
  const orderCount = await runQuery("SELECT COUNT(*) AS n FROM orders", null)
  ok(
    "orders has 15 rows",
    orderCount.rows.length === 1 && orderCount.rows[0]["n"] === 15
  )
  const itemCount = await runQuery(
    "SELECT COUNT(*) AS n FROM order_items",
    null
  )
  ok(
    "order_items has 28 rows",
    itemCount.rows.length === 1 && itemCount.rows[0]["n"] === 28
  )

  console.log("seeded database — top customer by spend:")
  const topCustomer = await runQuery(
    `WITH spend AS (
       SELECT customer_id, SUM(total) AS total_spend
       FROM orders
       WHERE status = 'completed'
       GROUP BY customer_id
     )
     SELECT c.name, s.total_spend
     FROM spend s
     JOIN customers c ON c.id = s.customer_id
     ORDER BY s.total_spend DESC
     LIMIT 1`,
    null
  )
  ok("returns one row", topCustomer.rows.length === 1)
  // Delta Dynamics: order 5 (299) + order 13 (1155) = 1454
  ok(
    "top customer is Delta Dynamics",
    topCustomer.rows[0]["name"] === "Delta Dynamics"
  )
  ok(
    "Delta Dynamics total spend is 1454",
    topCustomer.rows[0]["total_spend"] === 1454
  )

  console.log("seeded database — revenue by category:")
  const revByCat = await runQuery(
    `SELECT p.category, SUM(oi.quantity * oi.unit_price) AS revenue
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     GROUP BY p.category
     ORDER BY revenue DESC`,
    null
  )
  ok("returns 3 categories", revByCat.rows.length === 3)
  ok(
    "first category is Subscription",
    revByCat.rows[0]["category"] === "Subscription"
  )

  console.log("seeded database — orders by status:")
  const byStatus = await runQuery(
    "SELECT status, COUNT(*) AS cnt FROM orders GROUP BY status ORDER BY status",
    null
  )
  const statuses = byStatus.rows.map((r) => r["status"] as string)
  ok("includes completed status", statuses.includes("completed"))
  ok("includes pending status", statuses.includes("pending"))
  ok("includes refunded status", statuses.includes("refunded"))

  console.log("seeded database — row cap and truncation:")
  const capped = await runQuery("SELECT * FROM order_items", 5)
  ok("caps to 5 rows", capped.rows.length === 5)
  ok("reports truncated=true", capped.truncated === true)

  const exact = await runQuery("SELECT * FROM customers", 100)
  ok("8 customers, no truncation", exact.rows.length === 8 && !exact.truncated)
}

runDbTests().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
})
