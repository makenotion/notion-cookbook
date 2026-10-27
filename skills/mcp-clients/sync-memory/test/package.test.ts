import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fixture, object, recipe } from "./support/harness.ts"

test("built plugin contains only Sync Memory runtime and resolves its manifest and hooks", (t) => {
  const f = fixture(t)
  assert.deepEqual(fs.readdirSync(f.installed).sort(), [
    ".claude-plugin",
    ".codex-plugin",
    "skills",
  ])
  assert.deepEqual(fs.readdirSync(path.join(f.installed, "skills")), [
    "sync-memory",
  ])
  const manifest = object(
    JSON.parse(
      fs.readFileSync(
        path.join(f.installed, ".codex-plugin/plugin.json"),
        "utf8"
      )
    )
  )
  assert.equal(manifest.name, "sync-memory")
  const skill = path.resolve(f.installed, String(manifest.skills))
  assert.deepEqual(fs.readdirSync(skill).sort(), [
    ".mcp.json",
    "SKILL.md",
    "claude-hooks.json",
    "hook.cjs",
    "hooks.json",
    "package.json",
    "scripts",
  ])
  const metadata = object(
    JSON.parse(fs.readFileSync(path.join(skill, "package.json"), "utf8"))
  )
  assert.equal(metadata.type, "module")
  assert.equal(metadata.scripts, undefined)
  assert.equal(metadata.devDependencies, undefined)
  const scripts = fs.readdirSync(path.join(skill, "scripts"))
  assert.ok(scripts.includes("main.ts"))
  assert.ok(scripts.every((name) => name.endsWith(".ts")))
  assert.equal(
    fs.readFileSync(path.join(skill, "SKILL.md"), "utf8"),
    fs.readFileSync(path.join(recipe, "SKILL.md"), "utf8")
  )
  assert.ok(
    fs.existsSync(path.resolve(f.installed, String(manifest.mcpServers)))
  )
  const hooks = object(
    JSON.parse(
      fs.readFileSync(path.resolve(f.installed, String(manifest.hooks)), "utf8")
    )
  )
  const definitions = object(hooks.hooks)
  for (const event of ["SessionStart", "Stop"]) {
    const groups = definitions[event]
    assert.ok(Array.isArray(groups))
    const commands = object(groups[0]).hooks
    assert.ok(Array.isArray(commands))
    const command = String(object(commands[0]).command)
    const match = command.match(/\$PLUGIN_ROOT\/([^" ]+)/)
    assert.ok(match)
    assert.ok(fs.existsSync(path.join(f.installed, match[1])))
  }
})

test("built plugin's Claude Code manifest resolves the same skill and its hooks", (t) => {
  const f = fixture(t)
  const manifest = object(
    JSON.parse(
      fs.readFileSync(
        path.join(f.installed, ".claude-plugin/plugin.json"),
        "utf8"
      )
    )
  )
  assert.equal(manifest.name, "sync-memory")
  assert.equal(manifest.mcpServers, undefined)
  assert.equal(
    path.resolve(f.installed, String(manifest.skills)),
    path.join(f.installed, "skills/sync-memory")
  )
  const hooks = object(
    object(
      JSON.parse(
        fs.readFileSync(
          path.resolve(f.installed, String(manifest.hooks)),
          "utf8"
        )
      )
    ).hooks
  )
  for (const groups of Object.values(hooks)) {
    assert.ok(Array.isArray(groups))
    const commands = object(groups[0]).hooks
    assert.ok(Array.isArray(commands))
    const command = String(object(commands[0]).command)
    const match = command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^" ]+)/)
    assert.ok(match, command)
    assert.ok(fs.existsSync(path.join(f.installed, match[1])))
  }
})
