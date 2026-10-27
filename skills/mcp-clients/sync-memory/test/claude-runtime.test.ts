import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { claudeFixture } from "./support/claude-harness.ts"
import { recipe, run, waitFor } from "./support/harness.ts"

const claude = process.env.CLAUDE_TEST_BINARY

test(
  "real Claude Code installs the plugin, loads no MCP server, and its cached hook syncs",
  {
    skip:
      !claude &&
      "set CLAUDE_TEST_BINARY to an installed Claude Code executable",
    timeout: 120_000,
  },
  async (t) => {
    const f = await claudeFixture(t)
    const env = {
      ...f.env,
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    }
    const cli = (...args: string[]) =>
      run(String(claude), args, env, f.project, 60_000)

    let result = await cli(
      "plugin",
      "marketplace",
      "add",
      path.resolve(recipe, "../../..")
    )
    assert.equal(result.code, 0, result.stderr + result.stdout)
    result = await cli("plugin", "install", "sync-memory@notion-cookbook")
    assert.equal(result.code, 0, result.stderr + result.stdout)
    result = await cli("plugin", "list")
    assert.match(result.stdout, /sync-memory@notion-cookbook/)

    const cache = path.join(f.home, "plugins/cache/notion-cookbook/sync-memory")
    const [version] = fs.readdirSync(cache)
    const pluginRoot = path.join(cache, version)
    assert.ok(
      fs.existsSync(
        path.join(pluginRoot, "mcp-clients/sync-memory/claude-hooks.json")
      )
    )
    assert.equal(fs.existsSync(path.join(pluginRoot, ".mcp.json")), false)

    result = await cli("mcp", "list")
    assert.doesNotMatch(result.stdout + result.stderr, /sync-memory/)

    // The SessionStart command from the installed cache writes through the offline server.
    f.signIn()
    f.seed()
    const hook = await f.hook(
      "SessionStart",
      {},
      { CLAUDE_PLUGIN_ROOT: pluginRoot }
    )
    assert.equal(hook.code, 0, hook.stderr)
    await waitFor(() => /"created":5/.test(f.log()), 15_000)
    assert.equal(f.pages().length, 5)
  }
)
