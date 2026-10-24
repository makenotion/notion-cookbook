// Entry point for the Codex and Claude Code hooks and for manual commands. Set
// NOTION_MEMORY_AGENT=claude to work on Claude Code memories instead of Codex's.
//
//   node src/main.ts hook <event>                called by the agent (reads hook JSON on stdin)
//   node src/main.ts login                       Claude Code only: sign in to Notion MCP
//   node src/main.ts sync                        import the agent's memories now
//   node src/main.ts preview [--dir <path>]      offline: print the memories it would write
//   node src/main.ts inventory | verify          Codex sourceArchive mode only
//   node src/main.ts status                      memories the plugin manages
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  claudeMemoriesEnabled,
  claudeSource,
  isClaudeMemoryFile,
} from "./claude.ts"
import { archiveMemories, memorySources, verifyArchive } from "./archive.ts"
import { codexSource, memoryFilesHash, watchMemories } from "./codex.ts"
import {
  AGENT,
  AGENT_HOME,
  type Config,
  DATA_DIR,
  LOG_FILE,
  loadConfig,
  loadState,
  log,
  withLock,
} from "./config.ts"
import { type CallTool, CodexNotionMcp } from "./mcp.ts"
import { syncMemories } from "./memories.ts"
import { login, NotionMcpHttp, openBrowser, TOKEN_FILE } from "./notionMcp.ts"

interface HookInput {
  session_id?: string
  cwd?: string
  tool_input?: { file_path?: string }
}

const MAIN = fileURLToPath(import.meta.url)
const SOURCE = AGENT === "claude" ? claudeSource : codexSource
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
      // Claude Code writes memories with its own tools, so the PostToolUse hook already
      // fires on every change and there is nothing to watch. Its worker holds the lock
      // while connected, because refreshing the OAuth token must not race.
      if (AGENT === "claude") {
        if (!claudeMemoriesEnabled(option("--cwd"))) {
          log(
            "memories: automatic sync skipped because Claude Code auto memory is disabled"
          )
          return
        }
        return withLock(() =>
          withNotion(config, undefined, async (callTool) => {
            await syncMemories(callTool, SOURCE)
          })
        )
      }
      const cwd = option("--cwd") || process.cwd()
      if (!(await CodexNotionMcp.memoriesEnabled(config.codexPath, cwd))) {
        log(
          "memories: automatic sync skipped because Codex memories are disabled"
        )
        return
      }
      return withNotion(config, option("--cwd"), async (callTool) => {
        const initialHash = memoryFilesHash()
        await withLock(() => syncMemories(callTool, SOURCE))
        await watchMemories(callTool, { ...WATCH[event], initialHash })
      })
    }
    case "sync":
      return withLock(() =>
        withNotion(config, undefined, async (callTool) => {
          console.log(JSON.stringify(await syncMemories(callTool, SOURCE)))
        })
      )
    case "verify": {
      if (AGENT !== "codex" || !config.sourceArchive)
        throw new Error("verify requires Codex sourceArchive mode")
      return withNotion(config, undefined, async (callTool) => {
        const result = await withLock(() =>
          verifyArchive(
            callTool,
            memorySources(config.sourceHome || AGENT_HOME),
            loadState()
          )
        )
        console.log(JSON.stringify(result))
      })
    }
    case "inventory": {
      if (AGENT !== "codex")
        throw new Error("inventory is for Codex memory sources")
      const sources = memorySources(config.sourceHome || AGENT_HOME)
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
    case "login":
      if (AGENT !== "claude") {
        console.log("Codex signs in itself: run `codex mcp login notion`.")
        return
      }
      return login(config.mcpUrl, openBrowser)
    case "preview": {
      const name = loadState().userName
      const knowledge = SOURCE.parse(option("--dir") ?? SOURCE.dir(), name)
      const archive = SOURCE.archive()
      const preview = archive
        ? {
            knowledge,
            archive: {
              sources: memorySources(config.sourceHome || AGENT_HOME).length,
              pages: archive.length,
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
        "usage: node src/main.ts login | sync | preview [--dir <path>] | status"
      )
  }
}

// Hooks have a short timeout and block the agent while they run, so hand the work to a
// detached worker process and return immediately. The worker logs to LOG_FILE.
function handleHook(event: string | undefined): void {
  // The worker's own `codex app-server` can start sessions too. Never recurse.
  if (process.env.NOTION_MEMORY_WORKER) return
  // No memory files exist yet, so do not start a worker.
  if (!hasMemoryFiles()) return
  let input: HookInput = {}
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8") || "{}")
  } catch (e) {
    log(
      `hook ${event}: could not read hook input:`,
      e instanceof Error ? e.message : String(e)
    )
  }
  // PostToolUse fires for every Write and Edit; only memory files matter.
  if (
    event === "post-tool-use" &&
    !isClaudeMemoryFile(input.tool_input?.file_path ?? "")
  )
    return
  if (AGENT === "claude" && !claudeReady(event, input.cwd)) return
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

function hasMemoryFiles(): boolean {
  if (AGENT === "claude")
    return claudeSource.parse(claudeSource.dir()).length > 0
  return (
    fs.existsSync(path.join(AGENT_HOME, "memories_1.sqlite")) ||
    fs.existsSync(codexSource.dir())
  )
}

// A Claude Code hook starts a worker only when auto memory is on for the session's project
// and the plugin is signed in to Notion.
function claudeReady(
  event: string | undefined,
  cwd: string | undefined
): boolean {
  if (!claudeMemoriesEnabled(cwd)) {
    log(`hook ${event}: Claude Code auto memory is disabled, skipping`)
    return false
  }
  if (!fs.existsSync(TOKEN_FILE)) {
    log(
      `hook ${event}: not signed in to Notion MCP; run \`NOTION_MEMORY_AGENT=claude node src/main.ts login\``
    )
    return false
  }
  return true
}

// Connects to Notion MCP: through the server Codex is already signed in to, or, in Claude
// Code, directly with the plugin's own sign-in. The connection starts on the first tool
// call, so a worker that finds nothing new never connects.
async function withNotion(
  config: Config,
  cwd: string | undefined,
  fn: (callTool: CallTool) => Promise<void>
): Promise<void> {
  if (AGENT === "claude") {
    let connection: Promise<NotionMcpHttp> | undefined
    return fn(async (tool, args) => {
      connection ??= NotionMcpHttp.connect(config.mcpUrl)
      return (await connection).callTool(tool, args)
    })
  }
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
  // A failing hook must never break the user's agent session.
  if (process.argv[2] === "hook") return
  console.error(e instanceof Error ? e.message : message)
  process.exitCode = 1
})
