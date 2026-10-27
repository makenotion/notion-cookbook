// Calls Notion MCP tools through Codex's own MCP client, so these scripts never handle a
// Notion token: Codex owns the connection. The worker starts `codex app-server`, opens an
// ephemeral thread (no model call, and ephemeral threads never feed Codex's memory
// pipeline), and uses `mcpServer/tool/call`.
//
// Resolve tools from the bundled `notion` MCP server or an already-connected Notion
// app on `codex_apps`. This standalone plugin does not register a hosted app. Tool names
// differ in prefix and separators, so callers use logical names such as "create-pages".
import { type ChildProcess, spawn } from "node:child_process"
import readline from "node:readline"

// `tool` is a logical Notion MCP tool name such as "create-pages" or "fetch".
export type CallTool = (tool: string, args: unknown) => Promise<unknown>

interface RpcResponse {
  id?: number
  method?: string
  result?: unknown
  error?: { message?: string }
}

interface McpServerStatus {
  name: string
  runtimeStatus?: string
  tools?: Record<string, unknown>
}

export interface ToolResult {
  content?: { type: string; text?: string }[]
  isError?: boolean
}

const REQUEST_TIMEOUT_MS = 60_000
const PROBE_TOOL = "create-pages"

export class CodexNotionMcp {
  private child: ChildProcess
  private pending = new Map<number, (message: RpcResponse) => void>()
  private nextId = 0
  private threadId = ""
  private tools = new Map<string, string>()
  private failure?: Error
  server = ""

  private constructor(codexPath: string) {
    this.child = spawn(codexPath, ["app-server"], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, NOTION_MEMORY_WORKER: "1" },
    })
    this.child.on("error", (error) => this.fail(error))
    this.child.on("exit", (code, signal) =>
      this.fail(new Error(`codex app-server exited (${signal ?? code})`))
    )
    this.child.stdin!.on("error", (error) => this.fail(error))
    readline
      .createInterface({ input: this.child.stdout! })
      .on("line", (line) => {
        let message: RpcResponse
        try {
          message = JSON.parse(line)
        } catch {
          return
        }
        if (message.id === undefined) return
        this.pending.get(message.id)?.(message)
        this.pending.delete(message.id)
      })
  }

  private fail(error: Error): void {
    this.failure ??= error
    for (const callback of this.pending.values())
      callback({ error: { message: error.message } })
    this.pending.clear()
  }

  private async initialize(): Promise<void> {
    await this.rpc("initialize", {
      clientInfo: { name: "sync-memory", version: "0.1.0" },
    })
    this.notify("initialized")
  }

  // Read effective config without creating a thread or connecting to Notion.
  static async memoriesEnabled(
    codexPath: string,
    cwd: string
  ): Promise<boolean> {
    const mcp = new CodexNotionMcp(codexPath)
    try {
      await mcp.initialize()
      const result: unknown = await mcp.rpc("config/read", {
        cwd,
        includeLayers: false,
      })
      if (!result || typeof result !== "object" || !("config" in result))
        return false
      const config = result.config
      if (!config || typeof config !== "object" || !("features" in config))
        return false
      const features = config.features
      return (
        !!features &&
        typeof features === "object" &&
        "memories" in features &&
        features.memories === true
      )
    } finally {
      mcp.close()
    }
  }

  static async connect(opts: {
    codexPath: string
    cwd: string
    server?: string
    expectedWorkspaceId?: string
  }): Promise<CodexNotionMcp> {
    const mcp = new CodexNotionMcp(opts.codexPath)
    try {
      await mcp.initialize()
      const thread = (await mcp.rpc("thread/start", {
        ephemeral: true,
        cwd: opts.cwd,
      })) as { thread?: { id?: string } }
      mcp.threadId = thread.thread?.id ?? ""
      if (!mcp.threadId) throw new Error("codex app-server returned no thread")
      await mcp.findNotionServer(opts.server)
      if (opts.expectedWorkspaceId) {
        const self = await mcp.callTool("get-self", {})
        if (
          !self ||
          typeof self !== "object" ||
          !("workspace" in self) ||
          !self.workspace ||
          typeof self.workspace !== "object" ||
          !("id" in self.workspace) ||
          self.workspace.id !== opts.expectedWorkspaceId
        )
          throw new Error(
            "Notion workspace does not match expectedWorkspaceId; refusing sync"
          )
      }
      return mcp
    } catch (e) {
      mcp.close()
      throw e
    }
  }

  readonly callTool: CallTool = async (tool, args) => {
    const name = this.tools.get(squash(tool))
    if (!name) throw new Error(`${this.server} has no Notion ${tool} tool`)
    const result = (await this.rpc("mcpServer/tool/call", {
      threadId: this.threadId,
      server: this.server,
      tool: name,
      arguments: args,
    })) as ToolResult
    return toolResultValue(tool, result)
  }

  close(): void {
    this.child.kill()
  }

  private async findNotionServer(preferred?: string): Promise<void> {
    const status = (await this.rpc("mcpServerStatus/list", {
      threadId: this.threadId,
    })) as { data?: McpServerStatus[] }
    const candidates = (status.data ?? []).flatMap((server) => {
      const tools = notionTools(server)
      return tools.has(squash(PROBE_TOOL)) ? [{ server, tools }] : []
    })
    const match = preferred
      ? candidates.find((c) => c.server.name === preferred)
      : (candidates.find((c) => c.server.name === "notion") ?? candidates[0])
    if (!match) {
      const names = (status.data ?? [])
        .map((s) => `${s.name} (${s.runtimeStatus})`)
        .join(", ")
      throw new Error(
        `no connected Notion server exposes ${PROBE_TOOL}; found: ${names || "none"}. Connect Notion in Codex first.`
      )
    }
    this.server = match.server.name
    this.tools = match.tools
  }

  private rpc(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure)
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, (message) => {
        clearTimeout(timer)
        if (message.error)
          reject(new Error(`${method}: ${message.error.message}`))
        else resolve(message.result)
      })
      this.child.stdin!.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`
      )
    })
  }

  private notify(method: string): void {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`)
  }
}

// Maps logical tool names to the server's tool names. Hosted Notion MCP names its tools
// `notion-create-pages`; the Notion app on `codex_apps` uses a connector prefix and
// underscores. On servers that also host other apps, only tools with the same prefix as the
// Notion create-pages tool count.
export function notionTools(server: {
  name: string
  tools?: Record<string, unknown>
}): Map<string, string> {
  const names = Object.keys(server.tools ?? {})
  const probe = names.find((n) => /notion.*create.?pages$/i.test(n))
  const out = new Map<string, string>()
  if (!probe) return out
  const prefix = squash(probe).slice(0, -squash(PROBE_TOOL).length)
  for (const name of names) {
    const key = squash(name)
    if (key.startsWith(prefix)) out.set(key.slice(prefix.length), name)
  }
  return out
}

// A tool's text content, parsed as JSON when it is JSON.
export function toolResultValue(tool: string, result: ToolResult): unknown {
  const texts = (result.content ?? []).flatMap((part) =>
    part.type === "text" && part.text ? [part.text] : []
  )
  if (result.isError)
    throw new Error(`${tool}: ${texts.join("\n").slice(0, 500)}`)
  // Notion sends the JSON result first, then optional human-readable notices.
  // Keep those notices visible without corrupting the machine-readable result.
  for (const notice of texts.slice(1))
    console.error(JSON.stringify({ tool, notice }))
  const text = texts[0] ?? ""
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

// Key for matching tool names across prefixes and separators.
export function squash(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "")
}
