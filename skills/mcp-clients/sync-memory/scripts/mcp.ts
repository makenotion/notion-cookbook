// Calls Notion MCP tools through Codex's own MCP client, so these scripts never handle a
// Notion token: Codex owns the connection. The command starts `codex app-server`, opens an
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

interface ConnectionOptions {
  codexPath: string
  cwd: string
  server?: string
  expectedWorkspaceId?: string
}

interface McpServerStatus {
  name: string
  runtimeStatus?: string
  tools?: Record<string, unknown>
}

interface ToolResult {
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
  private opts: ConnectionOptions
  private notionReady?: Promise<void>
  private failure?: Error
  server = ""

  private constructor(opts: ConnectionOptions) {
    this.opts = opts
    this.child = spawn(opts.codexPath, ["app-server"], {
      stdio: ["pipe", "pipe", "ignore"],
    })
    this.child.on("error", (error) => this.fail(error))
    this.child.on("exit", (code, signal) =>
      this.fail(new Error(`codex app-server exited (${signal ?? code})`))
    )
    this.child.stdin!.on("error", (error) => this.fail(error))
    readline
      .createInterface({ input: this.child.stdout! })
      .on("line", (line) => {
        let message: unknown
        try {
          message = JSON.parse(line)
        } catch {
          return
        }
        if (!isObject(message)) return
        if ("method" in message) {
          if (
            typeof message.method === "string" &&
            (typeof message.id === "number" || typeof message.id === "string")
          )
            this.child.stdin!.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32601, message: "Unsupported server request" },
              })}\n`
            )
          return
        }
        if (
          typeof message.id !== "number" ||
          "result" in message === "error" in message
        )
          return
        const response: RpcResponse = { id: message.id, result: message.result }
        if ("error" in message) {
          if (
            !isObject(message.error) ||
            typeof message.error.message !== "string"
          )
            return
          response.error = { message: message.error.message }
        }
        this.pending.get(message.id)?.(response)
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
      clientInfo: { name: "sync-memory", version: "0.4.7" },
    })
    this.notify("initialized")
  }

  static async open(opts: ConnectionOptions): Promise<CodexNotionMcp> {
    const mcp = new CodexNotionMcp(opts)
    try {
      await mcp.initialize()
      return mcp
    } catch (error) {
      mcp.close()
      throw error
    }
  }

  private async connectNotion(): Promise<void> {
    const thread = await this.rpc("thread/start", {
      ephemeral: true,
      cwd: this.opts.cwd,
    })
    if (
      !isObject(thread) ||
      !isObject(thread.thread) ||
      typeof thread.thread.id !== "string"
    )
      throw new Error("codex app-server returned no thread")
    this.threadId = thread.thread.id
    await this.findNotionServer(this.opts.server)
    if (this.opts.expectedWorkspaceId) {
      const self = await this.invokeTool("get-self", {})
      if (
        !isObject(self) ||
        !isObject(self.workspace) ||
        self.workspace.id !== this.opts.expectedWorkspaceId
      )
        throw new Error(
          "Notion workspace does not match expectedWorkspaceId; refusing sync"
        )
    }
  }

  readonly callTool: CallTool = async (tool, args) => {
    this.notionReady ??= this.connectNotion()
    await this.notionReady
    return this.invokeTool(tool, args)
  }

  private readonly invokeTool: CallTool = async (tool, args) => {
    const name = this.tools.get(squash(tool))
    if (!name) throw new Error(`${this.server} has no Notion ${tool} tool`)
    const result = (await this.rpc("mcpServer/tool/call", {
      threadId: this.threadId,
      server: this.server,
      tool: name,
      arguments: args,
    })) as ToolResult
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
      : candidates.length === 1
        ? candidates[0]
        : undefined
    if (!preferred && candidates.length > 1)
      throw new Error(
        `Multiple Notion connections found (${candidates.map((c) => c.server.name).join(", ")}); set mcpServer in the approved config. No connection was selected.`
      )
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

function squash(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "")
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
