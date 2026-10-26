import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { AGENT_HOME, loadConfig, sleep, withLock } from "./config.ts"
import type { CallTool } from "./mcp.ts"
import {
  digest,
  type MemoryFile,
  memoryFilesHash,
  type MemorySource,
  syncMemories,
} from "./memories.ts"

// Codex memories (`[features] memories = true`) are written by Codex itself, in the
// background, into $CODEX_HOME/memories_v2/memory_summary.md and MEMORY.md. Each file
// becomes one Notes page.

export const codexSource: MemorySource = {
  name: "Codex",
  files: codexMemoryFiles,
}

export function memoriesDir(): string {
  return path.join(loadConfig().sourceHome || AGENT_HOME, "memories_v2")
}

export function codexMemoryFiles(): MemoryFile[] {
  const dir = memoriesDir()
  if (!fs.existsSync(path.join(dir, "memory_summary.md")))
    throw new Error("Codex v2 memory_summary.md is not ready")
  return ["memory_summary.md", "MEMORY.md"]
    .filter((name) => fs.existsSync(path.join(dir, name)))
    .map((name) => {
      const content = fs.readFileSync(path.join(dir, name), "utf8")
      return {
        key: name,
        title: name,
        type: "Notes",
        content,
        hash: digest(content),
      }
    })
}

export async function watchMemories(
  call: CallTool,
  opts: { maxMs: number; initialHash: string }
) {
  const started = Date.now()
  let previous = opts.initialHash
  while (Date.now() - started < opts.maxMs) {
    await sleep(5000)
    if (memoryJobRunning()) continue
    const hash = memoryFilesHash(codexSource)
    if (hash !== previous) {
      await withLock(() => syncMemories(call, codexSource))
      previous = hash
    }
  }
}

function memoryJobRunning(): boolean {
  const file = path.join(
    loadConfig().sourceHome || AGENT_HOME,
    "memories_v2_1.sqlite"
  )
  if (!fs.existsSync(file)) return false
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return (
      db.prepare("SELECT 1 FROM jobs WHERE status = 'running' LIMIT 1").all()
        .length > 0
    )
  } finally {
    db.close()
  }
}
