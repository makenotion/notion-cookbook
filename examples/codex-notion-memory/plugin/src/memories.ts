import crypto from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import fs from "node:fs"
import path from "node:path"
import {
  CODEX_HOME,
  loadConfig,
  loadState,
  log,
  saveState,
  sleep,
  withLock,
} from "./config.ts"
import { archiveMemories, memorySources } from "./archive.ts"
import type { CallTool } from "./mcp.ts"
import { parseCodexMemories } from "./knowledge.ts"
import { syncProjection } from "./reconcile.ts"

// Codex memories (`[features] memories = true`) are written by Codex itself, in the
// background: phase 1 extracts notes from idle sessions, phase 2 consolidates them into
// $CODEX_HOME/memories/memory_summary.md and MEMORY.md. This module turns those files into
// Notion memories and writes them with the same Notion MCP tools any agent uses, following
// the Notion memory guide (notion://docs/memory): one topic per memory, a topic title, a
// Type, details in the body, and no Source property.

export type MemoryType = "Profile" | "Preference" | "Work" | "Notes"

export interface CodexMemory {
  key: string
  type: MemoryType
  title: string
  content: string
  from: string
}

export interface MemorySyncResult {
  total: number
  created: number
  updated: number
  unchanged: number
  changedInNotion: number
  skippedExisting: number
  noLongerInCodex: number
}

const POLL_MS = 5000

export function memoriesDir(): string {
  const home = loadConfig().sourceHome || CODEX_HOME
  const v2 = path.join(home, "memories_v2")
  return path.join(
    home,
    loadState().knowledgeDir === v2 ||
      fs.existsSync(path.join(v2, "memory_summary.md"))
      ? "memories_v2"
      : "memories"
  )
}

export { parseCodexMemories } from "./knowledge.ts"

// Writes changed Codex memories to the user's Notion Memories through Notion MCP.
export async function syncMemories(
  callTool: CallTool
): Promise<MemorySyncResult> {
  const state = loadState()
  const config = loadConfig()
  const dir = memoriesDir()
  const files = ["memory_summary.md", "MEMORY.md"].filter((name) =>
    fs.existsSync(path.join(dir, name))
  )
  const hasSource = files.length > 0
  if (
    (!hasSource &&
      Object.keys(state.memories).some((key) => !key.startsWith("archive:"))) ||
    (state.knowledgeDir === dir &&
      state.knowledgeFiles?.some((name) => !files.includes(name)))
  )
    throw new Error(
      "Consolidated source files are missing; refusing to retract memories"
    )
  if (hasSource) state.userName ??= await userName(callTool)
  const result = await syncProjection(
    callTool,
    state,
    parseCodexMemories(dir, state.userName),
    config.sourceArchive
      ? archiveMemories(memorySources(config.sourceHome || CODEX_HOME))
      : undefined
  )
  if (hasSource) {
    state.knowledgeDir = dir
    state.knowledgeFiles = files
    saveState(state)
  }
  return result
}

// Codex has no hook for "memories updated", so a hook worker watches Codex's own job table
// and the memory files, and imports as soon as a consolidation run finishes.
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
      await withLock(() => syncMemories(callTool))
      lastHash = hash
    }
  }
}

async function userName(callTool: CallTool): Promise<string | undefined> {
  const self = (await callTool("get-self", {})) as
    | { user?: { name?: string } }
    | undefined
  return self?.user?.name?.split(/\s+/)[0] || undefined
}

async function memoryJobRunning(): Promise<boolean> {
  const home = loadConfig().sourceHome || CODEX_HOME
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
        memorySources(config.sourceHome || CODEX_HOME).map(
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

function sha1(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex")
}

function readIfExists(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
}
