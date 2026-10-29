import {
  type Config,
  hasState,
  loadConfig,
  loadState,
  log,
  pinWorkspace,
  withLock,
} from "./config.ts"
import { type CallTool, CodexNotionMcp } from "./mcp.ts"
import {
  discardUnknownCreate,
  memoryInventory,
  memoryStatus,
  reconcileMemory,
  verifyMemories,
  syncMemories,
} from "./memories.ts"

async function main(): Promise<void> {
  const [command, name, action, pageId, ...extra] = process.argv.slice(2)
  const config = loadConfig()

  switch (command) {
    case "sync":
      requireWorkspace(config)
      return withNotion(config, async (callTool) => {
        const result = await withLock(() => syncMemories(callTool))
        console.log(JSON.stringify(result))
      })
    case "reconcile":
      if (name && action === "--not-created" && !pageId) {
        console.log(
          JSON.stringify(await withLock(async () => discardUnknownCreate(name)))
        )
        return
      }
      if (!name || action !== "--keep-notion" || !pageId || extra.length)
        throw new Error(
          "usage: node scripts/main.ts reconcile <source-path> --keep-notion <page-id> | reconcile <source-path> --not-created"
        )
      requireWorkspace(config)
      return withNotion(config, async (callTool) => {
        console.log(
          JSON.stringify(
            await withLock(() => reconcileMemory(callTool, name, pageId))
          )
        )
      })
    case "use-workspace":
      return useWorkspace(config, name, action, pageId)
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
      console.log(JSON.stringify(memoryStatus(), null, 2))
      return
    case undefined:
      console.log(
        "usage: node scripts/main.ts sync | preview | verify | status | use-workspace [--confirm <workspace-id>] | reconcile <source-path> --keep-notion <page-id> | reconcile <source-path> --not-created"
      )
      return
    default:
      throw new Error(`Unknown Sync Memory command: ${command}`)
  }
}

// Without --confirm, reports the workspace the Notion connection reaches. With it,
// pins that workspace after checking it is the connected one. Each workspace keeps
// its own mapping, so the switch leaves the previous workspace's pages and mapping
// untouched, and a workspace without a mapping starts with a full first sync.
async function useWorkspace(
  config: Config,
  flag: string | undefined,
  workspaceId: string | undefined,
  extra: string | undefined
): Promise<void> {
  if (flag !== undefined && (flag !== "--confirm" || !workspaceId || extra))
    throw new Error(
      "usage: node scripts/main.ts use-workspace [--confirm <workspace-id>]"
    )
  const previous = config.expectedWorkspaceId?.trim() || undefined
  await withNotion(
    { ...config, expectedWorkspaceId: undefined },
    async (call) => {
      const connected = connectedWorkspace(await call("get-self", {}))
      if (!workspaceId) {
        console.log(
          JSON.stringify({
            connected,
            pinned: previous ?? null,
            hasMapping: hasState(connected.id),
          })
        )
        return
      }
      if (workspaceId !== connected.id)
        throw new Error(
          `The Notion connection reaches workspace ${connected.id}, not ${workspaceId}. Reconnect Notion and choose the workspace you want before pinning it.`
        )
      const result = await withLock(async () => {
        if (previous && previous !== workspaceId) {
          const state = loadState(previous)
          const pending = Object.keys(state.pending ?? {})
          if (pending.length)
            throw new Error(
              `Workspace ${previous} has unresolved pending writes (${pending.join(", ")}); run status and reconcile them before switching.`
            )
        }
        const hasMapping = hasState(workspaceId)
        pinWorkspace(workspaceId)
        return { pinned: workspaceId, previous: previous ?? null, hasMapping }
      })
      console.log(JSON.stringify({ connected, ...result }))
    }
  )
}

function connectedWorkspace(self: unknown): {
  id: string
  name: string | null
} {
  if (
    !self ||
    typeof self !== "object" ||
    !("workspace" in self) ||
    !self.workspace ||
    typeof self.workspace !== "object" ||
    !("id" in self.workspace) ||
    typeof self.workspace.id !== "string"
  )
    throw new Error("Notion get-self returned no workspace")
  const name = "name" in self.workspace ? self.workspace.name : undefined
  return {
    id: self.workspace.id,
    name: typeof name === "string" ? name : null,
  }
}

function requireWorkspace(config: Config): void {
  if (!config.expectedWorkspaceId?.trim())
    throw new Error(
      "Set expectedWorkspaceId in the approved config before sync or reconcile. Confirm the destination workspace with Notion get-self first."
    )
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
