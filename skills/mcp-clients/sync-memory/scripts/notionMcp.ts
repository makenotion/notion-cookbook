// Calls hosted Notion MCP directly over Streamable HTTP, for Claude Code. Claude Code has no
// way to call its own MCP connections without a model turn, so the plugin signs in to
// mcp.notion.com once with OAuth (dynamic client registration + PKCE, `main.ts login`) and
// keeps the tokens in DATA_DIR/oauth.json, readable only by the user.
import { spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { DATA_DIR } from "./config.ts"
import {
  type CallTool,
  notionTools,
  squash,
  type ToolResult,
  toolResultValue,
} from "./mcp.ts"

interface OAuthTokens {
  mcpUrl: string
  resource: string
  tokenEndpoint: string
  clientId: string
  accessToken: string
  refreshToken?: string
  // Epoch milliseconds.
  expiresAt?: number
}

interface RpcMessage {
  id?: number
  result?: unknown
  error?: { message?: string }
}

export const TOKEN_FILE = path.join(DATA_DIR, "oauth.json")
const PROTOCOL_VERSION = "2025-06-18"
const LOGIN_TIMEOUT_MS = 5 * 60_000
const REFRESH_MARGIN_MS = 60_000
const REQUEST_TIMEOUT_MS = 60_000

export class NotionMcpHttp {
  private tokens: OAuthTokens
  private sessionId: string | undefined
  private nextId = 0
  private tools = new Map<string, string>()

  private constructor(tokens: OAuthTokens) {
    this.tokens = tokens
  }

  static async connect(mcpUrl: string): Promise<NotionMcpHttp> {
    const tokens = readTokens()
    if (!tokens || tokens.mcpUrl !== mcpUrl)
      throw new Error(
        `not signed in to ${mcpUrl}; run \`NOTION_MEMORY_AGENT=claude node scripts/main.ts login\``
      )
    const mcp = new NotionMcpHttp(tokens)
    await mcp.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "notion-memory", version: "0.1.0" },
    })
    await mcp.post({ jsonrpc: "2.0", method: "notifications/initialized" })
    mcp.tools = notionTools({ name: "notion", tools: await mcp.listTools() })
    return mcp
  }

  // `tool` is a logical name such as "create-pages"; hosted Notion MCP calls it
  // "notion-create-pages".
  readonly callTool: CallTool = async (tool, args) => {
    const name = this.tools.get(squash(tool))
    if (!name) throw new Error(`Notion MCP has no ${tool} tool`)
    const result = (await this.rpc("tools/call", {
      name,
      arguments: args,
    })) as ToolResult
    return toolResultValue(tool, result)
  }

  private async listTools(): Promise<Record<string, unknown>> {
    const tools: Record<string, unknown> = {}
    let cursor: string | undefined
    do {
      const page = (await this.rpc("tools/list", cursor ? { cursor } : {})) as {
        tools?: { name: string }[]
        nextCursor?: string
      }
      for (const tool of page.tools ?? []) tools[tool.name] = tool
      cursor = page.nextCursor
    } while (cursor)
    return tools
  }

  private async rpc(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId
    const message = await this.post({ jsonrpc: "2.0", id, method, params })
    if (message?.error) throw new Error(`${method}: ${message.error.message}`)
    return message?.result
  }

  // Sends one JSON-RPC message and returns the response with the same id, if any.
  private async post(
    body: { id?: number } & Record<string, unknown>,
    retried = false
  ): Promise<RpcMessage | undefined> {
    const res = await fetch(this.tokens.mcpUrl, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${await this.accessToken()}`,
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      },
      body: JSON.stringify(body),
    })
    if (res.status === 401 && !retried) {
      await this.refresh()
      return this.post(body, true)
    }
    if (!res.ok)
      throw new Error(`MCP ${res.status}: ${(await res.text()).slice(0, 500)}`)
    this.sessionId = res.headers.get("mcp-session-id") ?? this.sessionId
    if (body.id === undefined) return undefined
    const text = await res.text()
    const messages = (res.headers.get("content-type") ?? "").includes(
      "text/event-stream"
    )
      ? sseMessages(text)
      : [JSON.parse(text) as RpcMessage]
    return messages.find((m) => m.id === body.id)
  }

  private async accessToken(): Promise<string> {
    const { expiresAt } = this.tokens
    if (expiresAt && expiresAt - REFRESH_MARGIN_MS < Date.now())
      await this.refresh()
    return this.tokens.accessToken
  }

  private async refresh(): Promise<void> {
    if (!this.tokens.refreshToken)
      throw new Error("Notion MCP sign-in expired; run login again")
    this.tokens = await requestTokens(this.tokens, {
      grant_type: "refresh_token",
      refresh_token: this.tokens.refreshToken,
    })
    saveTokens(this.tokens)
  }
}

// Interactive sign-in: registers a client, opens the browser, and waits for the redirect.
export async function login(
  mcpUrl: string,
  open: (url: string) => void
): Promise<void> {
  const {
    resource,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint,
  } = await discover(mcpUrl)
  const verifier = base64url(crypto.randomBytes(32))
  const state = base64url(crypto.randomBytes(16))
  let finish: (code: string) => void = () => {}
  let fail: (e: Error) => void = () => {}
  const received = new Promise<string>((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname !== "/callback") {
      res.writeHead(404).end()
      return
    }
    const code = url.searchParams.get("code")
    const ok = url.searchParams.get("state") === state && code
    res
      .writeHead(ok ? 200 : 400, { "Content-Type": "text/plain" })
      .end(
        ok
          ? "Signed in to Notion. You can close this tab."
          : "Sign-in failed. Check the terminal."
      )
    if (ok) finish(code)
    else fail(new Error(url.searchParams.get("error") ?? "state mismatch"))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const timer = setTimeout(
    () => fail(new Error("sign-in timed out")),
    LOGIN_TIMEOUT_MS
  )
  try {
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    const redirectUri = `http://127.0.0.1:${port}/callback`
    const client = (await postJson(registrationEndpoint, {
      client_name: "Notion Memory for Claude Code",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    })) as { client_id?: string }
    if (!client.client_id) throw new Error("client registration failed")
    const authorizeUrl = new URL(authorizationEndpoint)
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: base64url(
        crypto.createHash("sha256").update(verifier).digest()
      ),
      code_challenge_method: "S256",
      state,
      resource,
    }).toString()
    console.log(`Opening ${authorizeUrl}`)
    open(authorizeUrl.toString())
    const code = await received
    const tokens = await requestTokens(
      {
        mcpUrl,
        resource,
        tokenEndpoint,
        clientId: client.client_id,
        accessToken: "",
      },
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }
    )
    saveTokens(tokens)
    console.log(`Signed in. Tokens saved to ${TOKEN_FILE}.`)
  } finally {
    clearTimeout(timer)
    server.close()
  }
}

