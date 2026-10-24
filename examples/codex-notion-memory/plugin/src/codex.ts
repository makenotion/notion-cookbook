import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { archiveMemories, memorySources } from "./archive.ts"
import {
  AGENT_HOME,
  loadConfig,
  loadState,
  log,
  sleep,
  withLock,
} from "./config.ts"
import type { CallTool } from "./mcp.ts"
import { parseCodexMemories } from "./knowledge.ts"
import {
  type MemorySource,
  readIfExists,
  sha1,
  syncMemories,
} from "./memories.ts"

// Codex memories (`[features] memories = true`) are written by Codex itself, in the
// background: phase 1 extracts notes from idle sessions, phase 2 consolidates them into
// $CODEX_HOME/memories/memory_summary.md and MEMORY.md. This module turns those files into
// one memory per topic (knowledge.ts). Explicit `sourceArchive` mode also backs up every
// retained source under a separate private archive (archive.ts).

const POLL_MS = 5000

export const codexSource: MemorySource = {
  name: "Codex",
  dir: memoriesDir,
  sourceFiles: (dir) =>
    ["memory_summary.md", "MEMORY.md"].filter((name) =>
      fs.existsSync(path.join(dir, name))
    ),
  parse: parseCodexMemories,
  archive: () => {
    const config = loadConfig()
    return config.sourceArchive
      ? archiveMemories(memorySources(config.sourceHome || AGENT_HOME))
      : undefined
  },
}

export function memoriesDir(): string {
  const home = loadConfig().sourceHome || AGENT_HOME
  const v2 = path.join(home, "memories_v2")
  // Stay on memories_v2 once synced from it, so a missing summary there fails the
  // missing-source guard instead of silently switching directories.
  return path.join(
    home,
    loadState().knowledgeDir === v2 ||
      fs.existsSync(path.join(v2, "memory_summary.md"))
      ? "memories_v2"
      : "memories"
  )
}

export async function watchMemories(
  callTool: CallTool,
  opts: { maxMs: number; initialHash?: string }
): Promise<void> {
  const started = Date.now()
  let lastHash = opts.initialHash ?? memoryFilesHash()
  while (Date.now() - started < opts.maxMs) {
    await sleep(POLL_MS)
    const running = await memoryJobRunning()
    const hash = memoryFilesHash()
    if (hash !== lastHash && !running) {
      log("memories: Codex updated its memory files, importing")
      await withLock(() => syncMemories(callTool, codexSource))
      lastHash = hash
    }
  }
}

async function memoryJobRunning(): Promise<boolean> {
  const home = loadConfig().sourceHome || AGENT_HOME
  return ["memories_1.sqlite", "memories_v2_1.sqlite"].some((name) =>
    jobRunning(path.join(home, name))
  )
}

function jobRunning(db: string): boolean {
  if (!fs.existsSync(db)) return false
  try {
    const conn = new DatabaseSync(db, { readOnly: true })
    try {
      return (
        conn
          .prepare("SELECT 1 FROM jobs WHERE status = 'running' LIMIT 1")
          .all().length > 0
      )
    } finally {
      conn.close()
    }
  } catch (e) {
    log(
      "memories: job table unavailable:",
      e instanceof Error ? e.message : String(e)
    )
    return false
  }
}

export function memoryFilesHash(): string {
  const config = loadConfig()
  if (config.sourceArchive)
    return sha1(
      JSON.stringify(
        memorySources(config.sourceHome || AGENT_HOME).map(
          ({ path, sha256 }) => [path, sha256]
        )
      )
    )
  return sha1(
    ["MEMORY.md", "memory_summary.md"]
      .map((f) => readIfExists(path.join(memoriesDir(), f)))
      .join("\0")
  )
}
