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
      expectedPageHash: string
    }

export interface State {
  // The workspace whose page IDs this mapping holds.
  workspaceId: string
  pending?: Record<string, PendingWrite>
  files: Record<
    string,
    {
      hash: string
      metadataHash: string
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
const WORKSPACE_ID = /^[A-Za-z0-9-]+$/

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

// Page IDs belong to one workspace, so each pinned workspace keeps its own
// mapping. Switching back to a workspace reuses its mapping instead of creating
// duplicate pages.
export function stateFile(workspaceId: string): string {
  if (!WORKSPACE_ID.test(workspaceId))
    throw new Error(`Invalid workspace ID: ${workspaceId}`)
  return path.join(DATA_DIR, workspaceId, "state.json")
}

export function pinnedWorkspace(): string {
  const workspaceId = loadConfig().expectedWorkspaceId?.trim()
  if (!workspaceId)
    throw new Error(
      "Set expectedWorkspaceId in the approved config before using the mapping. Run use-workspace to confirm the destination workspace."
    )
  return workspaceId
}

export function hasState(workspaceId: string): boolean {
  return fs.existsSync(stateFile(workspaceId))
}

export function loadState(workspaceId = pinnedWorkspace()): State {
  const file = stateFile(workspaceId)
  if (!fs.existsSync(file)) return { workspaceId, files: {} }
  const state = JSON.parse(fs.readFileSync(file, "utf8"))
  if (state.workspaceId !== workspaceId)
    throw new Error(
      `Mapping ${file} belongs to workspace ${state.workspaceId}, not ${workspaceId}`
    )
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
            typeof entry.expectedPageHash !== "string"))
      )
        throw new Error(
          "Invalid pending write journal; preserve state.json for reconciliation"
        )
    }
  }
  return state
}

export function saveState(state: State): void {
  const file = stateFile(state.workspaceId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2))
  fs.renameSync(`${file}.tmp`, file)
}

// Rewrites only the pin, keeping every other approved setting in the file.
export function pinWorkspace(workspaceId: string): void {
  stateFile(workspaceId)
  const file: Record<string, unknown> = fs.existsSync(CONFIG_FILE)
    ? JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"))
    : {}
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  fs.writeFileSync(
    `${CONFIG_FILE}.tmp`,
    JSON.stringify({ ...file, expectedWorkspaceId: workspaceId }, null, 2) +
      "\n"
  )
  fs.renameSync(`${CONFIG_FILE}.tmp`, CONFIG_FILE)
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
