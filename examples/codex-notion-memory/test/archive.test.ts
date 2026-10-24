import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { archiveMemories, memorySources } from "../plugin/src/archive.ts"

test("archive covers both generations, extensions and database memories without altering source bytes", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memory-archive-"))
  try {
    for (const name of ["memories", "memories_v2"]) {
      fs.mkdirSync(path.join(home, name, "extensions"), { recursive: true })
      fs.writeFileSync(
        path.join(home, name, "memory_summary.md"),
        "# Entire summary\n\n中文 ``` </content>\n".repeat(900)
      )
      fs.writeFileSync(
        path.join(home, name, "extensions/note.md"),
        "A complete extension\n"
      )
      fs.mkdirSync(path.join(home, name, ".git"))
      fs.writeFileSync(
        path.join(home, name, ".git/private.md"),
        "exclude metadata"
      )
      fs.symlinkSync(
        path.join(home, name, "memory_summary.md"),
        path.join(home, name, "symlink.md")
      )
      const db = new DatabaseSync(path.join(home, `${name}_1.sqlite`))
      db.exec(
        "CREATE TABLE stage1_outputs (thread_id TEXT, raw_memory TEXT, rollout_summary TEXT, rollout_slug TEXT)"
      )
      db.prepare("INSERT INTO stage1_outputs VALUES (?,?,?,?)").run(
        "example",
        "raw retained memory",
        "complete rollout",
        "example"
      )
      db.close()
    }
    const sources = memorySources(home)
    assert.equal(sources.length, 6)
    const memories = archiveMemories(sources)
    for (const source of sources) {
      const parts = memories
        .filter((m) => m.from === source.path)
        .map((m) =>
          JSON.parse(m.content.split("```json\n")[1].split("\n```")[0])
        )
      assert.equal(parts.map((p) => p.text).join(""), source.text)
      assert.ok(
        parts.every(
          (p) =>
            p.sha256 ===
            crypto.createHash("sha256").update(p.text).digest("hex")
        )
      )
    }
    assert.deepEqual(memorySources(home), sources)
    assert.ok(memories.every((m) => m.content.length < 30_000))
    fs.writeFileSync(
      path.join(home, "memories_v2/invalid.md"),
      Buffer.from([255])
    )
    assert.throws(() => memorySources(home), /not UTF-8/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
