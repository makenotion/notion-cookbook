import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"

export type WatchEvent = "session-start" | "stop"
const WINDOWS = { "session-start": 600_000, stop: 300_000 }
const HOST = "127.0.0.1"

function endpoint(directory: string, domain: string) {
  fs.mkdirSync(directory, { recursive: true })
  const key = crypto
    .createHash("sha256")
    .update(`${domain}\0${fs.realpathSync(directory)}`)
    .digest("hex")
  return { key, port: 20_000 + (parseInt(key.slice(0, 8), 16) % 40_000) }
}

function busy(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && error.code === "EADDRINUSE"
  )
}

function listen(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once("error", onError)
    server.listen({ host: HOST, port, exclusive: true }, () => {
      server.removeListener("error", onError)
      resolve()
    })
  })
}

async function close(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

export async function withOwnership<T>(
  directory: string,
  fn: () => Promise<T>,
  timeoutMs = 120_000
): Promise<T> {
  const { port } = endpoint(directory, "sync")
  const server = net.createServer((socket) => socket.destroy())
  const until = Date.now() + timeoutMs
  for (;;) {
    try {
      await listen(server, port)
      break
    } catch (error) {
      if (!busy(error)) throw error
      if (Date.now() >= until)
        throw new Error(
          `Sync Memory state is busy at ${directory} (127.0.0.1:${port})`
        )
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  try {
    return await fn()
  } finally {
    await close(server)
  }
}

function wake(port: number, key: string, event: WatchEvent): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: HOST, port })
    let input = ""
    const finish = (accepted: boolean) => {
      socket.destroy()
      resolve(accepted)
    }
    socket.setTimeout(1000, () => finish(false))
    socket.on("error", () => finish(false))
    socket.on("end", () => finish(false))
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ version: 1, key, event })}\n`)
    )
    socket.on("data", (chunk) => {
      input += chunk.toString()
      if (input.length > 512) return finish(false)
      if (!input.includes("\n")) return
      try {
        const reply: unknown = JSON.parse(input.slice(0, input.indexOf("\n")))
        finish(
          !!reply &&
            typeof reply === "object" &&
            !Array.isArray(reply) &&
            "version" in reply &&
            reply.version === 1 &&
            "key" in reply &&
            reply.key === key &&
            "accepted" in reply &&
            reply.accepted === true
        )
      } catch {
        finish(false)
      }
    })
  })
}

export interface WatchLease {
  until(): number
  finish(): boolean
}

export async function withWatcher(
  directory: string,
  event: WatchEvent,
  fn: (lease: WatchLease) => Promise<void>
): Promise<void> {
  const { port, key } = endpoint(directory, "watcher")
  let deadline = Date.now() + WINDOWS[event]
  let accepting = true
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => socket.destroy())
    const timer = setTimeout(() => socket.destroy(), 1000)
    socket.on("close", () => clearTimeout(timer))
    let input = ""
    socket.on("data", (chunk) => {
      input += chunk.toString()
      if (input.length > 512) return socket.destroy()
      if (!input.includes("\n")) return
      socket.removeAllListeners("data")
      try {
        const request: unknown = JSON.parse(input.slice(0, input.indexOf("\n")))
        if (
          !accepting ||
          !request ||
          typeof request !== "object" ||
          Array.isArray(request) ||
          !("version" in request) ||
          request.version !== 1 ||
          !("key" in request) ||
          request.key !== key ||
          !("event" in request) ||
          (request.event !== "session-start" && request.event !== "stop")
        )
          return socket.destroy()
        deadline = Math.max(deadline, Date.now() + WINDOWS[request.event])
        socket.end(`${JSON.stringify({ version: 1, key, accepted: true })}\n`)
      } catch {
        socket.destroy()
      }
    })
  })
  for (let attempt = 0; ; attempt++) {
    try {
      await listen(server, port)
      break
    } catch (error) {
      if (!busy(error)) throw error
      if (await wake(port, key, event)) return
      if (attempt >= 2)
        throw new Error(
          `Sync Memory watcher is busy or unresponsive at ${directory} (127.0.0.1:${port})`
        )
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  try {
    await fn({
      until: () => deadline,
      finish: () => {
        if (Date.now() < deadline) return false
        accepting = false
        return true
      },
    })
  } finally {
    accepting = false
    for (const socket of sockets) socket.destroy()
    await close(server)
  }
}
