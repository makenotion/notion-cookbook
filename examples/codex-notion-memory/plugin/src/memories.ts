import crypto from "node:crypto"
import fs from "node:fs"
import { loadState, saveState } from "./config.ts"
import type { CallTool } from "./mcp.ts"
import { syncProjection } from "./reconcile.ts"

// Writes an agent's memories to the user's Notion Memories with the same Notion MCP tools
// any agent uses, following the Notion memory guide (notion://docs/memory): one topic per
// memory, a topic title, a Type, the agent as Source and Last updated by, and details in
// the body. Each agent has a MemorySource that parses its own memory files (codex.ts,
// claude.ts); reconcile.ts writes them.

export type MemoryType = "Profile" | "Preference" | "Work" | "Notes"

export interface AgentMemory {
  key: string
  type: MemoryType
  title: string
  content: string
  from: string
}

export interface MemorySource {
  // Agent name, used in page text and the revision title.
  name: "Codex" | "Claude Code"
  // Read on every sync, because the agent's memory location can change between syncs.
  dir(): string
  // The source files present in `dir` whose disappearance means the source is unreadable
  // rather than emptied. When none exist, or one seen on the last sync is gone, the plugin
  // refuses to retract memories it wrote earlier.
  sourceFiles(dir: string): string[]
  // Pure: reads the memory files in `dir` and returns one memory per topic.
  parse(dir: string, userName?: string): AgentMemory[]
  // Retained sources to back up under a separate private archive, when enabled.
  archive(): AgentMemory[] | undefined
}

export interface MemorySyncResult {
  total: number
  created: number
  updated: number
  unchanged: number
  changedInNotion: number
  skippedExisting: number
  noLongerInAgent: number
}

// Writes changed agent memories to the user's Notion Memories through Notion MCP.
export async function syncMemories(
  callTool: CallTool,
  source: MemorySource
): Promise<MemorySyncResult> {
  const state = loadState()
  const dir = source.dir()
  const files = source.sourceFiles(dir)
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
    source.name,
    source.parse(dir, state.userName),
    source.archive()
  )
  if (hasSource) {
    state.knowledgeDir = dir
    state.knowledgeFiles = files
    saveState(state)
  }
  return result
}

async function userName(callTool: CallTool): Promise<string | undefined> {
  const self = (await callTool("get-self", {})) as
    | { user?: { name?: string } }
    | undefined
  return self?.user?.name?.split(/\s+/)[0] || undefined
}

// The Notion memory guide asks for the user's name instead of "the user".
export function personalize(text: string, name: string | undefined): string {
  if (!name) return text
  return text
    .replace(/\b([Tt])he user's\b/g, `${name}'s`)
    .replace(/\b[Tt]he user\b/g, name)
}

export function readIfExists(file: string): string {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

export function sha1(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex")
}
