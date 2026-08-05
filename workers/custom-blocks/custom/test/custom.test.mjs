import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const workerUrl = new URL("../src/index.ts", import.meta.url)

test("registers the custom block without data sources", async () => {
  const workerSource = await readFile(workerUrl, "utf8")

  assert.match(workerSource, /worker\.customBlock\("custom"/)
  assert.match(workerSource, /path:\s*"\.\/blocks\/custom"/)
  assert.match(workerSource, /dataSources:\s*\{\}/)
})
