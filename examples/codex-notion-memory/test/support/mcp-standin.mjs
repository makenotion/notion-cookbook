import readline from "node:readline"
import { record, toolNames, toolResult } from "./notion-fixture.mjs"

for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  record(`mcp:${request.method}`)
  if (request.id === undefined) continue
  let result
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "synthetic-notion", version: "1.0.0" },
      }
      break
    case "tools/list":
      result = {
        tools: toolNames.map((n) => ({
          name: `notion-${n}`,
          description: "Synthetic offline Notion tool",
          inputSchema: { type: "object", additionalProperties: true },
        })),
      }
      break
    case "tools/call":
      result = toolResult(request.params.name, request.params.arguments)
      break
    case "resources/list":
      result = { resources: [] }
      break
    case "resources/templates/list":
      result = { resourceTemplates: [] }
      break
    case "prompts/list":
      result = { prompts: [] }
      break
    default:
      process.stdout.write(
        JSON.stringify({
          id: request.id,
          error: { code: -32601, message: "unsupported fixture method" },
        }) + "\n"
      )
      continue
  }
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n"
  )
}
