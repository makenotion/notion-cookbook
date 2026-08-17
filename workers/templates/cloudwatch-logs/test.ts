// Tests for the pure helpers in src/index.ts.
// These run offline — no AWS connection needed.
// Run: npm test  (or: npx tsx test.ts)
import { clampLimit } from "./src/index.js"

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

console.log("clampLimit:")
ok("null → default", clampLimit(null, 10, 50) === 10)
ok("above max → max", clampLimit(100, 10, 50) === 50)
ok("zero → default", clampLimit(0, 10, 50) === 10)
ok("negative → default", clampLimit(-5, 10, 50) === 10)
ok("valid within range", clampLimit(25, 10, 50) === 25)
ok("exactly max", clampLimit(50, 10, 50) === 50)
ok("fractional → floored", clampLimit(7.9, 10, 50) === 7)
ok("default for events (100)", clampLimit(null, 100, 500) === 100)
ok("above events max → 500", clampLimit(999, 100, 500) === 500)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
