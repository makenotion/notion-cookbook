import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fixture } from "./support/harness.ts"
import { archiveMemories, memorySources } from "../plugin/src/archive.ts"

test("only consolidated topics enter Memories; raw sources go under a private archive", async (t) => {
  const f = fixture(t)
  f.seed()
  fs.mkdirSync(path.join(f.home, "memories_v2"))
  fs.writeFileSync(
    path.join(f.home, "memories_v2/memory_summary.md"),
    `## User Profile\n\nCasey writes standalone tools.\n\n## User preferences\n\n- Review changes before publishing.\n\n## General Tips\n\n- Preserve unrelated working files.\n\n## What's in Memory\n\n### Inventory project\n\n- rollout_summaries/private-source.md — Exact prices must stay distinct from estimates. thread_id=synthetic-thread\n`
  )
  fs.writeFileSync(
    path.join(f.home, "memories_v2/raw_memories.md"),
    "DO_NOT_IMPORT_LOG ".repeat(1000)
  )
  fs.writeFileSync(
    path.join(f.home, "notion-memory.json"),
    JSON.stringify({ sourceArchive: true })
  )
  const result = await f.exec(["sync"])
  assert.equal(result.code, 0, result.stderr)
  const memories = f.pages().filter((p) => p.parent === "memory")
  assert.deepEqual(
    memories.map((p) => p.type),
    ["Profile", "Preference", "Preference", "Work"]
  )
  assert.ok(
    memories.every((p) => !String(p.content).includes("DO_NOT_IMPORT_LOG"))
  )
  assert.ok(
    memories.every(
      (p) => !String(p.content).includes("rollout_summaries/private-source.md")
    )
  )
  assert.match(
    String(memories.find((p) => p.title === "Inventory project")?.content),
    /Exact prices/
  )
  const archived = f
    .pages()
    .filter((p) => String(p.title).startsWith("Codex source:"))
  assert.ok(archived.length > 0)
  assert.ok(
    archived.every((p) => p.parent !== "memory" && p.parent !== "private")
  )
  assert.ok(
    memories.every((p) => String(p.content).includes("Source evidence:"))
  )
})

test("append and override update a stable topic; removing topics and an empty source retract active knowledge", async (t) => {
  const f = fixture(t)
  f.seed()
  assert.equal((await f.exec(["sync"])).code, 0)
  const pref = f.pages().find((p) => p.title === "Coding workflow preferences")
  assert.ok(pref)
  const summary = path.join(f.home, "memories/memory_summary.md")
  fs.writeFileSync(
    summary,
    fs
      .readFileSync(summary, "utf8")
      .replace(
        "## General Tips",
        "- Added synthetic preference for this test.\n\n## General Tips"
      )
  )
  let result = await f.exec(["sync"])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(f.pages().find((p) => p.id === pref.id)?.parent, "memory")
  assert.match(
    String(f.pages().find((p) => p.id === pref.id)?.content),
    /Added synthetic preference/
  )
  fs.writeFileSync(
    summary,
    fs.readFileSync(summary, "utf8").replace("TypeScript", "Rust")
  )
  result = await f.exec(["sync"])
  assert.equal(result.code, 0, result.stderr)
  assert.match(
    String(f.pages().find((p) => p.title === "Role and background")?.content),
    /Rust developer/
  )
  fs.writeFileSync(
    summary,
    fs
      .readFileSync(summary, "utf8")
      .replace(/## User preferences[\s\S]*?(?=## General Tips)/, "")
  )
  result = await f.exec(["sync"])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).noLongerInCodex, 1)
  assert.notEqual(f.pages().find((p) => p.id === pref.id)?.parent, "memory")
  assert.doesNotMatch(
    String(f.pages().find((p) => p.id === pref.id)?.content),
    /Added synthetic preference/
  )
  fs.writeFileSync(summary, "")
  fs.writeFileSync(path.join(f.home, "memories/MEMORY.md"), "")
  result = await f.exec(["sync"])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(f.pages().filter((p) => p.parent === "memory").length, 0)
  const calls = f.calls().length
  assert.equal((await f.exec(["sync"])).code, 0)
  assert.equal(
    f.calls().length,
    calls,
    "empty unchanged projections must not reconnect"
  )
})

