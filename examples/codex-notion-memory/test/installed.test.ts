import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { fixture, object, recipe, run, waitFor } from "./support/harness.ts"

test("plugin artifact resolves its manifest, MCP, hooks and skill without dependencies", async (t) => {
  const f = fixture(t)
  const manifest = object(
    JSON.parse(
      fs.readFileSync(
        path.join(f.installed, ".codex-plugin/plugin.json"),
        "utf8"
      )
    )
  )
  for (const field of ["hooks", "mcpServers", "skills"]) {
    const relative = manifest[field]
    assert.equal(typeof relative, "string")
    assert.ok(fs.existsSync(path.resolve(f.installed, String(relative))))
  }
  const hookFile = object(
    JSON.parse(
      fs.readFileSync(path.join(f.installed, String(manifest.hooks)), "utf8")
    )
  )
  const hooks = object(hookFile.hooks)
  assert.deepEqual(Object.keys(hooks), ["SessionStart", "Stop"])
  assert.ok(
    fs.existsSync(path.join(f.installed, "skills/notion-memory/SKILL.md"))
  )
  assert.equal(fs.existsSync(path.join(f.installed, "node_modules")), false)
  const result = await f.exec([
    "preview",
    "--dir",
    path.join(recipe, "test/fixtures/memories"),
  ])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).length, 3)
  assert.deepEqual(f.calls(), [])
})

test("installed entrypoint persists across processes, skips unchanged writes, and updates one topic", async (t) => {
  const f = fixture(t)
  f.seed()
  let result = await f.exec(["sync"])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).created, 3)
  const before = f.calls().length
  result = await f.exec(["sync"])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).unchanged, 3)
  assert.equal(f.calls().length, before, "unchanged process must not connect")
  const summary = path.join(f.home, "memories/memory_summary.md")
  fs.writeFileSync(
    summary,
    fs.readFileSync(summary, "utf8").replace("TypeScript", "Rust")
  )
  result = await f.exec(["sync"])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).updated, 1)
  assert.equal(f.pages().length, 3)
  assert.match(
    String(f.pages().find((p) => p.title === "Role and background")?.content),
    /Rust developer/
  )
  assert.ok(!f.calls().includes("turn/start"))
})

test("overlapping installed sync processes create each topic only once", async (t) => {
  const f = fixture(t)
  f.seed()
  const results = await Promise.all([f.exec(["sync"]), f.exec(["sync"])])
  results.forEach((r) => assert.equal(r.code, 0, r.stderr))
  assert.equal(f.pages().length, 3)
  assert.equal(f.calls().filter((c) => c === "create-pages").length, 3)
})

test("user edits and deletions survive subsequent process restarts", async (t) => {
  const f = fixture(t)
  f.seed()
  assert.equal((await f.exec(["sync"])).code, 0)
  const pages = f.pages()
  const profile = pages.find((p) => p.title === "Role and background")
  const work = pages.find((p) => p.type === "Work")
  assert.ok(profile && work)
  profile.content = "Synthetic user edit"
  work.deleted = true
  f.savePages(pages)
  const summary = path.join(f.home, "memories/memory_summary.md")
  fs.writeFileSync(
    summary,
    fs.readFileSync(summary, "utf8").replace("TypeScript", "Rust")
  )
  fs.appendFileSync(
    path.join(f.home, "memories/MEMORY.md"),
    "\n- Another synthetic fact\n"
  )
  const result = await f.exec(["sync"])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).changedInNotion, 2)
  assert.equal(
    f.pages().find((p) => p.title === profile.title)?.content,
    "Synthetic user edit"
  )
  assert.equal(f.pages().find((p) => p.id === work.id)?.deleted, true)
})

test("missing memories do not connect or start a hook worker", async (t) => {
  const f = fixture(t)
  assert.equal(
    (await f.exec(["sync"], { CODEX_PATH: "/nonexistent/codex" })).code,
    0
  )
  assert.equal((await f.exec(["hook", "session-start"])).code, 0)
  assert.deepEqual(f.calls(), [])
})

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
      /disabled|"created":3/.test(fs.readFileSync(f.logFile, "utf8"))
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
    const db = new DatabaseSync(path.join(f.home, "memories_1.sqlite"))
    t.after(() => db.close())
    db.exec(
      "CREATE TABLE jobs (status TEXT); INSERT INTO jobs VALUES ('running')"
    )
    const hook = await f.exec(["hook", "stop"], {}, 3_000)
    assert.equal(hook.code, 0, hook.stderr)
    await waitFor(
      () =>
        fs.existsSync(f.logFile) &&
        /"created":3/.test(fs.readFileSync(f.logFile, "utf8"))
    )
    const summary = path.join(f.home, "memories/memory_summary.md")
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
    await waitFor(() => f.calls().includes("update-page"), 10_000)
    assert.equal(f.pages().length, 3)
    assert.match(
      String(f.pages().find((p) => p.title === "Role and background")?.content),
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
    ["-c", 'node "$PLUGIN_ROOT/src/main.ts" hook session-start'],
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
