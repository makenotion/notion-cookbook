#!/usr/bin/env node
import readline from "node:readline"
import { record, toolNames, toolResult } from "./notion-fixture.mjs"

if (process.env.FIXTURE_FAILURE === "exit") process.exit(7)
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  record(request.method)
  if (request.id === undefined) continue
  if (process.env.FIXTURE_FAILURE === "hang") continue
  let result
  switch (request.method) {
    case "initialize":
      result = { userAgent: "offline-fixture" }
      break
    case "config/read":
      result = {
        config: {
          features: {
            memories: process.env.FIXTURE_MEMORIES_ENABLED !== "false",
          },
        },
      }
      break
    case "thread/start":
      if (!request.params.ephemeral)
        throw new Error("only ephemeral threads permitted")
      result = { thread: { id: "synthetic-thread" } }
      break
    case "mcpServerStatus/list":
      result = {
        data:
          process.env.FIXTURE_FAILURE === "no-server"
            ? []
            : [
                {
                  name: "notion",
                  runtimeStatus: "ready",
                  tools: Object.fromEntries(
                    toolNames.map((n) => [`notion-${n}`, {}])
                  ),
                },
              ],
      }
      break
    case "mcpServer/tool/call":
      result = toolResult(request.params.tool, request.params.arguments)
      break
    default:
      throw new Error(`unapproved fixture RPC: ${request.method}`)
  }
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n")
}