test("archive append changes only the tail chunk; shrinking and deletion clear obsolete chunks", async (t) => {
  const f = fixture(t)
  f.seed()
  const dir = path.join(f.home, "memories/rollout_summaries")
  fs.mkdirSync(dir)
  const file = path.join(dir, "evidence.md")
  fs.writeFileSync(file, "X".repeat(8500))
  fs.writeFileSync(
    path.join(f.home, "notion-memory.json"),
    JSON.stringify({ sourceArchive: true })
  )
  let result = await f.exec(["sync"])
  assert.equal(result.code, 0, result.stderr)
  const chunks = () =>
    f
      .pages()
      .filter((p) => String(p.title).includes("rollout_summaries/evidence.md"))
  assert.equal(chunks().length, 3)
  const before = chunks().map((p) => String(p.content))
  fs.appendFileSync(file, "Y".repeat(200))
  result = await f.exec(["sync"])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).updated, 1)
  assert.equal(chunks()[0].content, before[0])
  assert.equal(chunks()[1].content, before[1])
  assert.notEqual(chunks()[2].content, before[2])
  fs.writeFileSync(file, "X".repeat(100))
  result = await f.exec(["sync"])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).noLongerInCodex, 2)
  assert.ok(
    chunks()
      .slice(1)
      .every((p) =>
        String(p.content).includes("no active memory or source text")
      )
  )
  fs.unlinkSync(file)
  result = await f.exec(["sync"])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).noLongerInCodex, 1)
  assert.ok(
    chunks().every((p) =>
      String(p.content).includes("no active memory or source text")
    )
  )
  const verify = await f.exec(["verify"])
  assert.equal(verify.code, 0, verify.stderr)
})

test("a missing source is a failure, not an instruction to erase all projected knowledge", async (t) => {
  const f = fixture(t)
  f.seed()
  assert.equal((await f.exec(["sync"])).code, 0)
  fs.rmSync(path.join(f.home, "memories"), { recursive: true })
  const result = await f.exec(["sync"])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /source files are missing/)
  assert.equal(f.pages().filter((p) => p.parent === "memory").length, 4)
})

test("legacy archive pages migrate using stored ownership hashes; a denied move aborts without a bypass", async (t) => {
  for (const failure of [undefined, "move-denied", "move-interrupted"]) {
    const f = fixture(t)
    f.seed()
    const memory = archiveMemories(memorySources(f.home))[0]
    const body = `${memory.content}\n\nFrom Codex memories (${memory.from}).`
    f.savePages([
      {
        id: "legacy-page",
        title: memory.title,
        type: "Notes",
        content: body,
        parent: "memory",
      },
    ])
    fs.mkdirSync(path.join(f.home, "notion-memory"))
    const hash = (s: string) =>
      crypto.createHash("sha1").update(s).digest("hex")
    fs.writeFileSync(
      path.join(f.home, "notion-memory/state.json"),
      JSON.stringify({
        memories: {
          [memory.key]: {
            pageId: "legacy-page",
            title: memory.title,
            type: "Notes",
            hash: hash(`${memory.title}\n${memory.content}`),
            pageHash: hash(`${memory.title}\nNotes\n${body}`),
          },
        },
      })
    )
    fs.writeFileSync(
      path.join(f.home, "notion-memory.json"),
      JSON.stringify({ sourceArchive: true })
    )
    const result = await f.exec(["sync"], { FIXTURE_FAILURE: failure })
    if (failure === "move-denied") {
      assert.equal(result.code, 1)
      assert.match(result.stderr, /move forbidden/)
      assert.equal(
        f.pages().find((p) => p.id === "legacy-page")?.parent,
        "memory"
      )
      assert.equal(f.pages().find((p) => p.id === "legacy-page")?.content, body)
    } else if (failure === "move-interrupted") {
      assert.equal(result.code, 1)
      assert.match(result.stderr, /interrupted after move/)
      assert.notEqual(
        f.pages().find((p) => p.id === "legacy-page")?.parent,
        "memory"
      )
      const resumed = await f.exec(["sync"])
      assert.equal(resumed.code, 0, resumed.stderr)
      assert.equal(JSON.parse(resumed.stdout).changedInNotion, 0)
      assert.equal((await f.exec(["verify"])).code, 0)
    } else {
      assert.equal(result.code, 0, result.stderr)
      assert.notEqual(
        f.pages().find((p) => p.id === "legacy-page")?.parent,
        "memory"
      )
      assert.ok(
        f
          .pages()
          .filter((p) => p.parent === "memory")
          .every((p) => !String(p.title).startsWith("Codex source:"))
      )
      assert.equal((await f.exec(["sync"])).code, 0)
    }
  }
})
