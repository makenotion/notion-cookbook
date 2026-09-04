// Tests for pure helpers in src/index.ts.
// These require no Airflow connection — all inputs are local.
// Run: npm test  (or: npx tsx test.ts)
import { truncateTail, slimDag, MAX_CHARS } from "./src/index.js"

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

console.log("truncateTail:")
ok(
  "short content is returned unchanged",
  (() => {
    const r = truncateTail("hello", 100)
    return r.content === "hello" && !r.truncated && r.total_chars === 5
  })()
)
ok(
  "content at exactly max is not truncated",
  (() => {
    const s = "x".repeat(100)
    const r = truncateTail(s, 100)
    return r.content === s && !r.truncated && r.total_chars === 100
  })()
)
ok(
  "content longer than max returns last max chars",
  (() => {
    const s = "a".repeat(10) + "b".repeat(5)
    const r = truncateTail(s, 5)
    return r.content === "bbbbb" && r.truncated && r.total_chars === 15
  })()
)
ok(
  "truncated flag is true when content exceeds max",
  truncateTail("x".repeat(MAX_CHARS + 1), MAX_CHARS).truncated
)
ok(
  "truncated content length equals max",
  truncateTail("x".repeat(MAX_CHARS + 100), MAX_CHARS).content.length ===
    MAX_CHARS
)
ok(
  "total_chars reflects original length",
  truncateTail("x".repeat(MAX_CHARS + 7), MAX_CHARS).total_chars ===
    MAX_CHARS + 7
)
ok(
  "empty string is not truncated",
  (() => {
    const r = truncateTail("", 10)
    return r.content === "" && !r.truncated && r.total_chars === 0
  })()
)

console.log("slimDag:")
const fakeDag = {
  dag_id: "my_dag",
  is_active: true,
  is_paused: false,
  owners: ["alice"],
  tags: [{ name: "etl" }, { name: "daily" }],
  description: "A".repeat(200),
  has_import_errors: false,
}
ok(
  "tag objects are flattened to names",
  (() => {
    const s = slimDag(fakeDag)
    return (
      Array.isArray(s.tags) &&
      s.tags.length === 2 &&
      s.tags[0] === "etl" &&
      s.tags[1] === "daily"
    )
  })()
)
ok(
  "description is truncated to 80 chars",
  slimDag(fakeDag).description?.length === 80
)
ok(
  "null description stays null",
  slimDag({ ...fakeDag, description: null }).description === null
)
ok("dag_id is preserved", slimDag(fakeDag).dag_id === "my_dag")

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
