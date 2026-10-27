import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { claudeFixture } from "./support/claude-harness.ts"
import { object, recipe, run, waitFor } from "./support/harness.ts"

// Every fixture file except the MEMORY.md index.
const FIXTURE_COUNT = 5

test("Claude Code artifact resolves its manifest and hooks and loads no MCP server", async (t) => {
  const f = await claudeFixture(t)
  const manifest = object(
    JSON.parse(
      fs.readFileSync(
        path.join(f.installed, ".claude-plugin/plugin.json"),
        "utf8"
      )
    )
  )
  assert.ok(fs.existsSync(path.resolve(f.installed, String(manifest.hooks))))
  // Claude Code loads only a .mcp.json at the plugin root; Codex's is in the skill.
  assert.equal(fs.existsSync(path.join(f.installed, ".mcp.json")), false)
  const hooks = object(
    object(
      JSON.parse(
        fs.readFileSync(
          path.join(f.installed, "skills/sync-memory/claude-hooks.json"),
          "utf8"
        )
      )
    ).hooks
  )
  assert.deepEqual(Object.keys(hooks), ["SessionStart", "PostToolUse", "Stop"])
  for (const entries of Object.values(hooks)) {
    const text = JSON.stringify(entries)
    assert.match(text, /NOTION_MEMORY_AGENT=claude/)
    assert.match(
      text,
      /\\"\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/sync-memory\/hook\.cjs\\"/
    )
  }
  f.seed()
  const result = await f.exec(["preview"])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).files.length, FIXTURE_COUNT)
  assert.deepEqual(f.calls(), [])
})

test("Claude Code sync persists across processes, skips unchanged, and updates one topic", async (t) => {
  const f = await claudeFixture(t)
  f.signIn()
  f.seed()
  let result = await f.exec(["sync"])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).created, FIXTURE_COUNT)
  for (const page of f.pages()) {
    assert.equal(page.source, "Claude Code")
    assert.equal(page.lastUpdatedBy, "Claude Code")
  }
  const before = f.calls().length
  result = await f.exec(["sync"])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).unchanged, FIXTURE_COUNT)
  assert.equal(f.calls().length, before, "unchanged process must not connect")
  const role = path.join(f.memoryDir, "user_role.md")
  fs.writeFileSync(
    role,
    fs.readFileSync(role, "utf8").replace("ten years", "twelve years")
  )
  result = await f.exec(["sync"])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).updated, 1)
  assert.equal(f.pages().length, FIXTURE_COUNT)
  assert.match(
    String(
      f.pages().find((p) => String(p.title).endsWith("/user_role.md"))?.content
    ),
    /The user has twelve years/
  )
})

test("overlapping Claude Code syncs create each topic only once", async (t) => {
  const f = await claudeFixture(t)
  f.signIn()
  f.seed()
  const results = await Promise.all([f.exec(["sync"]), f.exec(["sync"])])
  results.forEach((r) => assert.equal(r.code, 0, r.stderr))
  assert.equal(f.pages().length, FIXTURE_COUNT)
  assert.equal(
    f.calls().filter((c) => c === "create-pages").length,
    FIXTURE_COUNT
  )
})

test("Notion edits and deletions survive later Claude Code syncs", async (t) => {
  const f = await claudeFixture(t)
  f.signIn()
  f.seed()
  assert.equal((await f.exec(["sync"])).code, 0)
  const pages = f.pages()
  const profile = pages.find((p) => String(p.title).endsWith("/user_role.md"))
  const work = pages.find((p) => p.type === "Work")
  assert.ok(profile && work)
  profile.content = "Synthetic user edit"
  work.deleted = true
  f.savePages(pages)
  for (const file of ["user_role.md", "project_launch.md"]) {
    const memory = path.join(f.memoryDir, file)
    fs.appendFileSync(memory, "\nAnother synthetic fact.\n")
  }
  const result = await f.exec(["sync"])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).changedInNotion, 2)
  assert.equal(
    f.pages().find((p) => p.id === profile.id)?.content,
    "Synthetic user edit"
  )
  assert.equal(f.pages().find((p) => p.id === work.id)?.deleted, true)
})

test("hooks run from claude-hooks.json import on memory writes and ignore other writes", async (t) => {
  const f = await claudeFixture(t)
  f.signIn()
  f.seed()
  const other = await f.hook("PostToolUse", {
    tool_name: "Write",
    tool_input: { file_path: path.join(f.project, "notes.md") },
  })
  assert.equal(other.code, 0, other.stderr)
  assert.doesNotMatch(f.log(), /worker pid/)

  const memory = await f.hook("PostToolUse", {
    tool_name: "Write",
    tool_input: { file_path: path.join(f.memoryDir, "user_role.md") },
  })
  assert.equal(memory.code, 0, memory.stderr)
  await waitFor(() => /"created":5/.test(f.log()), 10_000)

  // A memory changed outside Write/Edit is picked up by the Stop hook.
  fs.appendFileSync(
    path.join(f.memoryDir, "reference_dashboards.md"),
    "More.\n"
  )
  assert.equal((await f.hook("Stop")).code, 0)
  await waitFor(() => /"updated":1/.test(f.log()), 10_000)
  // A deleted memory file leaves its page alone; the plugin never deletes.
  fs.rmSync(path.join(f.memoryDir, "reference_dashboards.md"))
  const result = await f.exec(["sync"])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(f.pages().length, FIXTURE_COUNT)
  assert.ok(!f.pages().some((p) => p.deleted))
})

