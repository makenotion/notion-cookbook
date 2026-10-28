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

const { claudeMemoryInventory, claudeSource } = await import(
  "../scripts/claude.ts"
)
const { syncMemories } = await import("../scripts/memories.ts")
const { loadState } = await import("../scripts/config.ts")

test("lists auto memory files with unchanged Markdown, one page per file", () => {
  const files = claudeMemoryInventory(path.join(home, "projects")).files
  assert.deepEqual(
    files.map((f) => [f.type, f.title]),
    [
      ["Preference", "code-app/feedback_tests.md"],
      ["Work", "code-app/project_launch.md"],
      ["Notes", "code-app/reference_dashboards.md"],
      ["Notes", "code-app/scratch.md"],
      ["Profile", "code-app/user_role.md"],
    ]
  )
  const [feedback] = files
  assert.equal(feedback.name, `${PROJECT}/memory/feedback_tests.md`)
  assert.equal(
    feedback.content,
    fs.readFileSync(path.join(FIXTURES, "feedback_tests.md"), "utf8")
  )
  // A flat custom directory has no project folders.
  assert.deepEqual(
    claudeMemoryInventory(FIXTURES).files.map((f) => f.title),
    [
      "feedback_tests.md",
      "project_launch.md",
      "reference_dashboards.md",
      "scratch.md",
      "user_role.md",
    ]
  )
})

test("copies Claude Code memory files, updates the same page, and leaves deleted files' pages", async () => {
  const notion = fakeNotionMcp([], "Claude Code")
  const first = await syncMemories(notion.callTool, claudeSource)
  assert.equal(first.created, 5)
  const role = path.join(MEMORY_DIR, "user_role.md")
  const profile = [...notion.pages.values()].find(
    (p) => p.Title === "code-app/user_role.md"
  )
  assert.equal(profile?.Type, "Profile")
  assert.equal(profile?.Source, "Claude Code")
  assert.equal(profile?.lastUpdatedBy, "Claude Code")
  const content = String(profile?.content)
  assert.ok(content.startsWith("# Claude Code memory source\n"))
  assert.match(content, /"Source root": "projects"/)
  assert.ok(content.includes(`"Source path": "${PROJECT}/memory/user_role.md"`))
  assert.ok(!content.includes(home))
  assert.ok(content.endsWith(`\n---\n\n${fs.readFileSync(role, "utf8")}`))

  // Claude rewrites one memory and deletes another (for example with `rm`).
  fs.writeFileSync(
    role,
    fs.readFileSync(role, "utf8").replace("ten years", "twelve years")
  )
  fs.rmSync(path.join(MEMORY_DIR, "reference_dashboards.md"))
  const second = await syncMemories(notion.callTool, claudeSource)
  assert.equal(second.updated, 1)
  assert.equal(second.unchanged, 3)
  assert.ok(
    String(profile?.content).endsWith(
      `\n---\n\n${fs.readFileSync(role, "utf8")}`
    )
  )
  // The deleted file's page stays as it was; the plugin never deletes.
  assert.equal(notion.pages.size, 5)
  assert.ok(![...notion.pages.values()].some((p) => p.deleted))
  assert.equal(Object.keys(loadState().files).length, 5)
})
