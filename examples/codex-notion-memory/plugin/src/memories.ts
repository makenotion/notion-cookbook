import crypto from "node:crypto"
import fs from "node:fs"
import { loadState } from "./config.ts"
import type { CallTool } from "./mcp.ts"
import { syncProjection } from "./reconcile.ts"

// Writes an agent's memories to the user's Notion Memories with the same Notion MCP tools
// any agent uses, following the Notion memory guide (notion://docs/memory): one topic per
// memory, a topic title, a Type, details in the body, and no Source property. Each agent
// has a MemorySource that parses its own memory files (codex.ts, claude.ts);
// reconcile.ts writes them.

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
  // Whether the agent's memory files exist. When they are missing the plugin refuses to
  // retract memories it wrote earlier, since a moved or unreadable directory is not a removal.
  hasSource(dir: string): boolean
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
  const hasSource = source.hasSource(dir)
  if (
    !hasSource &&
    Object.keys(state.memories).some((key) => !key.startsWith("archive:"))
  )
    throw new Error(
      "Consolidated source files are missing; refusing to retract memories"
    )
  if (hasSource) state.userName ??= await userName(callTool)
  return syncProjection(
    callTool,
    state,
    source.name,
    source.parse(dir, state.userName),
    source.archive()
  )
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
