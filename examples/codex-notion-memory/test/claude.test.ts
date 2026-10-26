import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { fakeNotionMcp } from "./fakeNotionMcp.ts"

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

test("parses Claude Code auto memory files, one memory per file", () => {
  const memories = parseClaudeMemories(claudeSource.dir(), "Casey")
  assert.deepEqual(
    memories.map((m) => [m.type, m.title]),
    [
      ["Preference", "Integration tests real db"],
      ["Work", "Billing launch freeze"],
      ["Notes", "Latency dashboard"],
      ["Profile", "Role and background"],
    ]
  )
  const [feedback, , , profile] = memories
  assert.equal(feedback.key, `claude:${PROJECT}/feedback_tests.md`)
  assert.equal(feedback.from, "code-app › `feedback_tests.md`")
  // The description leads the body, with escaped quotes unescaped.
  assert.match(
    feedback.content,
    /^Integration tests must hit a "real" database, not mocks\n\nDon't mock/
  )
  assert.doesNotMatch(feedback.content, /^---|type: feedback/m)
  assert.match(profile.content, /Casey has ten years of Go/)
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

test("writes Claude Code memories incrementally and retracts removed ones", async () => {
  const notion = fakeNotionMcp([], "Claude Code")
  const first = await syncMemories(notion.callTool, claudeSource)
  assert.equal(first.created, 4)
  const profile = [...notion.pages.values()].find(
    (p) => p.Title === "Role and background"
  )
  assert.equal(profile?.Type, "Profile")
  assert.equal(profile?.Source, "Claude Code")
  assert.equal(profile?.lastUpdatedBy, "Claude Code")
  // The fake MCP's user is Casey Boyer; memories use the first name.
  assert.match(profile?.content ?? "", /Casey has ten years of Go/)
  assert.match(profile?.content ?? "", /From Claude Code memories \(code-app/)

  // Claude rewrites one memory and deletes another (for example with `rm`).
  const role = path.join(MEMORY_DIR, "user_role.md")
  fs.writeFileSync(
    role,
    fs.readFileSync(role, "utf8").replace("ten years", "twelve years")
  )
  fs.rmSync(path.join(MEMORY_DIR, "reference_dashboards.md"))
  notion.calls.length = 0
  const second = await syncMemories(notion.callTool, claudeSource)
  assert.equal(second.updated, 1)
  assert.equal(second.unchanged, 2)
  assert.equal(second.noLongerInAgent, 1)
  assert.match(profile?.content ?? "", /twelve years/)
  assert.ok(notion.calls.includes("finish-revision"))
  // The dropped memory moves out of Memories under a private archive page and its text
  // is cleared. Nothing is trashed.
  const root = [...notion.pages.values()].find(
    (p) => p.Title === "Claude Code memory source archive"
  )
  assert.equal(root?.parent, "private")
  const removed = [...notion.pages.values()].filter(
    (p) => p.parent === root?.id
  )
  assert.equal(removed.length, 1)
  assert.match(
    removed[0].content,
    /^This projection was removed from Claude Code\./
  )
  assert.ok(![...notion.pages.values()].some((p) => p.deleted))
  assert.equal(Object.keys(loadState().memories).length, 3)
})
