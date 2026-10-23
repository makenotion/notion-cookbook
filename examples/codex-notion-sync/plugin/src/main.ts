// Entry point for the Codex hooks and for manual commands.
//
//   node src/main.ts hook <session-start|stop>   called by Codex (reads hook JSON on stdin)
//   node src/main.ts sync-session --session <id> [--transcript <path>]
//   node src/main.ts sync-memories
//   node src/main.ts preview-memories             offline: print what would be imported
//   node src/main.ts status
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
import { addSecrets } from "./redact.ts"
import { syncSession } from "./sessions.ts"

interface HookInput {
  session_id?: string
  transcript_path?: string
  turn_id?: string
}

const MAIN = fileURLToPath(import.meta.url)
// Codex starts its memory pipeline when a session starts, so watch from SessionStart too.
const WATCH_FROM_SESSION_START = { startWindowMs: 120_000, maxMs: 600_000 }
const WATCH_FROM_STOP = { startWindowMs: 15_000, maxMs: 300_000 }

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  const config = loadConfig()
  addSecrets(config.token)
  const option = (name: string) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }

  switch (command) {
    case "hook":
      return handleHook(args[0], config)
    case "worker-session-start": {
      const client = requireClient(config)
      if (!config.syncMemories) return
      await withLock(() => syncMemories(client))
      return watchMemories(client, WATCH_FROM_SESSION_START)
    }
    case "worker-stop": {
      const client = requireClient(config)
      await withLock(async () => {
        await syncSession(client, config, {
          sessionId: option("--session"),
          transcriptPath: option("--transcript"),
        })
        if (config.syncMemories) await syncMemories(client)
      })
      if (config.syncMemories) await watchMemories(client, WATCH_FROM_STOP)
      return
    }
    case "sync-session": {
      const client = requireClient(config)
      const entry = await withLock(() =>
        syncSession(client, config, {
          sessionId: option("--session"),
          transcriptPath: option("--transcript"),
        })
      )
      console.log(JSON.stringify({ page: entry.url, turns: entry.syncedTurns }))
      return
    }
    case "sync-memories": {
      const client = requireClient(config)
      console.log(JSON.stringify(await withLock(() => syncMemories(client))))
      return
    }
    case "preview-memories":
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
        "usage: node src/main.ts sync-session --session <id> | sync-memories | preview-memories [--dir <path>] | status"
      )
  }
}

// Hooks have a short timeout and block Codex while they run, so hand the work to a
// detached worker process and return immediately. The worker logs to LOG_FILE.
function handleHook(event: string | undefined, config: Config): void {
  if (!config.token) {
    log(
      `hook ${event}: no Notion token in ${CONFIG_FILE} or NOTION_API_TOKEN, skipping`
    )
    return
  }
  if (event === "session-start" && !config.syncMemories) return
  let input: HookInput = {}
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8") || "{}")
  } catch (e) {
    log(
      `hook ${event}: could not read hook input:`,
      e instanceof Error ? e.message : String(e)
    )
  }
  const workerArgs =
    event === "stop"
      ? [
          "worker-stop",
          "--session",
          input.session_id ?? "",
          "--transcript",
          input.transcript_path ?? "",
        ]
      : ["worker-session-start"]
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const out = fs.openSync(LOG_FILE, "a")
  // The memory watcher reads Codex's job table with node:sqlite, which warns on Node 22.
  const nodeArgs = ["--disable-warning=ExperimentalWarning", MAIN]
  const child = spawn(process.execPath, [...nodeArgs, ...workerArgs], {
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  })
  child.unref()
  log(
    `hook ${event}: session=${input.session_id} turn=${input.turn_id} -> worker pid ${child.pid}`
  )
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
