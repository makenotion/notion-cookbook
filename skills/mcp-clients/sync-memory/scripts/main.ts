// Entry point for explicit Sync Memory commands. Set NOTION_MEMORY_AGENT=claude to work
// on Claude Code memories instead of Codex's.
//
//   node scripts/main.ts login             Claude Code only: sign in to Notion MCP
//   node scripts/main.ts sync              write the agent's memories now
//   node scripts/main.ts preview           offline: what it would write
//   node scripts/main.ts verify            read every synced page back
//   node scripts/main.ts status            memories it manages
import { claudeSource } from "./claude.ts"
import { codexSource } from "./codex.ts"
import {
  AGENT,
  type Config,
  loadConfig,
  loadState,
  log,
  withLock,
} from "./config.ts"
import { type CallTool, CodexNotionMcp } from "./mcp.ts"
import { syncMemories, verifyMemories } from "./memories.ts"
import { login, NotionMcpHttp, openBrowser } from "./notionMcp.ts"

const SOURCE = AGENT === "claude" ? claudeSource : codexSource

async function main(): Promise<void> {
  const [command] = process.argv.slice(2)
  const config = loadConfig()

  switch (command) {
    // Claude Code holds the lock while connected, because refreshing the OAuth token must
    // not race.
    case "sync":
      return withLock(() =>
        withNotion(config, async (callTool) => {
          console.log(JSON.stringify(await syncMemories(callTool, SOURCE)))
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
      console.log(JSON.stringify(loadState(), null, 2))
      return
    case undefined:
      console.log(
        "usage: node scripts/main.ts login | sync | preview | verify | status"
      )
      return
    default:
      throw new Error(`Unknown Sync Memory command: ${command}`)
  }
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
      connection ??= NotionMcpHttp.connect(config.mcpUrl)
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
