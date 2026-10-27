import assert from "node:assert/strict"
import { type ChildProcess, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import type { TestContext } from "node:test"
import { object, recipe, run, support } from "./harness.ts"

export type ClaudeHookEvent = "SessionStart" | "PostToolUse" | "Stop"

// An installed copy of the plugin in a path with spaces, an empty Claude Code home, a
// project directory, and the offline Notion server from fake-notion-http.mjs.
export async function claudeFixture(t: TestContext, failure = "") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "notion claude test-"))
  const home = path.join(root, "claude home")
  const installed = path.join(root, "installed plugin")
  const project = path.join(root, "work")
  fs.mkdirSync(home)
  fs.mkdirSync(project)
  // Same layout as the Codex harness: the plugin root is skills/, with this skill nested.
  const skill = path.join(installed, "mcp-clients/sync-memory")
  fs.mkdirSync(skill, { recursive: true })
  fs.cpSync(
    path.resolve(recipe, "../../.claude-plugin"),
    path.join(installed, ".claude-plugin"),
    { recursive: true }
  )
  for (const entry of [
    ".mcp.json",
    "claude-hooks.json",
    "hook.cjs",
    "package.json",
    "SKILL.md",
    "scripts",
  ]) {
    fs.cpSync(path.join(recipe, entry), path.join(skill, entry), {
      recursive: true,
    })
  }
  const memoryDir = path.join(
    home,
    "projects",
    project.replace(/[^a-zA-Z0-9]/g, "-"),
    "memory"
  )
  const fixtureEnv = {
    FIXTURE_STATE: path.join(root, "remote.json"),
    FIXTURE_CALLS: path.join(root, "calls.jsonl"),
    FIXTURE_FAILURE: failure,
    FIXTURE_SOURCE: "Claude Code",
  }
  const server = spawn(
    process.execPath,
    [path.join(support, "fake-notion-http.mjs")],
    {
      env: { PATH: path.dirname(process.execPath), ...fixtureEnv },
      stdio: ["ignore", "pipe", "inherit"],
    }
  )
  const port = await serverPort(server)
  const base = `http://127.0.0.1:${port}`
  const env: NodeJS.ProcessEnv = {
    PATH: path.dirname(process.execPath),
    HOME: root,
    TMPDIR: os.tmpdir(),
    NOTION_MEMORY_AGENT: "claude",
    CLAUDE_CONFIG_DIR: home,
    NOTION_MCP_URL: `${base}/mcp`,
    ...fixtureEnv,
  }
  const dataDir = path.join(home, "notion-memory")
  const logFile = path.join(dataDir, "notion-memory.log")
  const log = () =>
    fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : ""
  const hooks = object(
    object(
      JSON.parse(fs.readFileSync(path.join(skill, "claude-hooks.json"), "utf8"))
    ).hooks
  )

  t.after(() => {
    server.kill()
    for (const match of log().matchAll(/worker pid (\d+)/g)) {
      try {
        process.kill(Number(match[1]), "SIGTERM")
      } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true })
  })

  return {
    root,
    home,
    installed,
    project,
    memoryDir,
    env,
    logFile,
    log,
    server,
    calls() {
      if (!fs.existsSync(fixtureEnv.FIXTURE_CALLS)) return []
      return fs
        .readFileSync(fixtureEnv.FIXTURE_CALLS, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => String(object(JSON.parse(line)).method))
    },
    pages() {
      if (!fs.existsSync(fixtureEnv.FIXTURE_STATE)) return []
      const value: unknown = object(
        JSON.parse(fs.readFileSync(fixtureEnv.FIXTURE_STATE, "utf8"))
      ).pages
      assert.ok(Array.isArray(value))
      return value.map(object)
    },
    savePages(pages: Record<string, unknown>[]) {
      fs.writeFileSync(fixtureEnv.FIXTURE_STATE, JSON.stringify({ pages }))
    },
    // Stands in for `login`, which the notionMcp unit test covers.
    signIn() {
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(
        path.join(dataDir, "oauth.json"),
        JSON.stringify({
          mcpUrl: `${base}/mcp`,
          resource: `${base}/mcp`,
          tokenEndpoint: `${base}/token`,
          clientId: "synthetic-client",
          accessToken: "synthetic-access",
          refreshToken: "synthetic-refresh",
          expiresAt: Date.now() + 3_600_000,
        }),
        { mode: 0o600 }
      )
    },
    seed(dir = memoryDir) {
      fs.cpSync(path.join(recipe, "test/fixtures/claude/memory"), dir, {
        recursive: true,
      })
    },
    exec(args: string[], extra: NodeJS.ProcessEnv = {}, timeout = 15_000) {
      return run(
        process.execPath,
        [path.join(skill, "scripts/main.ts"), ...args],
        { ...env, ...extra },
        project,
        timeout
      )
    },
    // Runs the command exactly as written in claude-hooks.json, the way Claude Code does.
    hook(
      event: ClaudeHookEvent,
      input: Record<string, unknown> = {},
      extra: NodeJS.ProcessEnv = {}
    ) {
      const entries = hooks[event]
      assert.ok(Array.isArray(entries))
      return run(
        "/bin/sh",
        ["-c", hookCommand(entries)],
        { ...env, CLAUDE_PLUGIN_ROOT: installed, ...extra },
        project,
        15_000,
        JSON.stringify({ session_id: "synthetic", cwd: project, ...input })
      )
    },
  }
}

function hookCommand(entries: unknown[]): string {
  const hooks = object(entries[0]).hooks
  assert.ok(Array.isArray(hooks))
  return String(object(hooks[0]).command)
}

async function serverPort(server: ChildProcess): Promise<number> {
  assert.ok(server.stdout)
  for await (const line of readline.createInterface({ input: server.stdout }))
    return Number(object(JSON.parse(line)).port)
  throw new Error("fake Notion server exited before listening")
}
