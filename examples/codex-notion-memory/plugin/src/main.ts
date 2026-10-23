// Entry point for the Codex hooks and for manual commands.
//
//   node src/main.ts hook <session-start|stop>   called by Codex (reads hook JSON on stdin)
//   node src/main.ts sync                        import Codex memories now
//   node src/main.ts preview [--dir <path>]      offline: print the memories it would write
//   node src/main.ts status                      memories the plugin manages
import { spawn } from "node:child_process"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import {
  type Config,
  DATA_DIR,
  LOG_FILE,
  loadConfig,
  loadState,
  log,
  withLock,
} from "./config.ts"
import { CodexNotionMcp } from "./mcp.ts"
import {
  memoriesDir,
  parseCodexMemories,
  syncMemories,
  watchMemories,
} from "./memories.ts"

interface HookInput {
  session_id?: string
  cwd?: string
}

const MAIN = fileURLToPath(import.meta.url)
// Codex starts its memory pipeline when a session starts and again after turns, so the
// plugin watches after both hooks. Without a running job inside `startWindowMs`, the
// watcher gives up early.
const WATCH = {
  "session-start": { startWindowMs: 120_000, maxMs: 600_000 },
  stop: { startWindowMs: 15_000, maxMs: 300_000 },
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  const config = loadConfig()
  const option = (name: string) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }

  switch (command) {
    case "hook":
      return handleHook(args[0])
    case "worker": {
      const event = args[0] === "stop" ? "stop" : "session-start"
      return withNotion(config, option("--cwd"), async (mcp) => {
        await withLock(() => syncMemories(mcp.callTool))
        await watchMemories(mcp.callTool, WATCH[event])
      })
    }
    case "sync":
      return withNotion(config, undefined, async (mcp) => {
        const result = await withLock(() => syncMemories(mcp.callTool))
        console.log(JSON.stringify(result))
      })
    case "preview": {
      const name = loadState().userName
      const memories = parseCodexMemories(
        option("--dir") ?? memoriesDir(),
        name
      )
      console.log(JSON.stringify(memories, null, 2))
      return
    }
    case "status":
      console.log(JSON.stringify(loadState(), null, 2))
      return
    default:
      console.log(
        "usage: node src/main.ts sync | preview [--dir <path>] | status"
      )
  }
}

// Hooks have a short timeout and block Codex while they run, so hand the work to a
// detached worker process and return immediately. The worker logs to LOG_FILE.
function handleHook(event: string | undefined): void {
  // The worker's own `codex app-server` can start sessions too. Never recurse.
  if (process.env.NOTION_MEMORY_WORKER) return
  let input: HookInput = {}
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8") || "{}")
  } catch (e) {
    log(
      `hook ${event}: could not read hook input:`,
      e instanceof Error ? e.message : String(e)
    )
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const out = fs.openSync(LOG_FILE, "a")
  // The watcher reads Codex's job table with node:sqlite, which warns on Node 22.
  const args = [
    "--disable-warning=ExperimentalWarning",
    MAIN,
    "worker",
    event ?? "session-start",
    "--cwd",
    input.cwd || process.cwd(),
  ]
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, NOTION_MEMORY_WORKER: "1" },
  })
  child.unref()
  log(`hook ${event}: session=${input.session_id} -> worker pid ${child.pid}`)
}

// Connects to the Notion MCP server that Codex is already signed in to.
async function withNotion(
  config: Config,
  cwd: string | undefined,
  fn: (mcp: CodexNotionMcp) => Promise<void>
): Promise<void> {
  const mcp = await CodexNotionMcp.connect({
    codexPath: config.codexPath,
    cwd: cwd || process.cwd(),
    server: config.mcpServer,
  })
  try {
    await fn(mcp)
  } finally {
    mcp.close()
  }
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? (e.stack ?? e.message) : String(e)
  log("error:", message)
  // A failing hook must never break the user's Codex session.
  if (process.argv[2] === "hook") return
  console.error(e instanceof Error ? e.message : message)
  process.exitCode = 1
})
