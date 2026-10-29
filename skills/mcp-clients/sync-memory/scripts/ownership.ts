import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"

const HOST = "127.0.0.1"
// Sent to every connection so a waiting process can tell a Sync Memory owner from
// an unrelated program that happens to listen on the same derived port.
const OWNER_GREETING = "sync-memory-owner\n"
const PROBE_TIMEOUT_MS = 1_000

export function ownershipPort(directory: string): number {
  fs.mkdirSync(directory, { recursive: true })
  const key = crypto
    .createHash("sha256")
    .update(`sync\0${fs.realpathSync(directory)}`)
    .digest("hex")
  return 20_000 + (parseInt(key.slice(0, 8), 16) % 40_000)
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

// Resolves true when the listener greets like a Sync Memory owner. A connection
// failure means the owner just exited, which also counts as ours: retry the bind.
function heldBySyncMemory(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let received = ""
    const socket = net.connect({ host: HOST, port })
    const finish = (owned: boolean) => {
      socket.destroy()
      resolve(owned)
    }
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false))
    socket.on("error", () => finish(true))
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8")
      if (received.length >= OWNER_GREETING.length)
        finish(received.startsWith(OWNER_GREETING))
    })
    socket.on("end", () => finish(received === OWNER_GREETING))
  })
}

export async function withOwnership<T>(
  directory: string,
  fn: () => Promise<T>,
  timeoutMs = 120_000
): Promise<T> {
  const port = ownershipPort(directory)
  const server = net.createServer((socket) => socket.end(OWNER_GREETING))
  const until = Date.now() + timeoutMs
  for (;;) {
    try {
      await listen(server, port)
      break
    } catch (error) {
      if (!busy(error)) throw error
      if (!(await heldBySyncMemory(port)))
        throw new Error(
          `Another program is listening on 127.0.0.1:${port}, the port Sync Memory uses to serialize imports for ${directory}. Stop that program, or move the mapping with NOTION_MEMORY_DATA to a different directory.`
        )
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
