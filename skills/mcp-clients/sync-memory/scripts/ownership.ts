import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"

const HOST = "127.0.0.1"

function portFor(directory: string): number {
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

export async function withOwnership<T>(
  directory: string,
  fn: () => Promise<T>,
  timeoutMs = 120_000
): Promise<T> {
  const port = portFor(directory)
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
