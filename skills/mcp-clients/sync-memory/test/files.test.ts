import assert from "node:assert/strict"
import fs from "node:fs"
import crypto from "node:crypto"
import path from "node:path"
import { test } from "node:test"
import { sourceCreatedAt } from "../scripts/memories.ts"
import { fixture, object } from "./support/harness.ts"

function copiedPage(content: unknown) {
  assert.ok(typeof content === "string", "page content is a string")
  const frame = content.match(
    /^# Codex memory source\n\n```json\n([\s\S]*?)\n```\n\n---\n\n/
  )
  assert.ok(frame, "source metadata preamble is present")
  return {
    metadata: object(JSON.parse(frame[1])),
    original: content.slice(frame[0].length),
  }
}

test("nested Markdown copies unchanged by relative path and detects new files and updates", async (t) => {
  const f = fixture(t)
  f.seed()
  assert.equal((await f.exec(["sync"])).code, 0)
  const files = [
    {
      name: "extensions/ad_hoc/notes/shared.md",
      content: "  # Preference\r\n\r\nKeep `</content>` and 汉字 🧠.\r\n\r\n",
    },
    {
      name: "rollout_summaries/shared.md",
      content: "# Session\n\n  Literal {metadata}\n\n",
    },
  ]
  for (const file of files) {
    const target = path.join(f.home, "memories_v2", file.name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, file.content)
  }
  const preview = await f.exec(["preview"])
  assert.equal(preview.code, 0, preview.stderr)
  assert.deepEqual(
    JSON.parse(preview.stdout).files.map((file: { name: string }) => file.name),
    ["MEMORY.md", ...files.map((file) => file.name), "memory_summary.md"].sort()
  )
  const created = await f.exec(["sync"])
  assert.equal(created.code, 0, created.stderr)
  assert.equal(JSON.parse(created.stdout).created, 2)
  assert.equal(JSON.parse(created.stdout).unchanged, 2)
  for (const file of files)
    assert.equal(
      copiedPage(f.pages().find((page) => page.title === file.name)?.content)
        .original,
      file.content
    )

  const title = "rollout_summaries/shared.md"
  const id = f.pages().find((page) => page.title === title)?.id
  const replacement = "\nReplacement with trailing whitespace.  \n"
  fs.writeFileSync(path.join(f.home, "memories_v2", title), replacement)
  const updated = await f.exec(["sync"])
  assert.equal(updated.code, 0, updated.stderr)
  assert.equal(JSON.parse(updated.stdout).updated, 1)
  assert.equal(JSON.parse(updated.stdout).unchanged, 3)
  assert.equal(
    copiedPage(f.pages().find((page) => page.id === id)?.content).original,
    replacement
  )
  assert.equal(f.pages().length, 4)
  const verified = await f.exec(["verify"])
  assert.equal(verified.code, 0, verified.stderr)
  assert.equal(JSON.parse(verified.stdout).verified, 4)
})

test("Git state, non-Markdown files and file or directory symlinks are excluded", async (t) => {
  const f = fixture(t)
  f.seed()
  const dir = path.join(f.home, "memories_v2")
  fs.mkdirSync(path.join(dir, ".git/nested"), { recursive: true })
  fs.writeFileSync(path.join(dir, ".git/nested/internal.md"), "Git state")
  fs.writeFileSync(path.join(dir, "other.txt"), "Not Markdown")
  fs.writeFileSync(path.join(f.root, "outside.md"), "Outside memory")
  fs.symlinkSync(path.join(f.root, "outside.md"), path.join(dir, "linked.md"))
  fs.symlinkSync(f.root, path.join(dir, "linked-directory"), "dir")
  const result = await f.exec(["sync"])
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(
    f.pages().map((page) => page.title),
    ["MEMORY.md", "memory_summary.md"]
  )
  assert.deepEqual(JSON.parse(result.stdout).unsupported, [
    "linked-directory",
    "linked.md",
    "other.txt",
  ])
})

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
  assert.equal(copiedPage(page?.content).original, text)
  assert.equal(page?.type, "Notes")
  assert.equal(page?.source, "Codex")
  assert.equal(page?.lastUpdatedBy, "Codex")
  assert.ok(!f.calls().includes("query-data-sources"))
  assert.ok(!f.calls().includes("turn/start"))
  assert.ok(!f.calls().includes("update-data-source"))
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
    assert.equal(
      copiedPage(f.pages().find((p) => p.id === id)?.content).original,
      text
    )
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

