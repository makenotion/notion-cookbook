// Offline stand-in for https://mcp.notion.com: OAuth refresh and Streamable HTTP MCP over
// the same synthetic pages as the Codex fixtures. Prints its port, then serves until killed.
import http from "node:http"
import { record, toolNames, toolResult } from "./notion-fixture.mjs"

const failure = process.env.FIXTURE_FAILURE
const valid = new Set(["synthetic-access"])

const server = http.createServer(async (req, res) => {
  let raw = ""
  for await (const chunk of req) raw += chunk
  const url = new URL(req.url ?? "/", "http://127.0.0.1")
  const json = (status, body, headers = {}) =>
    res
      .writeHead(status, { "Content-Type": "application/json", ...headers })
      .end(JSON.stringify(body))

  if (url.pathname === "/token") {
    record("oauth:refresh")
    if (failure === "expired") return json(400, { error: "invalid_grant" })
    valid.add("synthetic-access-2")
    return json(200, {
      access_token: "synthetic-access-2",
      refresh_token: "synthetic-refresh-2",
      expires_in: 3600,
    })
  }
  if (url.pathname !== "/mcp") return res.writeHead(404).end()

  const message = JSON.parse(raw)
  record(`mcp:${message.method}`)
  if (failure === "hang") return
  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "")
  if (failure === "expired" || !valid.has(token))
    return res.writeHead(401).end()
  if (message.id === undefined) return res.writeHead(202).end()
  const reply = (result) =>
    json(200, { jsonrpc: "2.0", id: message.id, result })
  switch (message.method) {
    case "initialize":
      return res
        .writeHead(200, {
          "Content-Type": "text/event-stream",
          "Mcp-Session-Id": "synthetic-session",
        })
        .end(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { protocolVersion: message.params.protocolVersion },
          })}\n\n`
        )
    case "tools/list":
      return reply({
        tools: toolNames.map((n) => ({ name: `notion-${n}` })),
      })
    case "tools/call":
      return reply(toolResult(message.params.name, message.params.arguments))
    default:
      return json(200, {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "unsupported fixture method" },
      })
  }
})

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify(server.address())}\n`)
})
