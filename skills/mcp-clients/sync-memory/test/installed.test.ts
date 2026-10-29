import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fixture, run } from "./support/harness.ts"

test("disconnected and unauthorized servers fail without writing pages", async (t) => {
  for (const failure of ["no-server", "unauthorized"]) {
    const f = fixture(t)
    f.seed()
    const result = await f.exec(["sync"], { FIXTURE_FAILURE: failure })
    assert.equal(result.code, 1)
    assert.equal(result.timedOut, false)
    assert.match(
      result.stderr,
      failure === "no-server" ? /Connect Notion/ : /unauthorized/
    )
    assert.deepEqual(f.pages(), [])
  }
})

test("missing Codex reports a bounded error rather than an unhandled process event", async (t) => {
  const f = fixture(t)
  f.seed()
  const result = await f.exec(
    ["sync"],
    { CODEX_PATH: path.join(f.root, "missing-codex") },
    4_000
  )
  assert.equal(result.timedOut, false)
  assert.equal(result.code, 1)
  assert.doesNotMatch(result.stderr, /Unhandled 'error' event/)
  assert.match(result.stderr, /ENOENT|not found/)
})

test("app-server exit rejects outstanding requests promptly", async (t) => {
  const f = fixture(t)
  f.seed()
  const result = await f.exec(["sync"], { FIXTURE_FAILURE: "exit" }, 4_000)
  assert.equal(result.timedOut, false, "command waited for a dead app-server")
  assert.equal(result.code, 1)
  assert.match(result.stderr, /exited|closed/)
})

test(
  "unresponsive app-server requests time out without writing",
  {
    skip:
      process.env.NOTION_TEST_SLOW !== "1" &&
      "set NOTION_TEST_SLOW=1 for the real 60-second timeout",
    timeout: 70_000,
  },
  async (t) => {
    const f = fixture(t)
    f.seed()
    const result = await f.exec(["sync"], { FIXTURE_FAILURE: "hang" }, 65_000)
    assert.equal(
      result.timedOut,
      false,
      "request timeout did not bound the process"
    )
    assert.equal(result.code, 1)
    assert.match(result.stderr, /initialize timed out/)
    assert.deepEqual(f.pages(), [])
  }
)

test("missing Node is visible at the manual command boundary", async (t) => {
  const f = fixture(t)
  const result = await run(
    "/bin/sh",
    ["-c", 'node "$SKILL_ROOT/scripts/main.ts" sync'],
    {
      ...f.env,
      PATH: path.join(f.root, "empty-bin"),
      SKILL_ROOT: f.installed,
    },
    f.root
  )
  assert.equal(result.code, 127)
  assert.match(result.stderr, /node.*not found/)
})

test("an explicit destination never falls back and workspace mismatch writes nothing", async (t) => {
  for (const config of [
    { mcpServer: "missing-local", expectedWorkspaceId: "synthetic-workspace" },
    { mcpServer: "notion", expectedWorkspaceId: "expected-local" },
  ]) {
    const f = fixture(t)
    f.seed()
    fs.writeFileSync(
      path.join(f.home, "notion-memory.json"),
      JSON.stringify(config)
    )
    const result = await f.exec(["sync"])
    assert.equal(result.code, 1)
    assert.deepEqual(f.pages(), [])
    assert.equal(fs.existsSync(f.stateFile()), false)
  }
})

test("sync requires a pinned workspace before starting a connection", async (t) => {
  const f = fixture(t)
  f.seed()
  for (const config of [{}, { expectedWorkspaceId: "   " }]) {
    fs.writeFileSync(
      path.join(f.home, "notion-memory.json"),
      JSON.stringify(config)
    )
    const result = await f.exec(["sync"])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /Set expectedWorkspaceId/)
  }
  assert.deepEqual(f.calls(), [])
  assert.deepEqual(f.pages(), [])
})

test("multiple Notion connections require explicit selection even with a workspace pin", async (t) => {
  const f = fixture(t)
  f.seed()
  const ambiguous = await f.exec(["sync"], { FIXTURE_MULTIPLE_SERVERS: "1" })
  assert.equal(ambiguous.code, 1)
  assert.match(ambiguous.stderr, /Multiple Notion connections/)
  assert.deepEqual(f.pages(), [])
  assert.ok(!f.calls().includes("get-self"))
  fs.writeFileSync(
    path.join(f.home, "notion-memory.json"),
    JSON.stringify({
      mcpServer: "notion",
      expectedWorkspaceId: "synthetic-workspace",
    })
  )
  const selected = await f.exec(["sync"], { FIXTURE_MULTIPLE_SERVERS: "1" })
  assert.equal(selected.code, 0, selected.stderr)
  assert.equal(f.pages().length, 2)
  assert.ok(f.calls().indexOf("get-self") < f.calls().indexOf("create-pages"))
})

test("server requests cannot consume client responses with the same ID", async (t) => {
  const f = fixture(t)
  f.seed()
  const result = await f.exec(["sync"], { FIXTURE_SERVER_REQUESTS: "1" })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(f.pages().length, 2)
  assert.ok(f.calls().includes("server-response:server-request:-32601"))
  assert.ok(f.calls().includes("server-response:1:-32601"))
})
