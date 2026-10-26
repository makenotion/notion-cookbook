import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fixture, object } from "./support/harness.ts"

test("knowledge creation and updates attribute Codex while preserving the original source", async (t) => {
  const f = fixture(t)
  f.seed()
  assert.equal((await f.exec(["sync"])).code, 0)
  for (const page of f.pages()) {
    assert.equal(page.source, "Codex")
    assert.equal(page.lastUpdatedBy, "Codex")
  }
  const pages = f.pages()
  const profile = pages.find((p) => p.title === "Role and background")
  assert.ok(profile)
  profile.source = "Claude Code"
  profile.lastUpdatedBy = "Claude Code"
  f.savePages(pages)
  const summary = path.join(f.home, "memories/memory_summary.md")
  fs.writeFileSync(
    summary,
    fs.readFileSync(summary, "utf8").replace("TypeScript", "Rust")
  )
  const result = await f.exec(["sync"])
  assert.equal(result.code, 0, result.stderr)
  const updated = f.pages().find((p) => p.id === profile.id)
  assert.equal(updated?.source, "Claude Code")
  assert.equal(updated?.lastUpdatedBy, "Codex")
  assert.match(String(updated?.content), /Rust developer/)
})

test("legacy pages receive attribution without rewriting content or creating pages", async (t) => {
  const f = fixture(t)
  f.seed()
  assert.equal((await f.exec(["sync"])).code, 0)
  const stateFile = path.join(f.home, "notion-memory/state.json")
  const state = object(JSON.parse(fs.readFileSync(stateFile, "utf8")))
  for (const entry of Object.values(object(state.memories)))
    delete object(entry).attribution
  fs.writeFileSync(stateFile, JSON.stringify(state))
  const before = f.pages()
  for (const page of before) {
    delete page.source
    delete page.lastUpdatedBy
  }
  f.savePages(before)
  const result = await f.exec(["sync"])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).updated, 4)
  assert.deepEqual(
    f.pages().map((p) => [p.id, p.content]),
    before.map((p) => [p.id, p.content])
  )
  for (const page of f.pages()) {
    assert.equal(page.source, "Codex")
    assert.equal(page.lastUpdatedBy, "Codex")
  }
  const again = await f.exec(["sync"])
  assert.equal(again.code, 0, again.stderr)
  assert.equal(JSON.parse(again.stdout).updated, 0)
  assert.equal(f.pages().length, 4)
})

test("attribution backfill protects externally edited pages", async (t) => {
  const f = fixture(t)
  f.seed()
  assert.equal((await f.exec(["sync"])).code, 0)
  const stateFile = path.join(f.home, "notion-memory/state.json")
  const state = object(JSON.parse(fs.readFileSync(stateFile, "utf8")))
  for (const entry of Object.values(object(state.memories)))
    delete object(entry).attribution
  fs.writeFileSync(stateFile, JSON.stringify(state))
  const pages = f.pages()
  const first = pages[0]
  assert.ok(first)
  first.content = "This text was edited outside the plugin."
  first.source = "Claude"
  first.lastUpdatedBy = "Claude"
  f.savePages(pages)
  const result = await f.exec(["sync"])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).changedInNotion, 1)
  assert.deepEqual(
    f.pages().find((p) => p.id === first.id),
    first
  )
})
