import fs from "node:fs"
import path from "node:path"
import { AGENT_HOME, loadConfig } from "./config.ts"
import {
  type MemoryInventory,
  type MemorySource,
  readSourceFile,
} from "./memories.ts"

// Codex memories (`[features] memories = true`) are written by Codex itself, in the
// background, into $CODEX_HOME/memories_v2/: memory_summary.md plus nested Markdown such as
// rollout_summaries/ and extensions/. Each file becomes one Notes page titled by its path.

export const codexSource: MemorySource = {
  name: "Codex",
  root: "memories_v2",
  inventory: codexMemoryInventory,
}

export function memoriesDir(): string {
  return path.join(loadConfig().sourceHome || AGENT_HOME, "memories_v2")
}

export function codexMemoryInventory(): MemoryInventory {
  const dir = memoriesDir()
  if (!fs.existsSync(dir))
    throw new Error(`Memory directory does not exist: ${dir}`)
  const names: string[] = []
  const unsupported: string[] = []
  function visit(relative: string) {
    for (const entry of fs.readdirSync(path.join(dir, relative), {
      withFileTypes: true,
    })) {
      if (entry.name === ".git") continue
      const name = path.posix.join(relative, entry.name)
      if (entry.isDirectory()) visit(name)
      else if (entry.isFile() && entry.name.endsWith(".md")) names.push(name)
      else unsupported.push(name)
    }
  }
  visit("")
  const files = names.sort().map((name) => ({
    ...readSourceFile(dir, name),
    title: name,
    type: "Notes" as const,
  }))
  return { files, unsupported: unsupported.sort() }
}
