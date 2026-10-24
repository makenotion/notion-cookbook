import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { CallTool } from "./mcp.ts"
import type { State } from "./config.ts"
import type { AgentMemory } from "./memories.ts"

export interface MemorySource {
  path: string
  text: string
  sha256: string
}

// Explicit archive mode includes retained extraction results, not session transcripts.
// Git internals, operational job state, temporary files and symlinks are excluded.
export function memorySources(home: string): MemorySource[] {
  const sources: MemorySource[] = []
  for (const name of ["memories", "memories_v2"]) {
    const root = path.join(home, name)
    if (fs.existsSync(root)) collectMarkdown(home, root, sources)
    const dbPath = path.join(home, `${name}_1.sqlite`)
    if (!fs.existsSync(dbPath)) continue
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const rows = db
        .prepare(
          "SELECT thread_id, raw_memory, rollout_summary, rollout_slug FROM stage1_outputs ORDER BY thread_id"
        )
        .all()
      for (const row of rows) {
        if (typeof row.thread_id !== "string")
          throw new Error("invalid memory thread ID")
        sources.push(
          source(
            `${name}_1.sqlite/stage1_outputs/${row.thread_id}.json`,
            JSON.stringify(row, null, 2)
          )
        )
      }
    } finally {
      db.close()
    }
  }
  return sources.sort((a, b) => a.path.localeCompare(b.path))
}

export function archiveMemories(sources: MemorySource[]): AgentMemory[] {
  return sources.flatMap((entry) => {
    // Count Unicode code points so chunk boundaries never split a surrogate pair.
    const chars = Array.from(entry.text)
    const count = Math.max(1, Math.ceil(chars.length / 4000))
    return Array.from({ length: count }, (_, index) => {
      const part = index + 1
      const text = JSON.stringify(
        chars.slice(index * 4000, part * 4000).join("")
      ).replace(
        /[`<>{}\[\]]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
      )
      const payload = JSON.stringify(
        {
          source: entry.path,
          part,
          sha256: crypto
            .createHash("sha256")
            .update(chars.slice(index * 4000, part * 4000).join(""))
            .digest("hex"),
        },
        null,
        2
      ).replace(/\n}$/, `,\n  "text": ${text}\n}`)
      return {
        key: `archive:${entry.path}:${part}`,
        type: "Notes",
        title: `Codex source: ${entry.path} [${part}]`,
        content: `Codex source archive, part ${part}. The JSON text field preserves the original text.\n\n\`\`\`json\n${payload}\n\`\`\``,
        from: entry.path,
      }
    })
  })
}

function collectMarkdown(
  home: string,
  dir: string,
  sources: MemorySource[]
): void {
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) collectMarkdown(home, file, sources)
    else if (entry.isFile() && entry.name.endsWith(".md")) {
      const bytes = fs.readFileSync(file)
      const text = bytes.toString("utf8")
      if (!Buffer.from(text, "utf8").equals(bytes))
        throw new Error(
          `memory source is not UTF-8: ${path.relative(home, file)}`
        )
      sources.push(source(path.relative(home, file), text))
    }
  }
}

function source(file: string, text: string): MemorySource {
  return {
    path: file,
    text,
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
  }
}

export async function verifyArchive(
  callTool: CallTool,
  sources: MemorySource[],
  state: State
): Promise<{ sources: number; pages: number; verified: number }> {
  const memories = archiveMemories(sources)
  let verified = 0
  for (let i = 0; i < memories.length; i += 6) {
    await Promise.all(
      memories.slice(i, i + 6).map(async (memory) => {
        const entry = (state.archives ?? state.memories)[memory.key]
        if (!entry || entry.released)
          throw new Error(`unmanaged source page: ${memory.key}`)
        const fetched = await callTool("fetch", { id: entry.pageId })
        if (
          !fetched ||
          typeof fetched !== "object" ||
          !("text" in fetched) ||
          typeof fetched.text !== "string"
        )
          throw new Error(`invalid readback: ${memory.key}`)
        const actual = fetched.text.match(/```json\n([\s\S]*?)\n```/)?.[1]
        const expected = memory.content.match(/```json\n([\s\S]*?)\n```/)?.[1]
        let matches = false
        if (actual && expected) {
          try {
            matches =
              JSON.stringify(JSON.parse(actual)) ===
              JSON.stringify(JSON.parse(expected))
          } catch {
            // Parse errors can quote private source text; replace them with a path-only error.
          }
        }
        if (!matches) throw new Error(`source readback mismatch: ${memory.key}`)
        verified++
      })
    )
  }
  return { sources: sources.length, pages: memories.length, verified }
}
