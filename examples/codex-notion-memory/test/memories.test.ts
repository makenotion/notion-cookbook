import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { fakeNotion } from "./fakeNotion.ts"

// The plugin resolves its paths at import time, so point them at a temp dir first.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-notion-memory-"))
process.env.NOTION_MEMORY_AGENT = "codex"
process.env.CODEX_HOME = home
const FIXTURES = fileURLToPath(new URL("fixtures/memories", import.meta.url))
const { codexSource, parseCodexMemories } = await import(
  "../plugin/src/codex.ts"
)
const { syncMemories } = await import("../plugin/src/memories.ts")
const { loadState } = await import("../plugin/src/config.ts")

test("parses Codex memory files into typed memories", () => {
  const memories = parseCodexMemories(FIXTURES)
  assert.deepEqual(
    memories.map((m) => [m.type, m.title]),
    [
      ["Profile", "Codex user profile"],
      [
        "Preference",
        "I always want node:test, zero dependencies and no semicolons.",
      ],
      ["Preference", "Keep answers short"],
      ["Preference", "Never commit or push without asking me first"],
      ["Work", "Small Node.js CLI utilities"],
      [
        "Preference",
        "When a fix is small, verify it with a one-line `node -e` check",
      ],
    ]
  )
  const work = memories.find((m) => m.type === "Work")
  assert.match(work?.content ?? "", /Scope: Node\.js command-line tools/)
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

test("syncs memories incrementally and keeps pages edited in Notion", async () => {
  const dir = path.join(home, "memories")
  fs.cpSync(FIXTURES, dir, { recursive: true })
  const { pages, client } = fakeNotion("Codex")

  assert.deepEqual(await syncMemories(client, codexSource), {
    total: 6,
    created: 6,
    updated: 0,
    removed: 0,
    skippedEdited: 0,
  })
  const again = await syncMemories(client, codexSource)
  assert.equal(again.created + again.updated + again.removed, 0)

  // The user edits the "keep answers short" memory in Notion, then Codex rewrites it.
  const edited = Object.values(loadState().memories).find(
    (m) => m.title === "Keep answers short"
  )
  pages.get(edited?.pageId ?? "")!.last_edited_time = "t1"
  const summary = path.join(dir, "memory_summary.md")
  fs.writeFileSync(
    summary,
    fs
      .readFileSync(summary, "utf8")
      .replace(
        "give concise completion reports",
        "answer in two sentences or fewer"
      )
      .replace(/^- “never commit.*\n/m, "")
  )

  const result = await syncMemories(client, codexSource)
  assert.equal(result.skippedEdited, 1)
  assert.equal(result.removed, 1)
  assert.equal(pages.get(edited?.pageId ?? "")?.in_trash, false)
  assert.equal(
    [...pages.values()].find((p) => p.title.startsWith("Never commit"))
      ?.in_trash,
    true
  )
})