async function discover(mcpUrl: string): Promise<{
  resource: string
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint: string
}> {
  const url = new URL(mcpUrl)
  const resource = (await getJson(
    `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`
  )) as { resource?: string; authorization_servers?: string[] }
  const issuer = resource.authorization_servers?.[0] ?? url.origin
  const meta = (await getJson(
    `${issuer}/.well-known/oauth-authorization-server`
  )) as {
    authorization_endpoint?: string
    token_endpoint?: string
    registration_endpoint?: string
  }
  if (
    !meta.authorization_endpoint ||
    !meta.token_endpoint ||
    !meta.registration_endpoint
  )
    throw new Error(`${issuer} does not support dynamic client registration`)
  return {
    resource: resource.resource ?? mcpUrl,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: meta.registration_endpoint,
  }
}

async function requestTokens(
  base: OAuthTokens,
  grant: Record<string, string>
): Promise<OAuthTokens> {
  const res = await fetch(base.tokenEndpoint, {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...grant,
      client_id: base.clientId,
      resource: base.resource,
    }),
  })
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error?: string
  }
  if (!res.ok || !body.access_token)
    throw new Error(`token request failed: ${res.status} ${body.error ?? ""}`)
  return {
    ...base,
    accessToken: body.access_token,
    // Servers that rotate refresh tokens return a new one; others keep the old one.
    refreshToken: body.refresh_token ?? base.refreshToken,
    expiresAt: body.expires_in
      ? Date.now() + body.expires_in * 1000
      : undefined,
  }
}

function readTokens(): OAuthTokens | undefined {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"))
  } catch {
    return undefined
  }
}

function saveTokens(tokens: OAuthTokens): void {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(`${TOKEN_FILE}.tmp`, JSON.stringify(tokens, null, 2), {
    mode: 0o600,
  })
  fs.renameSync(`${TOKEN_FILE}.tmp`, TOKEN_FILE)
}

function sseMessages(text: string): RpcMessage[] {
  const out: RpcMessage[] = []
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    if (!data) continue
    try {
      out.push(JSON.parse(data))
    } catch {}
  }
  return out
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  return res.json()
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok)
    throw new Error(`POST ${url} -> ${res.status}: ${await res.text()}`)
  return res.json()
}

export function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer"
        : "xdg-open"
  spawn(command, [url], { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref()
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url")
}
