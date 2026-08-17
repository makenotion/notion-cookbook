// Tests for the read-only SQL guard and SHOW/DESCRIBE builders in src/sql.ts.
// These are the security-relevant bits and need no Snowflake connection.
// Run: npm test  (or: npx tsx test.ts)
import {
  assertSelectOnly,
  buildBoundedQuery,
  buildDescribeTable,
  buildShowTables,
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
ok("lowercase keyword", accepts("select current_date()"))
ok("trailing line comment", accepts("SELECT id FROM t -- get all\n"))

console.log("assertSelectOnly rejects everything else:")
ok("delete", !accepts("DELETE FROM t"))
ok("update", !accepts("UPDATE t SET x = 1"))
ok("insert", !accepts("INSERT INTO t VALUES (1)"))
ok("drop", !accepts("DROP TABLE t"))
ok("create", !accepts("CREATE TABLE t (x int)"))
ok(
  "merge",
  !accepts("MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE")
)
ok("select ... into (write)", !accepts("SELECT * INTO new_table FROM t"))
ok("multi-statement", !accepts("SELECT 1; SELECT 2"))
ok("select then delete", !accepts("SELECT 1; DELETE FROM t"))
ok("show (use listTables instead)", !accepts("SHOW TABLES"))
ok("describe (use describeTable instead)", !accepts("DESCRIBE TABLE t"))
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

console.log("buildShowTables / buildDescribeTable:")
ok("bare", buildShowTables({}) === "SHOW TABLES")
ok(
  "db + schema",
  buildShowTables({ database: "MY_DB", schema: "PUBLIC" }) ===
    "SHOW TABLES IN SCHEMA MY_DB.PUBLIC"
)
ok(
  "like before in (snowflake grammar)",
  buildShowTables({ database: "MY_DB", like: "%ORDER%" }) ===
    "SHOW TABLES LIKE '%ORDER%' IN DATABASE MY_DB"
)
ok(
  "like escapes single quotes",
  buildShowTables({ like: "O'B%" }) === "SHOW TABLES LIKE 'O''B%'"
)
ok(
  "rejects identifier injection",
  rejects(() => buildShowTables({ database: "x; DROP TABLE y" }))
)
ok(
  "describe fully qualified",
  buildDescribeTable("MY_DB.PUBLIC.ORDERS") ===
    "DESCRIBE TABLE MY_DB.PUBLIC.ORDERS"
)
ok(
  "describe rejects injection",
  rejects(() => buildDescribeTable("t; DROP TABLE x"))
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
