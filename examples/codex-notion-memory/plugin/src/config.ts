import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export interface Config {
  // Codex executable used to start `codex app-server`.
  codexPath: string
  nodePath?: string
  // Name of the Notion MCP server in Codex. Detected automatically when unset.
  mcpServer?: string
  sourceHome?: string
  expectedWorkspaceId?: string
  // Notion MCP endpoint the plugin signs in to directly in Claude Code.
  mcpUrl: string
}

export interface State {
  files: Record<
    string,
    {
      hash: string
      pageId: string
      pageHash: string
      released?: boolean
    }
  >
}

export type Agent = "codex" | "claude"

// The same plugin directory installs into Codex and Claude Code. Each agent's hooks set
// NOTION_MEMORY_AGENT, and config, state, and logs live in that agent's home directory.
export const AGENT: Agent =
  process.env.NOTION_MEMORY_AGENT === "claude" ? "claude" : "codex"
export const AGENT_HOME =
  AGENT === "claude"
    ? process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")
    : process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
export const CONFIG_FILE =
  process.env.NOTION_MEMORY_CONFIG ||
  path.join(AGENT_HOME, "notion-memory.json")
// Not $PLUGIN_DATA: hooks and manual commands from the skill must share one state file.
export const DATA_DIR =
  process.env.NOTION_MEMORY_DATA || path.join(AGENT_HOME, "notion-memory")
export const LOG_FILE = path.join(DATA_DIR, "notion-memory.log")
const STATE_FILE = path.join(DATA_DIR, "state.json")
const LOCK_DIR = path.join(DATA_DIR, "lock")
const STALE_LOCK_MS = 120_000

export function loadConfig(): Config {
  let file: Partial<Config> = {}
  if (fs.existsSync(CONFIG_FILE))
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"))
  return {
    codexPath: process.env.CODEX_PATH || file.codexPath || "codex",
    nodePath: file.nodePath,
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

// Cross-process lock. Workers from back-to-back hooks can overlap, and two imports
// running at once would create the same memory twice.
export async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  for (let attempt = 0; ; attempt++) {
    try {
      fs.mkdirSync(LOCK_DIR)
      break
    } catch {
      if (lockIsStale()) fs.rmSync(LOCK_DIR, { recursive: true, force: true })
      if (attempt > 600) throw new Error(`could not acquire ${LOCK_DIR}`)
      await sleep(200)
    }
  }
  const heartbeat = setInterval(() => {
    const now = new Date()
    fs.utimesSync(LOCK_DIR, now, now)
  }, 30_000)
  try {
    return await fn()
  } finally {
    clearInterval(heartbeat)
    fs.rmSync(LOCK_DIR, { recursive: true, force: true })
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function lockIsStale(): boolean {
  try {
    return Date.now() - fs.statSync(LOCK_DIR).mtimeMs > STALE_LOCK_MS
  } catch {
    return false
  }
}
