import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import type { NotionClient } from "../plugin/src/notion.ts"

// The plugin resolves CODEX_HOME at import time, so point it at a temp dir first.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-notion-sync-"))
process.env.CODEX_HOME = home
const FIXTURES = fileURLToPath(new URL("fixtures/memories", import.meta.url))
const { parseCodexMemories, syncMemories } = await import(
  "../plugin/src/memories.ts"
)
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

// In-memory stand-in for the Notion API calls the memory sync makes.
function fakeNotion() {
  const pages = new Map<
    string,
    { last_edited_time: string; in_trash: boolean; title: string }
  >()
  let next = 0
  const client = {
    async request(method: string, url: string, body: any) {
      assert.equal(`${method} ${url}`, "POST /v1/tools/run")
      assert.equal(body.create_pages.parent, "memory")
      const page = body.create_pages.pages[0]
      assert.equal(page.properties.Source, "Codex")
      const id = `page-${++next}`
      pages.set(id, {
        last_edited_time: "t0",
        in_trash: false,
        title: page.properties.title,
      })
      return { pages: [{ id }] }
    },
    async getPage(id: string) {
      return { id, ...pages.get(id) }
    },
    async trashPage(id: string) {
      const page = pages.get(id)
      if (page) page.in_trash = true
      return { id }
    },
  }
  return { pages, client: client as unknown as NotionClient }
}

test("syncs memories incrementally and keeps pages edited in Notion", async () => {
  const dir = path.join(home, "memories")
  fs.cpSync(FIXTURES, dir, { recursive: true })
  const { pages, client } = fakeNotion()

  assert.deepEqual(await syncMemories(client), {
    total: 6,
    created: 6,
    updated: 0,
    removed: 0,
    skippedEdited: 0,
  })
  const again = await syncMemories(client)
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

  const result = await syncMemories(client)
  assert.equal(result.skippedEdited, 1)
  assert.equal(result.removed, 1)
  assert.equal(pages.get(edited?.pageId ?? "")?.in_trash, false)
  assert.equal(
    [...pages.values()].find((p) => p.title.startsWith("Never commit"))
      ?.in_trash,
    true
  )
})
