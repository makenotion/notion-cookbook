import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { once } from "node:events"
import net from "node:net"
import { test, type TestContext } from "node:test"
import { ownershipPort, withOwnership } from "../scripts/ownership.ts"
import { waitFor } from "./support/harness.ts"

const module = new URL("../scripts/ownership.ts", import.meta.url).href

function processOwner(t: TestContext, directory: string) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { withOwnership } from ${JSON.stringify(module)}
    await withOwnership(process.argv[1], async () => {
      console.log("acquired")
      await new Promise(resolve => process.stdin.once("data", resolve))
      process.stdin.destroy()
    }, 3000)
  `,
      directory,
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  )
  let output = ""
  let errors = ""
  child.stdout.on("data", (chunk) => (output += chunk))
  child.stderr.on("data", (chunk) => (errors += chunk))
  t.after(() => child.kill("SIGKILL"))
  return {
    child,
    acquired: () => output.includes("acquired"),
    errors: () => errors,
  }
}

function directory(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-memory-ownership-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

async function exited(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await once(child, "exit")
}

test("canonical directory aliases serialize actual child processes", async (t) => {
  const root = directory(t)
  const actual = path.join(root, "actual")
  fs.mkdirSync(actual)
  const alias = path.join(root, "alias")
  fs.symlinkSync(actual, alias, "dir")
  const first = processOwner(t, actual)
  await waitFor(first.acquired)
  const second = processOwner(t, alias)
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(second.acquired(), false, second.errors())
  first.child.stdin!.write("release")
  await exited(first.child)
  await waitFor(second.acquired)
  second.child.stdin!.write("release")
  await exited(second.child)
})

test("SIGKILL releases ownership without stale files or reaping", async (t) => {
  const root = directory(t)
  const first = processOwner(t, root)
  await waitFor(first.acquired)
  first.child.kill("SIGKILL")
  await exited(first.child)
  const second = processOwner(t, root)
  await waitFor(second.acquired)
  assert.deepEqual(fs.readdirSync(root), [])
  second.child.stdin!.write("release")
  await exited(second.child)
})

test("an unrelated listener on the derived port fails fast instead of waiting", async (t) => {
  const root = directory(t)
  const foreign = net.createServer((socket) =>
    socket.end("HTTP/1.1 200 OK\r\n\r\n")
  )
  await new Promise<void>((resolve) =>
    foreign.listen({ host: "127.0.0.1", port: ownershipPort(root) }, resolve)
  )
  t.after(() => foreign.close())
  const started = Date.now()
  await assert.rejects(
    withOwnership(
      root,
      async () => assert.fail("acquired a foreign port"),
      30_000
    ),
    /Another program is listening/
  )
  assert.ok(Date.now() - started < 5_000)
})