test("missing files are reported without deletion and summary is optional", async (t) => {
  const f = fixture(t)
  f.seed()
  assert.equal((await f.exec(["sync"])).code, 0)
  const before = f.pages()
  fs.unlinkSync(path.join(f.home, "memories_v2/MEMORY.md"))
  const missing = await f.exec(["sync"])
  assert.equal(missing.code, 0)
  assert.deepEqual(JSON.parse(missing.stdout).missing, ["MEMORY.md"])
  assert.deepEqual(f.pages(), before)
  fs.unlinkSync(path.join(f.home, "memories_v2/memory_summary.md"))
  fs.writeFileSync(path.join(f.home, "memories_v2/remaining.md"), "remaining")
  const r = await f.exec(["sync"])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).created, 1)
  assert.deepEqual(JSON.parse(r.stdout).missing, [
    "MEMORY.md",
    "memory_summary.md",
  ])
  assert.equal(f.pages().length, before.length + 1)
})

test("overlapping processes create one page per file and keep notices separate", async (t) => {
  const f = fixture(t)
  f.seed()
  // Whichever process takes the lock first writes both pages, and the other then has
  // nothing to send, so both get notices.
  const results = await Promise.all([
    f.exec(["sync"], { FIXTURE_NOTICE: "true" }),
    f.exec(["sync"], { FIXTURE_NOTICE: "true" }),
  ])
  for (const r of results) {
    assert.equal(r.code, 0, r.stderr)
    assert.equal(typeof JSON.parse(r.stdout).total, "number")
  }
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
  assert.equal(JSON.parse(preview.stdout).files.length, 2)
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

test("source metadata stays in the body and metadata-only updates preserve identity", async (t) => {
  const f = fixture(t)
  f.seed()
  const file = path.join(f.home, "memories_v2/memory_summary.md")
  const original = fs.readFileSync(file, "utf8")
  const stat = fs.statSync(file)
  const preview = await f.exec(["preview"])
  assert.equal(preview.code, 0, preview.stderr)
  const sources: unknown = JSON.parse(preview.stdout).files
  assert.ok(Array.isArray(sources))
  const source = sources
    .map(object)
    .find((item) => item.name === "memory_summary.md")
  assert.ok(source)
  assert.equal(
    source.hash,
    crypto.createHash("sha256").update(original).digest("hex")
  )
  assert.equal(source.createdAt, sourceCreatedAt(stat.birthtimeMs))
  assert.equal(source.updatedAt, stat.mtime.toISOString())
  assert.equal((await f.exec(["sync"])).code, 0)
  const before = f.pages().find((page) => page.title === "memory_summary.md")
  assert.ok(before)
  const first = copiedPage(before.content)
  assert.deepEqual(first.metadata, {
    Source: "Codex",
    "Source root": "memories_v2",
    "Source path": "memory_summary.md",
    "Source created at": source.createdAt,
    "Source updated at": source.updatedAt,
    "Synced at": first.metadata["Synced at"],
    "Synced by": "notion-memory",
  })
  assert.equal(typeof first.metadata["Synced at"], "string")
  assert.ok(Number.isFinite(Date.parse(String(first.metadata["Synced at"]))))
  assert.equal(first.original, original)
  assert.ok(!String(before.content).includes(f.home))
  const callsBefore = f.calls().length
  const repeat = await f.exec(["sync"])
  assert.equal(repeat.code, 0, repeat.stderr)
  assert.equal(JSON.parse(repeat.stdout).unchanged, 2)
  assert.equal(
    f.calls().length,
    callsBefore,
    "unchanged files make no remote calls"
  )
  assert.deepEqual(
    f.pages().find((page) => page.id === before.id),
    before
  )

  const later = new Date(stat.mtimeMs + 10_000)
  fs.utimesSync(file, stat.atime, later)
  const unverified = await f.exec(["verify"])
  assert.equal(unverified.code, 1)
  assert.match(unverified.stderr, /Unsynced file: memory_summary.md/)
  const update = await f.exec(["sync"])
  assert.equal(update.code, 0, update.stderr)
  assert.equal(JSON.parse(update.stdout).updated, 1)
  const after = f.pages().find((page) => page.id === before.id)
  assert.ok(after)
  const second = copiedPage(after.content)
  assert.equal(second.original, original)
  assert.equal(
    second.metadata["Source updated at"],
    fs.statSync(file).mtime.toISOString()
  )
  assert.notEqual(second.metadata["Synced at"], first.metadata["Synced at"])
  assert.equal(f.pages().length, 2)
  assert.equal((await f.exec(["verify"])).code, 0)
})

test("existing mappings without metadata hashes backfill once without creating pages", async (t) => {
  const f = fixture(t)
  f.seed()
  assert.equal((await f.exec(["sync"])).code, 0)
  const stateFile = path.join(f.home, "notion-memory/state.json")
  const state = object(JSON.parse(fs.readFileSync(stateFile, "utf8")))
  const files = object(state.files)
  for (const value of Object.values(files)) delete object(value).metadataHash
  fs.writeFileSync(stateFile, JSON.stringify(state))
  const ids = f.pages().map((page) => page.id)
  const backfill = await f.exec(["sync"])
  assert.equal(backfill.code, 0, backfill.stderr)
  assert.equal(JSON.parse(backfill.stdout).updated, 2)
  assert.equal(JSON.parse(backfill.stdout).created, 0)
  assert.deepEqual(
    f.pages().map((page) => page.id),
    ids
  )
  const again = await f.exec(["sync"])
  assert.equal(again.code, 0, again.stderr)
  assert.equal(JSON.parse(again.stdout).unchanged, 2)
})

test("unavailable birth time stays empty rather than falling back to ctime", () => {
  for (const value of [0, -1, NaN, Infinity, 9e18])
    assert.equal(sourceCreatedAt(value), null)
  assert.equal(sourceCreatedAt(1_700_000_000_000), "2023-11-14T22:13:20.000Z")
})

test("acknowledged create survives failed readback without creating duplicates", async (t) => {
  const f = fixture(t)
  f.seed()
  const failed = await f.exec(["sync"], { FIXTURE_FAIL_ONCE: "fetch" })
  assert.equal(failed.code, 1)
  assert.equal(f.pages().length, 1)
  const state = object(
    JSON.parse(
      fs.readFileSync(path.join(f.home, "notion-memory/state.json"), "utf8")
    )
  )
  assert.equal(object(object(state.pending)["MEMORY.md"]).phase, "readback")
  const retried = await f.exec(["sync"])
  assert.equal(retried.code, 0, retried.stderr)
  assert.equal(f.pages().length, 2)
  assert.equal(f.calls().filter((call) => call === "create-pages").length, 2)
})

for (const operation of ["create", "update"]) {
  test(`failed ${operation} readback cannot adopt later human edits`, async (t) => {
    const f = fixture(t)
    f.seed()
    const source = path.join(f.home, "memories_v2/MEMORY.md")
    if (operation === "update") {
      assert.equal((await f.exec(["sync"])).code, 0)
      fs.writeFileSync(source, "first local update")
    }
    const failed = await f.exec(["sync"], {
      FIXTURE_FAIL_ONCE: operation === "create" ? "fetch" : "update-readback",
    })
    assert.equal(failed.code, 1)
    const pages = f.pages()
    const page = pages.find((entry) => entry.title === "MEMORY.md")
    assert.ok(page)
    page.content = "Human edit after the failed readback"
    f.savePages(pages)
    fs.writeFileSync(source, "newer local update")
    const writes = () =>
      f
        .calls()
        .filter((call) => call === "create-pages" || call === "update-page")
        .length
    const before = writes()
    const retried = await f.exec(["sync"])
    assert.equal(retried.code, 1)
    assert.match(retried.stderr, /readback.*reconcil/i)
    assert.equal(writes(), before)
    assert.deepEqual(f.pages(), pages)
    const state = object(
      JSON.parse(
        fs.readFileSync(path.join(f.home, "notion-memory/state.json"), "utf8")
      )
    )
    assert.equal(object(object(state.pending)["MEMORY.md"]).phase, "readback")
  })
}

test("acknowledged update survives failed readback and a newer or missing source", async (t) => {
  const f = fixture(t)
  f.seed()
  assert.equal((await f.exec(["sync"])).code, 0)
  const file = path.join(f.home, "memories_v2/memory_summary.md")
  const id = f.pages().find((page) => page.title === "memory_summary.md")?.id
  fs.writeFileSync(file, "first update")
  const failed = await f.exec(["sync"], {
    FIXTURE_FAIL_ONCE: "update-readback",
  })
  assert.equal(failed.code, 1)
  assert.equal((await f.exec(["verify"])).code, 1)
  fs.writeFileSync(file, "second update")
  const retried = await f.exec(["sync"])
  assert.equal(retried.code, 0, retried.stderr)
  assert.equal(JSON.parse(retried.stdout).changedInNotion, 0)
  assert.equal(
    copiedPage(f.pages().find((page) => page.id === id)?.content).original,
    "second update"
  )
  fs.writeFileSync(file, "third update")
  const failedAgain = await f.exec(["sync"], {
    FIXTURE_FAIL_ONCE: "update-readback-again",
  })
  assert.equal(failedAgain.code, 1)
  fs.unlinkSync(file)
  const disappeared = await f.exec(["sync"])
  assert.equal(disappeared.code, 0, disappeared.stderr)
  assert.deepEqual(JSON.parse(disappeared.stdout).missing, [
    "memory_summary.md",
  ])
  assert.equal(f.pages().length, 2)
})

test("successful immediate readback accepts Markdown normalization", async (t) => {
  const f = fixture(t)
  f.seed()
  const file = path.join(f.home, "memories_v2/MEMORY.md")
  for (const text of [
    "# First\r\n\r\nBody\r\n",
    "# Second\r\n\r\nUpdated\r\n",
  ]) {
    fs.writeFileSync(file, text)
    const synced = await f.exec(["sync"], {
      FIXTURE_NORMALIZE_MARKDOWN: "true",
    })
    assert.equal(synced.code, 0, synced.stderr)
    const page = f.pages().find((entry) => entry.title === "MEMORY.md")
    assert.equal(
      copiedPage(page?.content).original,
      text.replace(/\r\n/g, "\n")
    )
    const verified = await f.exec(["verify"])
    assert.equal(verified.code, 0, verified.stderr)
  }
  assert.equal(f.pages().length, 2)
})

test("legacy pending readback without a submitted fingerprint requires reconciliation", async (t) => {
  const f = fixture(t)
  f.seed()
  assert.equal((await f.exec(["sync"], { FIXTURE_FAIL_ONCE: "fetch" })).code, 1)
  const stateFile = path.join(f.home, "notion-memory/state.json")
  const state = object(JSON.parse(fs.readFileSync(stateFile, "utf8")))
  delete object(object(state.pending)["MEMORY.md"]).expectedPageHash
  fs.writeFileSync(stateFile, JSON.stringify(state))
  const before = f.pages()
  const retried = await f.exec(["sync"])
  assert.equal(retried.code, 1)
  assert.match(retried.stderr, /readback.*reconcil/i)
  assert.deepEqual(f.pages(), before)
  assert.equal(f.calls().filter((call) => call === "create-pages").length, 1)
})

for (const operation of ["create", "update"]) {
  test(`lost ${operation} response persists unknown outcome and blocks mutating retries`, async (t) => {
    const f = fixture(t)
    f.seed()
    if (operation === "update") {
      assert.equal((await f.exec(["sync"])).code, 0)
      fs.writeFileSync(
        path.join(f.home, "memories_v2/memory_summary.md"),
        "updated source"
      )
    }
    const failed = await f.exec(["sync"], {
      FIXTURE_FAIL_ONCE: `${operation}-response`,
    })
    assert.equal(failed.code, 1)
    const calls = f.calls().length
    const retried = await f.exec(["sync"])
    assert.equal(retried.code, 1)
    assert.match(retried.stderr, /unknown.*(create|update).*reconcile/i)
    assert.equal(
      f.calls().length,
      calls,
      "unknown outcome sends no further remote calls"
    )
  })
}

test("deleted or malformed pending readback is never confirmed", async (t) => {
  const f = fixture(t)
  f.seed()
  assert.equal((await f.exec(["sync"], { FIXTURE_FAIL_ONCE: "fetch" })).code, 1)
  const calls = f.calls().filter((call) => call === "create-pages").length
  assert.equal(
    (await f.exec(["sync"], { FIXTURE_READBACK: "malformed" })).code,
    1
  )
  const pages = f.pages()
  pages[0].deleted = true
  f.savePages(pages)
  const retry = await f.exec(["sync"])
  assert.equal(retry.code, 1)
  assert.match(retry.stderr, /Pending readback page deleted/)
  const state = object(
    JSON.parse(
      fs.readFileSync(path.join(f.home, "notion-memory/state.json"), "utf8")
    )
  )
  assert.equal(object(object(state.pending)["MEMORY.md"]).phase, "readback")
  assert.equal(
    f.calls().filter((call) => call === "create-pages").length,
    calls
  )
})
