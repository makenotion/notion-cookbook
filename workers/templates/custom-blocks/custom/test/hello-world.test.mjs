import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const workerUrl = new URL("../src/index.ts", import.meta.url)

test("registers the Hello world block without data sources", async () => {
  const workerSource = await readFile(workerUrl, "utf8")

  assert.match(workerSource, /worker\.customBlock\("helloWorld"/)
  assert.match(workerSource, /path:\s*"\.\/blocks\/hello-world"/)
  assert.match(workerSource, /dataSources:\s*\{\}/)
})
