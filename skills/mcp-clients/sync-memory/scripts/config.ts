import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { withOwnership } from "./ownership.ts"

export interface Config {
  // Codex executable used to start `codex app-server`.
  codexPath: string
  // Name of the Notion MCP server in Codex. Detected automatically when unset.
  mcpServer?: string
  sourceHome?: string
  expectedWorkspaceId?: string
  // Notion MCP endpoint the plugin signs in to directly in Claude Code.
  mcpUrl: string
}

export type PendingWrite =
  | {
      phase: "unknown"
      operation: "create" | "update"
      hash: string
      metadataHash: string
      pageId?: string
    }
  | {
      phase: "readback"
      operation: "create" | "update"
      hash: string
      metadataHash: string
      pageId: string
      expectedPageHash?: string
    }

export interface State {
  pending?: Record<string, PendingWrite>
  files: Record<
    string,
    {
      hash: string
      metadataHash?: string
      pageId: string
      pageHash: string
      released?: boolean
    }
  >
}

export type Agent = "codex" | "claude"

// The same plugin directory installs into Codex and Claude Code. Claude Code commands set
// NOTION_MEMORY_AGENT=claude, and config, state, and logs live in that agent's home directory.
export const AGENT: Agent =
  process.env.NOTION_MEMORY_AGENT === "claude" ? "claude" : "codex"
export const AGENT_HOME =
  AGENT === "claude"
    ? process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")
    : process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
export const CONFIG_FILE =
  process.env.NOTION_MEMORY_CONFIG ||
  path.join(AGENT_HOME, "notion-memory.json")
// Keep the mapping namespace stable across plugin upgrades and explicit runs.
export const DATA_DIR =
  process.env.NOTION_MEMORY_DATA || path.join(AGENT_HOME, "notion-memory")
export const LOG_FILE = path.join(DATA_DIR, "notion-memory.log")
const STATE_FILE = path.join(DATA_DIR, "state.json")

export function loadConfig(): Config {
  let file: Partial<Config> = {}
  if (fs.existsSync(CONFIG_FILE))
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"))
  return {
    codexPath: process.env.CODEX_PATH || file.codexPath || "codex",
    mcpServer: process.env.NOTION_MCP_SERVER || file.mcpServer,
    sourceHome: file.sourceHome,
    expectedWorkspaceId: file.expectedWorkspaceId,
    mcpUrl:
      process.env.NOTION_MCP_URL || file.mcpUrl || "https://mcp.notion.com/mcp",
  }
}

export function loadState(): State {
  if (!fs.existsSync(STATE_FILE)) return { files: {} }
  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
  if (
    !state.files ||
    typeof state.files !== "object" ||
    Array.isArray(state.files)
  )
    throw new Error("Invalid file mapping state; use a fresh state.json")
  if (state.pending !== undefined) {
    if (
      !state.pending ||
      typeof state.pending !== "object" ||
      Array.isArray(state.pending)
    )
      throw new Error(
        "Invalid pending write journal; preserve state.json for reconciliation"
      )
    for (const value of Object.values(state.pending)) {
      const entry = value as Partial<PendingWrite> | null
      if (
        !entry ||
        (entry.phase !== "unknown" && entry.phase !== "readback") ||
        (entry.operation !== "create" && entry.operation !== "update") ||
        typeof entry.hash !== "string" ||
        typeof entry.metadataHash !== "string" ||
        (entry.pageId !== undefined &&
          (typeof entry.pageId !== "string" || !entry.pageId)) ||
        (entry.operation === "update" && typeof entry.pageId !== "string") ||
        (entry.phase === "readback" &&
          (typeof entry.pageId !== "string" ||
            (entry.expectedPageHash !== undefined &&
              typeof entry.expectedPageHash !== "string")))
      )
        throw new Error(
          "Invalid pending write journal; preserve state.json for reconciliation"
        )
    }
  }
  return state
}

export function saveState(state: State): void {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(state, null, 2))
  fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE)
}

export function log(...parts: unknown[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const text = parts
    .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ")
  const line = `[${new Date().toISOString()}] ${text}\n`
  fs.appendFileSync(LOG_FILE, line)
  if (process.env.NOTION_SYNC_VERBOSE) process.stderr.write(line)
}

export async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  return withOwnership(DATA_DIR, fn)
}
