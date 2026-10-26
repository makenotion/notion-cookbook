import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fixture } from "./support/harness.ts"

test("one file becomes one Notes page with unchanged Markdown and Codex attribution", async (t) => {
  const f = fixture(t)
  f.seed()
  const text =
    "# Raw title\n\nThe user said `keep {this}` and literal `</content>`.\n\n- [Task 42] thread_id=abc123\n\n汉字 🧠\n"
  fs.writeFileSync(path.join(f.home, "memories_v2/memory_summary.md"), text)
  const result = await f.exec(["sync"])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).created, 2)
  const page = f.pages().find((p) => p.title === "memory_summary.md")
  assert.equal(page?.content, text)
  assert.equal(page?.type, "Notes")
  assert.equal(page?.source, "Codex")
  assert.equal(page?.lastUpdatedBy, "Codex")
  assert.ok(!f.calls().includes("query-data-sources"))
  assert.ok(!f.calls().includes("turn/start"))
  const again = await f.exec(["sync"])
  assert.equal(again.code, 0, again.stderr)
  assert.equal(JSON.parse(again.stdout).unchanged, 2)
  assert.equal(f.pages().length, 2)
  const pages = f.pages()
  const edited = pages.find((p) => p.id === page?.id)
  assert.ok(edited)
  edited.content = `${text}\nHuman edit after the literal closing tag.`
  f.savePages(pages)
  assert.equal((await f.exec(["verify"])).code, 1)
})

test("append, override and empty content update the same page", async (t) => {
  const f = fixture(t)
  f.seed()
  assert.equal((await f.exec(["sync"])).code, 0)
  const id = f.pages().find((p) => p.title === "memory_summary.md")?.id
  for (const text of ["baseline\nappended\n", "replacement\n", ""]) {
    fs.writeFileSync(path.join(f.home, "memories_v2/memory_summary.md"), text)
    const r = await f.exec(["sync"])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout).updated, 1)
    assert.equal(f.pages().find((p) => p.id === id)?.content, text)
    assert.equal(f.pages().length, 2)
  }
})

test("manual Notion changes are protected when the source changes", async (t) => {
  const f = fixture(t)
  f.seed()
  assert.equal((await f.exec(["sync"])).code, 0)
  const pages = f.pages()
  const edited = pages.find((p) => p.title === "memory_summary.md")
  const deleted = pages.find((p) => p.title === "MEMORY.md")
  assert.ok(edited && deleted)
  edited.content = "Human-owned text"
  deleted.deleted = true
  f.savePages(pages)
  for (const name of ["memory_summary.md", "MEMORY.md"])
    fs.writeFileSync(path.join(f.home, "memories_v2", name), "Changed source\n")
  const r = await f.exec(["sync"])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).changedInNotion, 2)
  assert.deepEqual(f.pages(), pages)
})

test("missing optional file leaves its existing page alone; absent summary fails without writes", async (t) => {
  const f = fixture(t)
  f.seed()
  assert.equal((await f.exec(["sync"])).code, 0)
  const before = f.pages()
  fs.unlinkSync(path.join(f.home, "memories_v2/MEMORY.md"))
  assert.equal((await f.exec(["sync"])).code, 0)
  assert.deepEqual(f.pages(), before)
  fs.unlinkSync(path.join(f.home, "memories_v2/memory_summary.md"))
  const r = await f.exec(["sync"])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /not ready/)
  assert.deepEqual(f.pages(), before)
})

test("overlapping processes create one page per file and keep notices separate", async (t) => {
  const f = fixture(t)
  f.seed()
  const results = await Promise.all([
    f.exec(["sync"], { FIXTURE_NOTICE: "true" }),
    f.exec(["sync"]),
  ])
  for (const r of results) assert.equal(r.code, 0, r.stderr)
  assert.equal(f.pages().length, 2)
  assert.ok(
    results.some((r) => /Synthetic workspace quota notice/.test(r.stderr))
  )
})

test("preview is offline and verify detects changed pages", async (t) => {
  const f = fixture(t)
  f.seed()
  const preview = await f.exec(["preview"])
  assert.equal(preview.code, 0, preview.stderr)
  assert.equal(JSON.parse(preview.stdout).length, 2)
  assert.deepEqual(f.calls(), [])
  assert.equal((await f.exec(["sync"])).code, 0)
  assert.equal(JSON.parse((await f.exec(["verify"])).stdout).verified, 2)
  const pages = f.pages()
  pages[0].content = "Changed in Notion"
  f.savePages(pages)
  const r = await f.exec(["verify"])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /Page changed/)
})

test("hook with no latest memory directory starts no worker", async (t) => {
  const f = fixture(t)
  assert.equal((await f.exec(["hook", "session-start"])).code, 0)
  assert.deepEqual(f.calls(), [])
})
