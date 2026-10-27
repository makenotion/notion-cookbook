import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { fixture, run, waitFor } from "./support/harness.ts"

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
  assert.equal(result.timedOut, false, "worker waited for a dead app-server")
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

test("disabled memory with retained files must not auto-sync", async (t) => {
  const f = fixture(t)
  f.seed()
  const result = await f.exec(["hook", "session-start"], {
    FIXTURE_MEMORIES_ENABLED: "false",
  })
  assert.equal(result.code, 0, result.stderr)
  await waitFor(
    () =>
      fs.existsSync(f.logFile) &&
      /disabled|"created":2/.test(fs.readFileSync(f.logFile, "utf8"))
  )
  assert.deepEqual(
    f.pages(),
    [],
    "automatic hook uploaded retained memories while disabled"
  )
})

test(
  "detached hook watches synthetic consolidation and waits for a running job",
  { timeout: 25_000 },
  async (t) => {
    const f = fixture(t)
    f.seed()
    const db = new DatabaseSync(path.join(f.home, "memories_v2_1.sqlite"))
    t.after(() => db.close())
    db.exec(
      "CREATE TABLE jobs (status TEXT); INSERT INTO jobs VALUES ('running')"
    )
    const hook = await f.exec(["hook", "stop"], {}, 3_000)
    assert.equal(hook.code, 0, hook.stderr)
    await waitFor(
      () =>
        fs.existsSync(f.logFile) &&
        /"created":2/.test(fs.readFileSync(f.logFile, "utf8"))
    )
    const summary = path.join(f.home, "memories_v2/memory_summary.md")
    fs.writeFileSync(
      summary,
      fs.readFileSync(summary, "utf8").replace("TypeScript", "Rust")
    )
    await new Promise((resolve) => setTimeout(resolve, 5_500))
    assert.ok(
      !f.calls().includes("update-page"),
      "running consolidation must not import partial files"
    )
    db.exec("UPDATE jobs SET status = 'done'")
    await waitFor(
      () =>
        /Rust developer/.test(
          String(
            f.pages().find((p) => p.title === "memory_summary.md")?.content
          )
        ),
      10_000
    )
    assert.equal(f.pages().length, 2)
    assert.match(
      String(f.pages().find((p) => p.title === "memory_summary.md")?.content),
      /Rust developer/
    )
  }
)

test("worker recursion guard prevents another detached worker", async (t) => {
  const f = fixture(t)
  f.seed()
  assert.equal(
    (await f.exec(["hook", "session-start"], { NOTION_MEMORY_WORKER: "1" }))
      .code,
    0
  )
  assert.deepEqual(f.calls(), [])
  assert.equal(fs.existsSync(f.logFile), false)
})

test("missing Node is visible at the actual hook command boundary", async (t) => {
  const f = fixture(t)
  const result = await run(
    "/bin/sh",
    [
      "-c",
      'node "$PLUGIN_ROOT/mcp-clients/sync-memory/scripts/main.ts" hook session-start',
    ],
    {
      ...f.env,
      PATH: path.join(f.root, "empty-bin"),
      PLUGIN_ROOT: f.installed,
    },
    f.root
  )
  assert.equal(result.code, 127)
  assert.match(result.stderr, /node.*not found/)
})

test("an explicit destination never falls back and workspace mismatch writes nothing", async (t) => {
  for (const config of [
    { mcpServer: "missing-local" },
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
  }
})

test(
  "worker notices mtime-only changes without replacing the source text",
  { timeout: 15_000 },
  async (t) => {
    const f = fixture(t)
    f.seed()
    const started = await f.exec(["hook", "stop"], {}, 3_000)
    assert.equal(started.code, 0, started.stderr)
    await waitFor(() => f.pages().length === 2)
    const page = f.pages().find((item) => item.title === "memory_summary.md")
    assert.ok(page)
    const file = path.join(f.home, "memories_v2/memory_summary.md")
    const original = fs.readFileSync(file, "utf8")
    const stat = fs.statSync(file)
    fs.utimesSync(file, stat.atime, new Date(stat.mtimeMs + 10_000))
    const updatedAt = fs.statSync(file).mtime.toISOString()
    await waitFor(
      () =>
        String(f.pages().find((item) => item.id === page.id)?.content).includes(
          updatedAt
        ),
      10_000
    )
    const updated = f.pages().find((item) => item.id === page.id)
    assert.ok(updated)
    assert.ok(String(updated.content).endsWith(`\n---\n\n${original}`))
    assert.equal(f.pages().length, 2)
    assert.ok(!f.calls().includes("update-data-source"))
  }
)
