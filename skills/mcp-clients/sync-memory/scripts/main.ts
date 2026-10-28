// Entry point for explicit Sync Memory commands. Set NOTION_MEMORY_AGENT=claude to work
// on Claude Code memories instead of Codex's.
//
//   node scripts/main.ts login             Claude Code only: sign in to Notion MCP
//   node scripts/main.ts sync              write the agent's memories now
//   node scripts/main.ts preview           offline: what it would write
//   node scripts/main.ts verify            read every synced page back
//   node scripts/main.ts status            memories it manages and pending-write recovery
//   node scripts/main.ts reconcile <source-path> --keep-notion <page-id>
//                                          release a pending write after review
import { claudeSource } from "./claude.ts"
import { codexSource } from "./codex.ts"
import { AGENT, type Config, loadConfig, log, withLock } from "./config.ts"
import { type CallTool, CodexNotionMcp } from "./mcp.ts"
import {
  memoryStatus,
  reconcileMemory,
  syncMemories,
  verifyMemories,
} from "./memories.ts"
import { login, NotionMcpHttp, openBrowser } from "./notionMcp.ts"

const SOURCE = AGENT === "claude" ? claudeSource : codexSource

async function main(): Promise<void> {
  const [command, name, action, pageId, ...extra] = process.argv.slice(2)
  const config = loadConfig()

  switch (command) {
    // Claude Code holds the lock while connected, because refreshing the OAuth token must
    // not race.
    case "sync":
      requireWorkspace(config)
      return withLock(() =>
        withNotion(config, async (callTool) => {
          console.log(JSON.stringify(await syncMemories(callTool, SOURCE)))
        })
      )
    case "reconcile":
      if (!name || action !== "--keep-notion" || !pageId || extra.length)
        throw new Error(
          "usage: node scripts/main.ts reconcile <source-path> --keep-notion <page-id>"
        )
      requireWorkspace(config)
      return withLock(() =>
        withNotion(config, async (callTool) => {
          console.log(
            JSON.stringify(await reconcileMemory(callTool, name, pageId))
          )
        })
      )
    case "verify":
      return withLock(() =>
        withNotion(config, async (callTool) => {
          console.log(JSON.stringify(await verifyMemories(callTool, SOURCE)))
        })
      )
    case "login":
      if (AGENT !== "claude") {
        console.log("Codex signs in itself: run `codex mcp login notion`.")
        return
      }
      return login(config.mcpUrl, openBrowser)
    case "preview":
      console.log(JSON.stringify(SOURCE.inventory(), null, 2))
      return
    case "status":
      console.log(JSON.stringify(memoryStatus(), null, 2))
      return
    case undefined:
      console.log(
        "usage: node scripts/main.ts login | sync | preview | verify | status | reconcile <source-path> --keep-notion <page-id>"
      )
      return
    default:
      throw new Error(`Unknown Sync Memory command: ${command}`)
  }
}

function requireWorkspace(config: Config): void {
  if (!config.expectedWorkspaceId?.trim())
    throw new Error(
      "Set expectedWorkspaceId in the approved config before sync or reconcile. Confirm the destination workspace with Notion get-self first."
    )
}

// Connects to Notion MCP: through the server Codex is already signed in to, or, in Claude
// Code, directly with the plugin's own sign-in. The connection starts on the first tool
// call, so an unchanged sync never connects.
async function withNotion(
  config: Config,
  fn: (callTool: CallTool) => Promise<void>
): Promise<void> {
  if (AGENT === "claude") {
    let connection: Promise<NotionMcpHttp> | undefined
    return fn(async (tool, args) => {
      connection ??= NotionMcpHttp.connect(
        config.mcpUrl,
        config.expectedWorkspaceId
      )
      return (await connection).callTool(tool, args)
    })
  }
  let connection: Promise<CodexNotionMcp> | undefined
  const callTool: CallTool = async (tool, args) => {
    connection ??= CodexNotionMcp.open({
      codexPath: config.codexPath,
      cwd: process.cwd(),
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
  console.error(e instanceof Error ? e.message : message)
  process.exitCode = 1
})
