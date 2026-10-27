import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fixture, object, recipe, run, support } from "./support/harness.ts"
import { appServer } from "./support/rpc.ts"

const binary = process.env.CODEX_TEST_BINARY

test(
  "real Codex installs Sync Memory, discovers its skill and untrusted hooks, and syncs through a local MCP server",
  {
    skip: !binary && "set CODEX_TEST_BINARY to an installed Codex executable",
    timeout: 60_000,
  },
  async (t) => {
    assert.ok(binary)
    const f = fixture(t)
    const env = { ...f.env, CODEX_PATH: binary }
    const config = `model = "synthetic-no-generation"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Offline fixture"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[features]\nmemories = false\napps = false\nremote_plugin = false\n[analytics]\nenabled = false\n[mcp_servers.notion]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(path.join(support, "mcp-standin.mjs"))}]\n[mcp_servers.notion.env]\nFIXTURE_STATE = ${JSON.stringify(f.env.FIXTURE_STATE)}\nFIXTURE_CALLS = ${JSON.stringify(f.env.FIXTURE_CALLS)}\n`
    fs.writeFileSync(path.join(f.home, "config.toml"), config)
    const add = await run(
      binary,
      ["plugin", "marketplace", "add", path.resolve(recipe, "../../..")],
      env,
      f.root
    )
    assert.equal(add.code, 0, add.stderr)
    const install = await run(
      binary,
      ["plugin", "add", "sync-memory@notion-cookbook", "--json"],
      env,
      f.root
    )
    assert.equal(install.code, 0, install.stderr)
    const installed = object(JSON.parse(install.stdout))
    assert.equal(installed.authPolicy, "ON_INSTALL")
    assert.equal(typeof installed.installedPath, "string")
    const cache = String(installed.installedPath)
    assert.notEqual(cache, path.resolve(recipe, "../.."))
    const installedSkill = path.join(cache, "mcp-clients/sync-memory")
    assert.equal(
      fs.readFileSync(path.join(installedSkill, "scripts/main.ts"), "utf8"),
      fs.readFileSync(path.join(recipe, "scripts/main.ts"), "utf8")
    )
    const server = appServer(binary, env, f.root)
    f.cleanupBeforeFiles(() => server.close())
    await server.call("initialize", {
      clientInfo: { name: "sync-memory-runtime-test", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    })
    const hooks = object(await server.call("hooks/list", { cwds: [f.root] }))
    assert.ok(Array.isArray(hooks.data))
    const entry = object(hooks.data[0])
    assert.ok(Array.isArray(entry.hooks))
    const definitions = entry.hooks.map(object)
    assert.equal(definitions.length, 2)
    assert.ok(definitions.every((h) => h.trustStatus === "untrusted"))
    assert.ok(definitions.every((h) => String(h.sourcePath).startsWith(cache)))
    const thread = object(
      await server.call("thread/start", { ephemeral: true, cwd: f.root })
    )
    const id = object(thread.thread).id
    assert.equal(typeof id, "string")
    const inventory = object(
      await server.call("mcpServerStatus/list", { threadId: id })
    )
    assert.ok(Array.isArray(inventory.data))
    const notion = inventory.data.map(object).find((s) => s.name === "notion")
    assert.ok(notion)
    assert.ok("notion-create-pages" in object(notion.tools))
    const skills = object(
      await server.call("skills/list", { cwds: [f.root], forceReload: true })
    )
    assert.ok(Array.isArray(skills.data))
    const skillEntry = object(skills.data[0])
    assert.ok(Array.isArray(skillEntry.skills))
    const skill = skillEntry.skills
      .map(object)
      .find((s) => s.name === "sync-memory:sync-memory")
    assert.ok(skill, "installed Sync Memory skill must be discoverable")
    assert.equal(skill.path, path.join(installedSkill, "SKILL.md"))
    assert.equal(skill.enabled, true)
    assert.deepEqual(f.pages(), [], "untrusted startup hook must not write")

    f.seed()
    const execute = () =>
      run(
        process.execPath,
        [path.join(installedSkill, "scripts/main.ts"), "sync"],
        env,
        f.root,
        20_000
      )
    const first = await execute()
    assert.equal(first.code, 0, first.stderr)
    assert.equal(JSON.parse(first.stdout).created, 2)
    const second = await execute()
    assert.equal(second.code, 0, second.stderr)
    assert.equal(JSON.parse(second.stdout).unchanged, 2)
    assert.equal(f.pages().length, 2)
    const summary = path.join(f.home, "memories_v2/memory_summary.md")
    fs.writeFileSync(
      summary,
      fs.readFileSync(summary, "utf8").replace("TypeScript", "Rust")
    )
    const changed = await execute()
    assert.equal(changed.code, 0, changed.stderr)
    assert.equal(JSON.parse(changed.stdout).updated, 1)
    assert.match(
      String(f.pages().find((p) => p.title === "memory_summary.md")?.content),
      /Rust developer/
    )
    fs.writeFileSync(summary, "")
    const empty = await execute()
    assert.equal(empty.code, 0, empty.stderr)
    assert.equal(JSON.parse(empty.stdout).updated, 1)
    assert.match(
      String(f.pages().find((p) => p.title === "memory_summary.md")?.content),
      /^# Codex memory source\n[\s\S]*\n---\n\n$/
    )
    // Directly exercise the installed worker's disabled-config guard. No hooks are trusted.
    const disabled = await run(
      process.execPath,
      [
        path.join(installedSkill, "scripts/main.ts"),
        "worker",
        "session-start",
        "--cwd",
        f.root,
      ],
      env,
      f.root,
      15_000
    )
    assert.equal(disabled.code, 0, disabled.stderr)
    assert.match(fs.readFileSync(f.logFile, "utf8"), /memories are disabled/)
    assert.ok(!f.calls().includes("turn/start"))
  }
)
