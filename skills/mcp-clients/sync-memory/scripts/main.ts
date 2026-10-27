import { type Config, loadConfig, loadState, log, withLock } from "./config.ts"
import { type CallTool, CodexNotionMcp } from "./mcp.ts"
import { memoryInventory, verifyMemories, syncMemories } from "./memories.ts"

async function main(): Promise<void> {
  const [command] = process.argv.slice(2)
  const config = loadConfig()

  switch (command) {
    case "sync":
      return withNotion(config, async (callTool) => {
        const result = await withLock(() => syncMemories(callTool))
        console.log(JSON.stringify(result))
      })
    case "verify":
      return withNotion(config, async (callTool) => {
        console.log(
          JSON.stringify(await withLock(() => verifyMemories(callTool)))
        )
      })
    case "preview":
      console.log(JSON.stringify(memoryInventory(), null, 2))
      return
    case "status":
      console.log(JSON.stringify(loadState(), null, 2))
      return
    case undefined:
      console.log(
        "usage: node scripts/main.ts sync | preview | verify | status"
      )
      return
    default:
      throw new Error(`Unknown Sync Memory command: ${command}`)
  }
}

// Connects to the Notion server that Codex is already signed in to. The connection starts
// on the first tool call, so an unchanged sync starts no app-server.
async function withNotion(
  config: Config,
  fn: (callTool: CallTool) => Promise<void>
): Promise<void> {
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
