import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { fakeNotionMcp } from "./fakeNotionMcp.ts"

// The plugin resolves its paths at import time, so point them at a temp dir first.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-notion-memory-"))
process.env.NOTION_MEMORY_AGENT = "codex"
process.env.CODEX_HOME = home
const FIXTURES = fileURLToPath(new URL("fixtures/memories", import.meta.url))
const { codexSource, parseCodexMemories } = await import(
  "../plugin/src/codex.ts"
)
const { syncMemories } = await import("../plugin/src/memories.ts")
const { notionTools } = await import("../plugin/src/mcp.ts")
const { loadState } = await import("../plugin/src/config.ts")

test("finds Notion tools on the MCP server and on the Notion app", () => {
  const mcp = notionTools({
    name: "notion",
    tools: {
      "notion-create-pages": {},
      "notion-fetch": {},
      "notion-update-page": {},
    },
  })
  assert.equal(mcp.get("createpages"), "notion-create-pages")
  assert.equal(mcp.get("updatepage"), "notion-update-page")
  const apps = notionTools({
    name: "codex_apps",
    tools: {
      notion_notion_create_pages: {},
      notion_notion_fetch: {},
      google_drive_fetch: {},
    },
  })
  assert.equal(apps.get("fetch"), "notion_notion_fetch")
  assert.equal(apps.size, 2)
  assert.equal(notionTools({ name: "other", tools: { fetch: {} } }).size, 0)
})

test("parses Codex memory files into one memory per topic", () => {
  const memories = parseCodexMemories(FIXTURES, "Casey")
  assert.deepEqual(
    memories.map((m) => [m.type, m.title]),
    [
      ["Profile", "Role and background"],
      ["Preference", "Coding workflow preferences"],
      ["Work", "Small Node.js CLI utilities"],
    ]
  )
  const [profile, preferences, work] = memories
  assert.match(profile.content, /^Casey is a TypeScript developer/)
  assert.match(preferences.content, /keep answers short/)
  assert.match(work.content, /Scope: Node\.js command-line tools/)
  assert.match(work.content, /verify it with a one-line `node -e` check/)
  // Preferences from the global summary are not repeated in the project memory.
  assert.doesNotMatch(work.content, /zero dependencies/)
  assert.doesNotMatch(JSON.stringify(memories), /\[Task \d+\]/)
})

test("returns nothing for missing or placeholder memory files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-memories-"))
  fs.writeFileSync(
    path.join(dir, "memory_summary.md"),
    "## User preferences\n\n- No preferences recorded yet.\n"
  )
  assert.deepEqual(parseCodexMemories(dir), [])
  assert.deepEqual(parseCodexMemories(path.join(dir, "missing")), [])
})

test("writes memories incrementally and never deletes", async () => {
  const dir = path.join(home, "memories")
  fs.cpSync(FIXTURES, dir, { recursive: true })
  const notion = fakeNotionMcp([
    { Title: "Coding workflow preferences", Type: "Preference" },
  ])

  // An existing memory on the same topic wins over a second copy.
  assert.deepEqual(await syncMemories(notion.callTool, codexSource), {
    total: 3,
    created: 2,
    updated: 0,
    unchanged: 0,
    changedInNotion: 0,
    skippedExisting: 1,
    noLongerInAgent: 0,
  })
  const profile = [...notion.pages.values()].find(
    (p) => p.Title === "Role and background"
  )
  assert.equal(profile?.Type, "Profile")
  assert.match(profile?.content ?? "", /^Casey is a TypeScript developer/)

  notion.calls.length = 0
  const again = await syncMemories(notion.callTool, codexSource)
  assert.equal(again.unchanged, 2)
  assert.ok(!notion.calls.includes("create-pages"))
  assert.ok(!notion.calls.includes("update-page"))

  // Codex rewrites its profile: the plugin updates the same page.
  const summary = path.join(dir, "memory_summary.md")
  const original = fs.readFileSync(summary, "utf8")
  fs.writeFileSync(summary, original.replace("TypeScript", "Rust"))
  const updated = await syncMemories(notion.callTool, codexSource)
  assert.equal(updated.updated, 1)
  assert.match(profile?.content ?? "", /Rust developer/)
  assert.ok(notion.calls.includes("finish-revision"))

  // Casey edits the profile in Notion. Codex changes after that leave it alone.
  profile!.content += "\nAlso writes Python."
  fs.writeFileSync(summary, original.replace("TypeScript", "Go"))
  const kept = await syncMemories(notion.callTool, codexSource)
  assert.equal(kept.changedInNotion, 1)
  assert.match(profile?.content ?? "", /Rust developer/)
  fs.writeFileSync(summary, original.replace("TypeScript", "Zig"))
  await syncMemories(notion.callTool, codexSource)
  assert.match(profile?.content ?? "", /Rust developer/)

  // Casey deletes the project memory in Notion. The plugin does not bring it back.
  const work = [...notion.pages.values()].find(
    (p) => p.Title === "Small Node.js CLI utilities"
  )
  work!.deleted = true
  const memoryFile = path.join(dir, "MEMORY.md")
  fs.appendFileSync(memoryFile, "- Use `node --watch` while iterating\n")
  notion.calls.length = 0
  assert.equal(
    (await syncMemories(notion.callTool, codexSource)).changedInNotion,
    2
  )
  assert.ok(!notion.calls.includes("create-pages"))

  // Codex drops the project: the plugin forgets it and deletes nothing.
  fs.writeFileSync(memoryFile, "")
  const dropped = await syncMemories(notion.callTool, codexSource)
  assert.equal(dropped.noLongerInAgent, 1)
  assert.deepEqual(Object.keys(loadState().memories), ["profile"])
})