test("disabled Claude Code auto memory with retained files does not auto-sync", async (t) => {
  const cases: Array<{
    name: string
    extra?: NodeJS.ProcessEnv
    settings?: (f: { home: string; project: string }) => void
  }> = [
    { name: "env", extra: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } },
    {
      name: "user settings",
      settings: (f) =>
        fs.writeFileSync(
          path.join(f.home, "settings.json"),
          JSON.stringify({ autoMemoryEnabled: false })
        ),
    },
    {
      name: "project local settings",
      settings: (f) => {
        fs.mkdirSync(path.join(f.project, ".claude"))
        fs.writeFileSync(
          path.join(f.project, ".claude/settings.local.json"),
          JSON.stringify({ autoMemoryEnabled: false })
        )
      },
    },
  ]
  for (const c of cases) {
    const f = await claudeFixture(t)
    f.signIn()
    f.seed()
    c.settings?.(f)
    const result = await f.hook("SessionStart", {}, c.extra)
    assert.equal(result.code, 0, result.stderr)
    assert.match(f.log(), /auto memory is disabled/, c.name)
    assert.doesNotMatch(f.log(), /worker pid/, c.name)
    assert.deepEqual(f.pages(), [], c.name)
  }
})

test("missing memories or sign-in start no worker and connect to nothing", async (t) => {
  const empty = await claudeFixture(t)
  empty.signIn()
  assert.equal((await empty.exec(["sync"])).code, 0)
  assert.equal((await empty.hook("SessionStart")).code, 0)
  assert.deepEqual(empty.calls(), [])
  assert.equal(empty.log().includes("worker pid"), false)

  const signedOut = await claudeFixture(t)
  signedOut.seed()
  assert.equal((await signedOut.hook("SessionStart")).code, 0)
  assert.match(signedOut.log(), /not signed in/)
  assert.doesNotMatch(signedOut.log(), /worker pid/)
  const result = await signedOut.exec(["sync"])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /not signed in/)
  assert.deepEqual(signedOut.calls(), [])
})

test("expired sign-in, tool errors, and an unreachable server fail without writing", async (t) => {
  const expired = await claudeFixture(t, "expired")
  expired.signIn()
  expired.seed()
  let result = await expired.exec(["sync"], {}, 5_000)
  assert.equal(result.timedOut, false)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /token request failed: 400/)
  assert.ok(expired.calls().includes("oauth:refresh"))
  assert.deepEqual(expired.pages(), [])

  const unauthorized = await claudeFixture(t, "unauthorized")
  unauthorized.signIn()
  unauthorized.seed()
  result = await unauthorized.exec(["sync"], {}, 5_000)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /unauthorized/)
  assert.deepEqual(unauthorized.pages(), [])

  const down = await claudeFixture(t)
  down.signIn()
  down.seed()
  down.server.kill()
  await new Promise((resolve) => down.server.once("exit", resolve))
  result = await down.exec(["sync"], {}, 5_000)
  assert.equal(result.timedOut, false)
  assert.equal(result.code, 1)
  assert.doesNotMatch(result.stderr, /Unhandled/)
  assert.match(result.stderr, /fetch failed|ECONNREFUSED/)
})

test(
  "an unresponsive Notion MCP server times out without writing",
  {
    skip:
      process.env.NOTION_TEST_SLOW !== "1" &&
      "set NOTION_TEST_SLOW=1 for the real 60-second timeout",
    timeout: 70_000,
  },
  async (t) => {
    const f = await claudeFixture(t, "hang")
    f.signIn()
    f.seed()
    const result = await f.exec(["sync"], {}, 65_000)
    assert.equal(result.timedOut, false, "request timeout did not bound sync")
    assert.equal(result.code, 1)
    assert.match(result.stderr, /timeout|aborted/i)
    assert.deepEqual(f.pages(), [])
  }
)

test("a custom autoMemoryDirectory is read and recognized by the hook", async (t) => {
  const f = await claudeFixture(t)
  const custom = path.join(f.root, "custom memory")
  fs.writeFileSync(
    path.join(f.home, "settings.json"),
    JSON.stringify({ autoMemoryDirectory: custom })
  )
  f.signIn()
  f.seed(custom)
  const preview = await f.exec(["preview"])
  assert.equal(preview.code, 0, preview.stderr)
  assert.equal(JSON.parse(preview.stdout).files.length, FIXTURE_COUNT)
  const hook = await f.hook("PostToolUse", {
    tool_name: "Edit",
    tool_input: { file_path: path.join(custom, "user_role.md") },
  })
  assert.equal(hook.code, 0, hook.stderr)
  await waitFor(() => /"created":5/.test(f.log()), 10_000)
})

test("missing Node is visible at the Claude Code hook command boundary", async (t) => {
  const f = await claudeFixture(t)
  const result = await run(
    "/bin/sh",
    [
      "-c",
      'NOTION_MEMORY_AGENT=claude node "${CLAUDE_PLUGIN_ROOT}/skills/sync-memory/hook.cjs" session-start',
    ],
    {
      ...f.env,
      PATH: path.join(f.root, "empty-bin"),
      CLAUDE_PLUGIN_ROOT: f.installed,
    },
    f.root
  )
  assert.equal(result.code, 127)
  assert.match(result.stderr, /node.*not found/)
})
