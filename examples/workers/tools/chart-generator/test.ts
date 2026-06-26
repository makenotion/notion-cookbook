// Tests the render path (no Notion connection needed). Run: npm test
import { clampScaleFactor, renderVegaLiteToPng } from "./src/chart.js"
import type { TopLevelSpec } from "vega-lite"

const SPEC: TopLevelSpec = {
  $schema: "https://vega.github.io/schema/vega-lite/v6.json",
  data: {
    values: [
      { category: "A", value: 28 },
      { category: "B", value: 55 },
      { category: "C", value: 43 },
    ],
  },
  mark: "bar",
  encoding: {
    x: { field: "category", type: "nominal" },
    y: { field: "value", type: "quantitative" },
  },
}

let failed = 0
function ok(name: string, cond: boolean) {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`)
  if (!cond) failed++
}

async function main() {
  const png = await renderVegaLiteToPng(SPEC, clampScaleFactor(2))
  // PNG magic bytes: 89 50 4E 47
  const isPng =
    png.length > 8 &&
    png[0] === 0x89 &&
    png[1] === 0x50 &&
    png[2] === 0x4e &&
    png[3] === 0x47
  ok(`renders a PNG (${png.length} bytes)`, isPng)

  ok("clamp: null -> 2", clampScaleFactor(null) === 2)
  ok("clamp: 0 -> 1 (min)", clampScaleFactor(0) === 1)
  ok("clamp: 99 -> 5 (max)", clampScaleFactor(99) === 5)
  ok("clamp: 3 -> 3", clampScaleFactor(3) === 3)

  console.log(`\n${failed === 0 ? "all tests passed" : failed + " failed"}`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
