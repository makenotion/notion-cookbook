import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

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

const { claudeMemoryInventory } = await import("../scripts/claude.ts")

test("lists auto memory files with unchanged Markdown, one page per file", () => {
  const files = claudeMemoryInventory(
    path.join(home, "projects"),
    "projects"
  ).files
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
    claudeMemoryInventory(FIXTURES, "flat").files.map((f) => f.title),
    [
      "feedback_tests.md",
      "project_launch.md",
      "reference_dashboards.md",
      "scratch.md",
      "user_role.md",
    ]
  )
})
