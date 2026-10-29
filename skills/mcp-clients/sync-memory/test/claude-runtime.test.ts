import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { test } from "node:test"
import { claudeFixture } from "./support/claude-harness.ts"
import { object, run } from "./support/harness.ts"

const claude = process.env.CLAUDE_TEST_BINARY

test(
  "real Claude Code discovers the installed Sync Memory user skill with no MCP server, and its script syncs",
  {
    skip:
      !claude &&
      "set CLAUDE_TEST_BINARY to an installed Claude Code executable",
    timeout: 120_000,
  },
  async (t) => {
    const f = await claudeFixture(t)
    const userSkill = path.join(f.home, "skills/notion-sync-memory")
    fs.cpSync(f.installed, userSkill, { recursive: true })

    // Claude Code reports its skills in the init event before any model call, so an
    // unauthenticated print run is enough to check discovery.
    const init = await initEvent(
      String(claude),
      {
        ...f.env,
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      },
      f.project
    )
    assert.ok(Array.isArray(init.skills))
    assert.ok(
      init.skills.includes("notion-sync-memory"),
      "installed Sync Memory skill must be discoverable"
    )
    assert.deepEqual(init.mcp_servers, [])

    // An explicit sync from the user skill writes through the offline server.
    f.signIn()
    f.seed()
    const result = await run(
      process.execPath,
      [path.join(userSkill, "scripts/main.ts"), "sync"],
      f.env,
      f.project
    )
    assert.equal(result.code, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).created, 5)
    assert.equal(f.pages().length, 5)
  }
)

async function initEvent(
  binary: string,
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<Record<string, unknown>> {
  const child = spawn(
    binary,
    ["-p", "hi", "--output-format", "stream-json", "--verbose"],
    { env, cwd, stdio: ["ignore", "pipe", "inherit"] }
  )
  try {
    for await (const line of readline.createInterface({
      input: child.stdout,
    })) {
      const event = object(JSON.parse(line))
      if (event.type === "system" && event.subtype === "init") return event
    }
    throw new Error("Claude Code exited before its init event")
  } finally {
    child.kill()
  }
}
