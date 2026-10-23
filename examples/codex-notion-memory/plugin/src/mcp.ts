// Calls Notion MCP tools through Codex's own MCP client, so the plugin never handles a Notion
// token: Codex owns the OAuth connection to mcp.notion.com. The worker starts
// `codex app-server`, opens an ephemeral thread (no model call, and ephemeral threads never
// feed Codex's memory pipeline), and uses `mcpServer/tool/call`.
import { type ChildProcess, spawn } from "node:child_process"
import readline from "node:readline"

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

interface ToolResult {
  content?: { type: string; text?: string }[]
  isError?: boolean
}

const REQUEST_TIMEOUT_MS = 60_000
// Hosted Notion MCP presents its tools with a `notion-` prefix.
const PROBE_TOOL = "notion-create-pages"

export class CodexNotionMcp {
  private child: ChildProcess
  private pending = new Map<number, (message: RpcResponse) => void>()
  private nextId = 0
  private threadId = ""
  server = ""

  private constructor(codexPath: string) {
    this.child = spawn(codexPath, ["app-server"], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, NOTION_MEMORY_WORKER: "1" },
    })
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

  static async connect(opts: {
    codexPath: string
    cwd: string
    server?: string
  }): Promise<CodexNotionMcp> {
    const mcp = new CodexNotionMcp(opts.codexPath)
    try {
      await mcp.rpc("initialize", {
        clientInfo: { name: "notion-memory", version: "0.1.0" },
      })
      mcp.notify("initialized")
      const thread = (await mcp.rpc("thread/start", {
        ephemeral: true,
        cwd: opts.cwd,
      })) as { thread?: { id?: string } }
      mcp.threadId = thread.thread?.id ?? ""
      if (!mcp.threadId) throw new Error("codex app-server returned no thread")
      mcp.server = await mcp.findNotionServer(opts.server)
      return mcp
    } catch (e) {
      mcp.close()
      throw e
    }
  }

  readonly callTool: CallTool = async (tool, args) => {
    const result = (await this.rpc("mcpServer/tool/call", {
      threadId: this.threadId,
      server: this.server,
      tool,
      arguments: args,
    })) as ToolResult
    const text = (result.content ?? []).map((part) => part.text ?? "").join("")
    if (result.isError) throw new Error(`${tool}: ${text.slice(0, 500)}`)
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  close(): void {
    this.child.kill()
  }

  private async findNotionServer(preferred?: string): Promise<string> {
    const status = (await this.rpc("mcpServerStatus/list", {
      threadId: this.threadId,
    })) as { data?: McpServerStatus[] }
    const servers = (status.data ?? []).filter(
      (s) => s.tools && PROBE_TOOL in s.tools
    )
    const match =
      servers.find((s) => s.name === preferred) ??
      servers.find((s) => s.name === "notion") ??
      servers[0]
    if (!match) {
      const names = (status.data ?? [])
        .map((s) => `${s.name} (${s.runtimeStatus})`)
        .join(", ")
      throw new Error(
        `no connected Notion MCP server exposes ${PROBE_TOOL}; found: ${names || "none"}. Run \`codex mcp login notion\`.`
      )
    }
    return match.name
  }

  private rpc(method: string, params: unknown): Promise<unknown> {
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
