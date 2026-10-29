import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import readline from "node:readline"
import { object } from "./harness.ts"

// Only non-generative, test-scoped requests are permitted by this driver.
const allowed = new Set([
  "initialize",
  "skills/list",
  "thread/start",
  "mcpServerStatus/list",
  "config/read",
])

export function appServer(binary: string, env: NodeJS.ProcessEnv, cwd: string) {
  const child = spawn(binary, ["app-server"], {
    env,
    cwd,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  })
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: NodeJS.Timeout
    }
  >()
  let id = 0,
    stderr = ""
  const fail = (error: Error) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(error)
    }
    pending.clear()
  }
  child.stderr.on("data", (chunk) => (stderr += chunk))
  child.on("error", fail)
  child.on("exit", (code) =>
    fail(new Error(`test app-server exited ${code}: ${stderr.slice(-1000)}`))
  )
  const lines = readline.createInterface({ input: child.stdout })
  lines.on("line", (line) => {
    const message = object(JSON.parse(line))
    if (typeof message.id !== "number") return
    const p = pending.get(message.id)
    if (!p) return
    clearTimeout(p.timer)
    pending.delete(message.id)
    if (message.error) p.reject(new Error(JSON.stringify(message.error)))
    else p.resolve(message.result)
  })
  return {
    async call(method: string, params: unknown): Promise<unknown> {
      assert.ok(
        allowed.has(method),
        `unapproved runtime test request: ${method}`
      )
      const requestId = ++id
      const result = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId)
          reject(new Error(`${method} timed out`))
        }, 15_000)
        pending.set(requestId, { resolve, reject, timer })
        child.stdin.write(
          JSON.stringify({ id: requestId, method, params }) + "\n"
        )
      })
      if (method === "initialize")
        child.stdin.write('{"method":"initialized"}\n')
      return result
    },
    close() {
      lines.close()
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {}
      } else child.kill("SIGKILL")
    },
  }
}
