// Tests for the read-only SQL guard and information_schema builders in src/sql.ts.
// These are the security-relevant bits and need no Postgres connection.
// Run: npm test  (or: npx tsx test.ts)
import {
  assertSelectOnly,
  buildBoundedQuery,
  buildDescribeTable,
  buildListTables,
} from "./src/sql.js"

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
ok("lowercase keyword", accepts("select current_date"))
ok("trailing line comment", accepts("SELECT id FROM t -- get all\n"))

console.log("assertSelectOnly rejects everything else:")
ok("delete", !accepts("DELETE FROM t"))
ok("update", !accepts("UPDATE t SET x = 1"))
ok("insert", !accepts("INSERT INTO t VALUES (1)"))
ok("drop", !accepts("DROP TABLE t"))
ok("create", !accepts("CREATE TABLE t (x int)"))
ok("select ... into (write)", !accepts("SELECT * INTO new_table FROM t"))
ok("multi-statement", !accepts("SELECT 1; SELECT 2"))
ok("select then delete", !accepts("SELECT 1; DELETE FROM t"))
ok("empty", !accepts(""))
ok("garbage", !accepts("not sql at all"))

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

console.log("buildListTables:")
ok(
  "defaults to public schema",
  buildListTables({}).text.includes("WHERE table_schema = $1") &&
    buildListTables({}).values[0] === "public"
)
ok(
  "custom schema",
  buildListTables({ schema: "myschema" }).values[0] === "myschema"
)
ok(
  "like adds ILIKE clause with two values",
  buildListTables({ like: "%order%" }).text.includes("ILIKE $2") &&
    buildListTables({ like: "%order%" }).values.length === 2 &&
    buildListTables({ like: "%order%" }).values[1] === "%order%"
)
ok(
  "no like gives one value",
  buildListTables({ schema: "public" }).values.length === 1
)

console.log("buildDescribeTable:")
ok(
  "defaults to public schema",
  buildDescribeTable({ table: "orders" }).values[0] === "public" &&
    buildDescribeTable({ table: "orders" }).values[1] === "orders"
)
ok(
  "custom schema",
  buildDescribeTable({ table: "orders", schema: "myschema" }).values[0] ===
    "myschema"
)
ok(
  "query text uses $1 and $2",
  buildDescribeTable({ table: "orders" }).text.includes(
    "WHERE table_schema = $1 AND table_name = $2"
  )
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
