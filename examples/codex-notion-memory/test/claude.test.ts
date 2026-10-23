import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { fakeNotion } from "./fakeNotion.ts"

// The plugin resolves its paths at import time, so point them at a temp dir first.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-notion-memory-"))
process.env.NOTION_MEMORY_AGENT = "claude"
process.env.CLAUDE_CONFIG_DIR = home
const FIXTURES = fileURLToPath(
  new URL("fixtures/claude/memory", import.meta.url)
)
// Claude Code names project directories after the working directory.
const PROJECT = `${os.homedir().replace(/[^a-zA-Z0-9]/g, "-")}-code-app`
const MEMORY_DIR = path.join(home, "projects", PROJECT, "memory")
fs.cpSync(FIXTURES, MEMORY_DIR, { recursive: true })

const { claudeSource, isClaudeMemoryFile, parseClaudeMemories } = await import(
  "../plugin/src/claude.ts"
)
const { syncMemories } = await import("../plugin/src/memories.ts")
const { loadState } = await import("../plugin/src/config.ts")

test("parses Claude Code auto memory files into typed memories", () => {
  const memories = parseClaudeMemories(claudeSource.dir)
  assert.deepEqual(
    memories.map((m) => [m.type, m.title]),
    [
      ["Preference", 'Integration tests must hit a "real" database, not mocks'],
      ["Work", "Merge freeze for the billing launch starts 2026-03-05"],
      [
        "Notes",
        'API latency dashboard lives in Grafana under "API / Overview"',
      ],
      ["Profile", "Backend engineer who is new to the React frontend"],
    ]
  )
  const feedback = memories[0]
  assert.equal(feedback.key, `${PROJECT}/feedback_tests.md`)
  assert.equal(feedback.from, "code-app › feedback_tests.md")
  assert.match(feedback.content, /^Don't mock the database/)
  assert.doesNotMatch(feedback.content, /^---|type: feedback/m)
})

test("recognizes only auto memory files from hook input", () => {
  assert.equal(isClaudeMemoryFile(path.join(MEMORY_DIR, "user_role.md")), true)
  assert.equal(isClaudeMemoryFile(path.join(MEMORY_DIR, "MEMORY.md")), false)
  assert.equal(
    isClaudeMemoryFile(path.join(home, "projects", PROJECT, "notes.md")),
    false
  )
  assert.equal(isClaudeMemoryFile("/tmp/memory/user_role.md"), false)
  assert.equal(isClaudeMemoryFile(""), false)
})

test("syncs with Source = Claude Code and follows renamed content", async () => {
  const { pages, client } = fakeNotion("Claude Code")
  assert.deepEqual(await syncMemories(client, claudeSource), {
    total: 4,
    created: 4,
    updated: 0,
    removed: 0,
    skippedEdited: 0,
  })

  // Claude rewrites one memory and deletes another (for example with `rm`).
  const role = path.join(MEMORY_DIR, "user_role.md")
  fs.writeFileSync(
    role,
    fs.readFileSync(role, "utf8").replace("Ten years", "Twelve years")
  )
  fs.rmSync(path.join(MEMORY_DIR, "reference_dashboards.md"))

  const result = await syncMemories(client, claudeSource)
  assert.equal(result.updated, 1)
  assert.equal(result.removed, 1)
  const live = [...pages.values()].filter((p) => !p.in_trash)
  assert.equal(live.length, 3)
  assert.equal(Object.keys(loadState().memories).length, 3)
})
