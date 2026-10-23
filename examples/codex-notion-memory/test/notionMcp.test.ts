import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

// The plugin resolves its paths at import time, so point them at a temp dir first.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-notion-mcp-"))
process.env.NOTION_MEMORY_AGENT = "claude"
process.env.CLAUDE_CONFIG_DIR = home
const { login, NotionMcpHttp, TOKEN_FILE } = await import(
  "../plugin/src/notionMcp.ts"
)

// Stand-in for mcp.notion.com: OAuth discovery, client registration, PKCE, refresh, and
// Streamable HTTP with SSE responses and a session ID.
async function fakeNotionServer() {
  let challenge = ""
  const valid = new Set<string>()
  const log: string[] = []
  const server = http.createServer(async (req, res) => {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const url = new URL(req.url ?? "/", base)
    const json = (status: number, body: unknown, headers = {}) =>
      res
        .writeHead(status, { "Content-Type": "application/json", ...headers })
        .end(JSON.stringify(body))
    log.push(`${req.method} ${url.pathname}`)
    switch (url.pathname) {
      case "/.well-known/oauth-protected-resource/mcp":
        return json(200, {
          resource: `${base}/mcp`,
          authorization_servers: [base],
        })
      case "/.well-known/oauth-authorization-server":
        return json(200, {
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
        })
      case "/register":
        assert.equal(JSON.parse(raw).token_endpoint_auth_method, "none")
        return json(201, { client_id: "client-1" })
      case "/authorize": {
        assert.equal(url.searchParams.get("resource"), `${base}/mcp`)
        challenge = url.searchParams.get("code_challenge") ?? ""
        const redirect = new URL(url.searchParams.get("redirect_uri") ?? "")
        redirect.searchParams.set("code", "code-1")
        redirect.searchParams.set("state", url.searchParams.get("state") ?? "")
        return res.writeHead(302, { Location: redirect.toString() }).end()
      }
      case "/token": {
        const form = new URLSearchParams(raw)
        assert.equal(form.get("client_id"), "client-1")
        if (form.get("grant_type") === "authorization_code") {
          const verifier = form.get("code_verifier") ?? ""
          const hashed = crypto
            .createHash("sha256")
            .update(verifier)
            .digest("base64url")
          assert.equal(hashed, challenge)
          valid.add("access-1")
          return json(200, {
            access_token: "access-1",
            refresh_token: "refresh-1",
            expires_in: 3600,
          })
        }
        assert.equal(form.get("refresh_token"), "refresh-1")
        valid.add("access-2")
        return json(200, {
          access_token: "access-2",
          refresh_token: "refresh-2",
          expires_in: 3600,
        })
      }
      case "/mcp": {
        const token = req.headers.authorization?.replace(/^Bearer /, "") ?? ""
        if (!valid.has(token)) return res.writeHead(401).end()
        const message = JSON.parse(raw)
        if (message.method === "initialize")
          return res
            .writeHead(200, {
              "Content-Type": "text/event-stream",
              "Mcp-Session-Id": "session-1",
            })
            .end(
              `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18" } })}\n\n`
            )
        assert.equal(req.headers["mcp-session-id"], "session-1")
        if (message.id === undefined) return res.writeHead(202).end()
        assert.equal(message.method, "tools/call")
        return json(200, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ tool: message.params.name, token }),
              },
            ],
          },
        })
      }
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
  return { base, valid, log, close: () => server.close() }
}

test("signs in with PKCE, calls tools, and refreshes an expired token", async () => {
  const notion = await fakeNotionServer()
  try {
    const mcpUrl = `${notion.base}/mcp`
    await assert.rejects(NotionMcpHttp.connect(mcpUrl), /not signed in/)

    // The test follows the authorize redirect instead of opening a browser.
    await login(mcpUrl, (url) => void fetch(url))
    assert.equal(fs.statSync(TOKEN_FILE).mode & 0o777, 0o600)

    const mcp = await NotionMcpHttp.connect(mcpUrl)
    assert.deepEqual(await mcp.callTool("notion-get-self", {}), {
      tool: "notion-get-self",
      token: "access-1",
    })

    // The access token stops working: the client refreshes once and retries.
    notion.valid.delete("access-1")
    assert.deepEqual(await mcp.callTool("notion-fetch", { id: "memory" }), {
      tool: "notion-fetch",
      token: "access-2",
    })
    const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"))
    assert.equal(saved.refreshToken, "refresh-2")
  } finally {
    notion.close()
  }
})
