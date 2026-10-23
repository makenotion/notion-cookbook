// Entry point for the Codex hooks and for manual commands.
//
//   node src/main.ts hook <session-start|stop>   called by Codex (reads hook JSON on stdin)
//   node src/main.ts sync                        import Codex memories now
//   node src/main.ts preview [--dir <path>]      offline: print what would be imported
//   node src/main.ts status                      memory pages managed by the plugin
import { spawn } from "node:child_process"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import {
  CONFIG_FILE,
  type Config,
  DATA_DIR,
  LOG_FILE,
  loadConfig,
  loadState,
  log,
  withLock,
} from "./config.ts"
import {
  memoriesDir,
  parseCodexMemories,
  syncMemories,
  watchMemories,
} from "./memories.ts"
import { NotionClient } from "./notion.ts"

interface HookInput {
  session_id?: string
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
      return handleHook(args[0], config)
    case "worker": {
      const event = args[0] === "stop" ? "stop" : "session-start"
      const client = requireClient(config)
      await withLock(() => syncMemories(client))
      return watchMemories(client, WATCH[event])
    }
    case "sync": {
      const client = requireClient(config)
      console.log(JSON.stringify(await withLock(() => syncMemories(client))))
      return
    }
    case "preview":
      console.log(
        JSON.stringify(
          parseCodexMemories(option("--dir") ?? memoriesDir()),
          null,
          2
        )
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

// Hooks have a short timeout and block Codex while they run, so hand the work to a
// detached worker process and return immediately. The worker logs to LOG_FILE.
function handleHook(event: string | undefined, config: Config): void {
  if (!config.token) {
    log(`hook ${event}: no Notion token in ${CONFIG_FILE} or NOTION_API_TOKEN`)
    return
  }
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
  // A failing hook must never break the user's Codex session.
  if (process.argv[2] === "hook") return
  console.error(e instanceof Error ? e.message : message)
  process.exitCode = 1
})
