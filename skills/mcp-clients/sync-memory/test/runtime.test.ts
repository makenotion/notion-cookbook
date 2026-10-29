import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fixture, object, run, support } from "./support/harness.ts"
import { appServer } from "./support/rpc.ts"

const binary = process.env.CODEX_TEST_BINARY

test(
  "real Codex discovers the installed Sync Memory skill and syncs through a local MCP server",
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
    const userSkill = path.join(f.home, "skills/notion-sync-memory")
    fs.cpSync(f.installed, userSkill, { recursive: true })
    const server = appServer(binary, env, f.root)
    f.cleanupBeforeFiles(() => server.close())
    await server.call("initialize", {
      clientInfo: { name: "sync-memory-runtime-test", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    })
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
      .find((s) => s.name === "notion-sync-memory")
    assert.ok(skill, "installed Sync Memory skill must be discoverable")
    assert.equal(
      fs.realpathSync(String(skill.path)),
      fs.realpathSync(path.join(userSkill, "SKILL.md"))
    )
    assert.equal(skill.enabled, true)
    assert.deepEqual(f.pages(), [], "installation and discovery must not write")

    f.seed()
    const execute = () =>
      run(
        process.execPath,
        [path.join(userSkill, "scripts/main.ts"), "sync"],
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
    assert.ok(!f.calls().includes("turn/start"))
  }
)
