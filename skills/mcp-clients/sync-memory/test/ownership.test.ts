import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import crypto from "node:crypto"
import os from "node:os"
import path from "node:path"
import { once } from "node:events"
import { test, type TestContext } from "node:test"
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

test("watcher followers extend one leader and never run their callback", async (t) => {
  const { withWatcher } = await import("../scripts/ownership.ts")
  const root = directory(t)
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let ready!: (until: () => number) => void
  const started = new Promise<() => number>((resolve) => (ready = resolve))
  const leader = withWatcher(root, "stop", async (lease) => {
    ready(lease.until)
    await gate
  })
  const until = await started
  const original = until()
  let followerRan = false
  await withWatcher(root, "session-start", async () => {
    followerRan = true
  })
  assert.equal(followerRan, false)
  assert.ok(until() >= original + 299_000)
  release()
  await leader
  await withWatcher(root, "stop", async () => {
    followerRan = true
  })
  assert.equal(followerRan, true)
})

test("colliding watcher ports cannot acknowledge another source directory", async (t) => {
  const { withWatcher } = await import("../scripts/ownership.ts")
  const root = fs.realpathSync(directory(t))
  const seen = new Map<number, string>()
  let pair: [string, string] | undefined
  for (let index = 0; index < 40_001; index++) {
    const candidate = path.join(root, String(index))
    const key = crypto
      .createHash("sha256")
      .update(`watcher\0${candidate}`)
      .digest("hex")
    const port = 20_000 + (parseInt(key.slice(0, 8), 16) % 40_000)
    const previous = seen.get(port)
    if (previous) {
      pair = [previous, candidate]
      break
    }
    seen.set(port, candidate)
  }
  assert.ok(pair)
  for (const item of pair) fs.mkdirSync(item)
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let ready!: () => void
  const started = new Promise<void>((resolve) => (ready = resolve))
  const leader = withWatcher(pair[0], "stop", async () => {
    ready()
    await gate
  })
  await started
  let followerRan = false
  try {
    await assert.rejects(
      withWatcher(pair[1], "session-start", async () => {
        followerRan = true
      }),
      /busy or unresponsive/
    )
    assert.equal(followerRan, false)
  } finally {
    release()
    await leader
  }
})
