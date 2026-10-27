import fs from "node:fs"
import path from "node:path"
import { AGENT_HOME, loadConfig, sleep, withLock } from "./config.ts"
import type { CallTool } from "./mcp.ts"
import {
  type MemoryInventory,
  memoryFilesHash,
  type MemorySource,
  readSourceFile,
  syncMemories,
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

// Syncs once the files hold still for one poll, so a consolidation that is still
// writing is not imported half-way.
export async function watchMemories(
  call: CallTool,
  opts: { initialHash: string; until: () => number }
) {
  let previous: string | undefined
  let candidate: string | undefined = opts.initialHash
  while (Date.now() < opts.until()) {
    await sleep(5000)
    if (Date.now() >= opts.until()) break
    const hash = memoryFilesHash(codexSource)
    if (hash === previous) {
      candidate = undefined
    } else if (hash === candidate) {
      await withLock(() => syncMemories(call, codexSource))
      previous = hash
      candidate = undefined
    } else {
      candidate = hash
    }
  }
}
