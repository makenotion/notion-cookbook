// Mirrors Codex memories into Notion Memories. Entry point for the hooks and manual commands.
//
//   node src/main.ts hook <session-start|stop>   called by Codex hooks
//   node src/main.ts sync                        write Codex memories now
//   node src/main.ts preview [--dir <path>]      offline: what it would write
//   node src/main.ts status                      memories it manages
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  CODEX_HOME,
  type Config,
  DATA_DIR,
  LOG_FILE,
  loadConfig,
  loadState,
  log,
  withLock,
} from "./config.ts"
import { archiveMemories, memorySources, verifyArchive } from "./archive.ts"
import { type CallTool, CodexNotionMcp } from "./mcp.ts"
import {
  memoryFilesHash,
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
// plugin watches for the full bounded window after both hooks.
const WATCH = {
  "session-start": { maxMs: 600_000 },
  stop: { maxMs: 300_000 },
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
      const cwd = option("--cwd") || process.cwd()
      if (!(await CodexNotionMcp.memoriesEnabled(config.codexPath, cwd))) {
        log(
          "memories: automatic sync skipped because Codex memories are disabled"
        )
        return
      }
      return withNotion(config, option("--cwd"), async (callTool) => {
        const initialHash = memoryFilesHash()
        await withLock(() => syncMemories(callTool))
        await watchMemories(callTool, { ...WATCH[event], initialHash })
      })
    }
    case "sync":
      return withNotion(config, undefined, async (callTool) => {
        const result = await withLock(() => syncMemories(callTool))
        console.log(JSON.stringify(result))
      })
    case "verify": {
      if (!config.sourceArchive)
        throw new Error("verify requires sourceArchive mode")
      return withNotion(config, undefined, async (callTool) => {
        const result = await withLock(() =>
          verifyArchive(
            callTool,
            memorySources(config.sourceHome || CODEX_HOME),
            loadState()
          )
        )
        console.log(JSON.stringify(result))
      })
    }
    case "inventory": {
      const sources = memorySources(config.sourceHome || CODEX_HOME)
      console.log(
        JSON.stringify(
          {
            sources: sources.map(({ path, sha256, text }) => ({
              path,
              sha256,
              bytes: Buffer.byteLength(text),
            })),
            pages: archiveMemories(sources).length,
          },
          null,
          2
        )
      )
      return
    }
    case "preview": {
      const name = loadState().userName
      const knowledge = parseCodexMemories(
        option("--dir") ?? memoriesDir(),
        name
      )
      const preview = config.sourceArchive
        ? {
            knowledge,
            archive: {
              sources: memorySources(config.sourceHome || CODEX_HOME).length,
              pages: archiveMemories(
                memorySources(config.sourceHome || CODEX_HOME)
              ).length,
            },
          }
        : knowledge
      console.log(JSON.stringify(preview, null, 2))
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
  // No Codex memory files exist yet, so do not start a worker.
  if (
    !fs.existsSync(path.join(CODEX_HOME, "memories_1.sqlite")) &&
    !fs.existsSync(memoriesDir())
  )
    return
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

// Connects to the Notion server that Codex is already signed in to. The connection starts
// on the first tool call, so a worker that finds nothing new never starts `codex app-server`.
async function withNotion(
  config: Config,
  cwd: string | undefined,
  fn: (callTool: CallTool) => Promise<void>
): Promise<void> {
  let connection: Promise<CodexNotionMcp> | undefined
  const callTool: CallTool = async (tool, args) => {
    connection ??= CodexNotionMcp.connect({
      codexPath: config.codexPath,
      cwd: cwd || process.cwd(),
      server: config.mcpServer,
      expectedWorkspaceId: config.expectedWorkspaceId,
    })
    return (await connection).callTool(tool, args)
  }
  try {
    await fn(callTool)
  } finally {
    if (connection) (await connection.catch(() => undefined))?.close()
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
