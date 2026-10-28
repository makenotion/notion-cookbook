import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { claudeFixture } from "./support/claude-harness.ts"
import { object, recipe, run } from "./support/harness.ts"

const claude = process.env.CLAUDE_TEST_BINARY

test(
  "real Claude Code installs the plugin with no hooks or MCP server, and its cached script syncs",
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

    // The repository's marketplace points at the built plugin; point a copy of it at
    // this fixture's build instead.
    const marketplace = f.root
    const registry = object(
      JSON.parse(
        fs.readFileSync(
          path.resolve(recipe, "../../../.claude-plugin/marketplace.json"),
          "utf8"
        )
      )
    )
    assert.ok(Array.isArray(registry.plugins))
    const plugin = registry.plugins
      .map(object)
      .find((p) => p.name === "sync-memory")
    assert.ok(plugin)
    plugin.source = `./${path.basename(f.installed)}`
    fs.mkdirSync(path.join(marketplace, ".claude-plugin"), { recursive: true })
    fs.writeFileSync(
      path.join(marketplace, ".claude-plugin/marketplace.json"),
      JSON.stringify({ ...registry, plugins: [plugin] })
    )
    let result = await cli("plugin", "marketplace", "add", marketplace)
    assert.equal(result.code, 0, result.stderr + result.stdout)
    result = await cli("plugin", "install", "sync-memory@notion-cookbook")
    assert.equal(result.code, 0, result.stderr + result.stdout)
    result = await cli("plugin", "list")
    assert.match(result.stdout, /sync-memory@notion-cookbook/)

    const cache = path.join(f.home, "plugins/cache/notion-cookbook/sync-memory")
    const [version] = fs.readdirSync(cache)
    const pluginRoot = path.join(cache, version)
    const manifest = object(
      JSON.parse(
        fs.readFileSync(
          path.join(pluginRoot, ".claude-plugin/plugin.json"),
          "utf8"
        )
      )
    )
    assert.equal(manifest.hooks, undefined)
    assert.equal(fs.existsSync(path.join(pluginRoot, ".mcp.json")), false)

    result = await cli("mcp", "list")
    assert.doesNotMatch(result.stdout + result.stderr, /sync-memory/)

    // An explicit sync from the installed cache writes through the offline server.
    f.signIn()
    f.seed()
    result = await run(
      process.execPath,
      [path.join(pluginRoot, "skills/sync-memory/scripts/main.ts"), "sync"],
      f.env,
      f.project
    )
    assert.equal(result.code, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).created, 5)
    assert.equal(f.pages().length, 5)
  }
)
