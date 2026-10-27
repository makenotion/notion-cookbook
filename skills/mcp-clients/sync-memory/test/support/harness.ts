import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { buildPlugin } from "../../scripts/build-plugin.mjs"

export const recipe = fileURLToPath(new URL("../../", import.meta.url))
export const support = fileURLToPath(new URL("./", import.meta.url))

export function object(value: unknown): Record<string, unknown> {
  assert.ok(isObject(value))
  return value
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export async function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeout = 15_000,
  input = ""
) {
  return new Promise<{
    code: number | null
    stdout: string
    stderr: string
    timedOut: boolean
  }>((resolve) => {
    const child = spawn(command, args, {
      env,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = "",
      stderr = "",
      timedOut = false
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", (error) => (stderr += error.message))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeout)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
    child.stdin.on("error", () => {})
    child.stdin.end(input)
  })
}

export function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "notion-plugin-test-"))
  const home = path.join(root, "home")
  const installed = path.join(root, "installed plugin")
  const installedSkill = path.join(installed, "skills/sync-memory")
  fs.mkdirSync(home)
  buildPlugin(installed)
  fs.chmodSync(path.join(support, "fake-codex.mjs"), 0o755)
  const env: NodeJS.ProcessEnv = {
    PATH: path.dirname(process.execPath),
    HOME: root,
    TMPDIR: os.tmpdir(),
    CODEX_HOME: home,
    CODEX_PATH: path.join(support, "fake-codex.mjs"),
    FIXTURE_STATE: path.join(root, "remote.json"),
    FIXTURE_CALLS: path.join(root, "calls.jsonl"),
  }
  const calls = () =>
    fs.existsSync(env.FIXTURE_CALLS!)
      ? fs
          .readFileSync(env.FIXTURE_CALLS!, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => object(JSON.parse(line)).method)
      : []
  const pages = () => {
    if (!fs.existsSync(env.FIXTURE_STATE!)) return []
    const value: unknown = object(
      JSON.parse(fs.readFileSync(env.FIXTURE_STATE!, "utf8"))
    ).pages
    assert.ok(Array.isArray(value))
    return value.map(object)
  }
  const cleanups: (() => void)[] = []
  t.after(() => {
    for (const cleanup of cleanups) cleanup()
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  })
  return {
    cleanupBeforeFiles(fn: () => void) {
      cleanups.push(fn)
    },
    root,
    home,
    installed,
    env,
    calls,
    pages,
    seed() {
      fs.cpSync(
        path.join(recipe, "test/fixtures/memories"),
        path.join(home, "memories_v2"),
        { recursive: true }
      )
    },
    exec(args: string[], extra: NodeJS.ProcessEnv = {}, timeout = 15_000) {
      return run(
        process.execPath,
        [path.join(installedSkill, "scripts/main.ts"), ...args],
        { ...env, ...extra },
        root,
        timeout,
        JSON.stringify({ session_id: "synthetic", cwd: root })
      )
    },
    savePages(pages: Record<string, unknown>[]) {
      fs.writeFileSync(env.FIXTURE_STATE!, JSON.stringify({ pages }))
    },
  }
}

export async function waitFor(predicate: () => boolean, timeout = 5_000) {
  const start = Date.now()
  while (!predicate()) {
    assert.ok(
      Date.now() - start < timeout,
      "timed out waiting for fixture condition"
    )
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
