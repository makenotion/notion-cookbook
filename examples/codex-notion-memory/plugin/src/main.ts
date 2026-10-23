// Entry point for the Codex and Claude Code hooks and for manual commands. Set
// NOTION_MEMORY_AGENT=claude to work on Claude Code memories instead of Codex's.
//
//   node src/main.ts hook <event>                called by the agent (reads hook JSON on stdin)
//   node src/main.ts sync                        import the agent's memories now
//   node src/main.ts preview [--dir <path>]      offline: print what would be imported
//   node src/main.ts status                      memory pages managed by the plugin
import { spawn } from "node:child_process"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { claudeSource, isClaudeMemoryFile } from "./claude.ts"
import { codexSource, watchMemories } from "./codex.ts"
import {
  AGENT,
  CONFIG_FILE,
  type Config,
  DATA_DIR,
  LOG_FILE,
  loadConfig,
  loadState,
  log,
  withLock,
} from "./config.ts"
import { syncMemories } from "./memories.ts"
import { NotionClient } from "./notion.ts"

interface HookInput {
  session_id?: string
  tool_input?: { file_path?: string }
}

const MAIN = fileURLToPath(import.meta.url)
const SOURCE = AGENT === "claude" ? claudeSource : codexSource
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
      return handleHook(args[0], config)
    case "worker": {
      const event = args[0] === "stop" ? "stop" : "session-start"
      const client = requireClient(config)
      await withLock(() => syncMemories(client, SOURCE))
      // Claude Code writes memories with its own tools, so the PostToolUse hook already
      // fires on every change and there is nothing to watch.
      if (AGENT === "codex") await watchMemories(client, WATCH[event])
      return
    }
    case "sync": {
      const client = requireClient(config)
      console.log(
        JSON.stringify(await withLock(() => syncMemories(client, SOURCE)))
      )
      return
    }
    case "preview":
      console.log(
        JSON.stringify(SOURCE.parse(option("--dir") ?? SOURCE.dir), null, 2)
      )
      return
    case "status":
      console.log(JSON.stringify(loadState(), null, 2))
      return
    default:
      console.log(
        "usage: node src/main.ts sync | preview [--dir <path>] | status"
      )
  }
}

// Hooks have a short timeout and block the agent while they run, so hand the work to a
// detached worker process and return immediately. The worker logs to LOG_FILE.
function handleHook(event: string | undefined, config: Config): void {
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
  if (!config.token) {
    log(`hook ${event}: no Notion token in ${CONFIG_FILE} or NOTION_API_TOKEN`)
    return
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const out = fs.openSync(LOG_FILE, "a")
  // The watcher reads Codex's job table with node:sqlite, which warns on Node 22.
  const nodeArgs = ["--disable-warning=ExperimentalWarning", MAIN]
  const child = spawn(
    process.execPath,
    [...nodeArgs, "worker", event ?? "session-start"],
    { detached: true, stdio: ["ignore", out, out], env: process.env }
  )
  child.unref()
  log(`hook ${event}: session=${input.session_id} -> worker pid ${child.pid}`)
}

function requireClient(config: Config): NotionClient {
  if (!config.token)
    throw new Error(
      `Set NOTION_API_TOKEN or add {"token": "..."} to ${CONFIG_FILE}`
    )
  return new NotionClient(config.baseUrl, config.token)
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? (e.stack ?? e.message) : String(e)
  log("error:", message)
  // A failing hook must never break the user's agent session.
  if (process.argv[2] === "hook") return
  console.error(e instanceof Error ? e.message : message)
  process.exitCode = 1
})
