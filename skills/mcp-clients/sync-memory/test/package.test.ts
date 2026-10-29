import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { claudePlugin } from "./support/claude-harness.ts"
import { object, plugin, recipe } from "./support/harness.ts"

const manifest = object(
  JSON.parse(
    fs.readFileSync(path.join(plugin, ".codex-plugin/plugin.json"), "utf8")
  )
)
const listing = object(manifest.interface)

test("plugin bundles Sync Memory and setup and declares desktop-only execution without hooks", () => {
  assert.deepEqual(fs.readdirSync(plugin).sort(), [
    ".codex-plugin",
    ".mcp.json",
    "assets",
    "skills",
  ])
  assert.deepEqual(fs.readdirSync(path.join(plugin, "skills")).sort(), [
    "notion-setup",
    "sync-memory",
  ])
  assert.equal(manifest.name, "sync-memory")
  assert.equal(manifest.skills, "./skills/")
  assert.equal(manifest.mcpServers, "./.mcp.json")
  assert.equal(manifest.requires_local_executor, true)
  assert.equal(manifest.hooks, undefined)
  assert.equal(manifest.apps, undefined)
  const extension = object(object(manifest.extensions)["com.openai"])
  assert.equal(
    fs.readFileSync(
      path.resolve(plugin, String(extension.onboardingSkill)),
      "utf8"
    ),
    fs.readFileSync(path.resolve(recipe, "../setup/SKILL.md"), "utf8")
  )
  const skill = path.join(plugin, "skills/sync-memory")
  for (const excluded of ["test", "evaluations", "node_modules"])
    assert.equal(fs.existsSync(path.join(skill, excluded)), false, excluded)
  for (const name of ["SKILL.md", "agents/openai.yaml", "package.json"])
    assert.equal(
      fs.readFileSync(path.join(skill, name), "utf8"),
      fs.readFileSync(path.join(recipe, name), "utf8"),
      `${name} is stale; run npm run plugins:build`
    )
  for (const name of fs.readdirSync(path.join(recipe, "scripts")))
    assert.equal(
      fs.readFileSync(path.join(skill, "scripts", name), "utf8"),
      fs.readFileSync(path.join(recipe, "scripts", name), "utf8"),
      `scripts/${name} is stale; run npm run plugins:build`
    )
})

test("manifest has the fields Codex directory submission requires", () => {
  assert.match(String(manifest.version), /^\d+\.\d+\.\d+$/)
  assert.equal(
    manifest.version,
    object(
      JSON.parse(fs.readFileSync(path.join(recipe, "package.json"), "utf8"))
    ).version
  )
  assert.equal(typeof object(manifest.author).name, "string")
  for (const field of [
    "displayName",
    "shortDescription",
    "longDescription",
    "developerName",
    "category",
  ])
    assert.equal(typeof listing[field], "string", field)
  assert.ok(String(listing.displayName).length <= 30)
  assert.ok(String(listing.shortDescription).length <= 30)
  const capabilities = listing.capabilities
  assert.ok(Array.isArray(capabilities) && capabilities.length > 0)
  const prompts = listing.defaultPrompt
  assert.ok(Array.isArray(prompts) && prompts.length <= 3)
  for (const prompt of prompts) assert.ok(String(prompt).length <= 128)
  for (const field of ["logo", "composerIcon"]) {
    assert.match(String(listing[field]), /^\.\/assets\//, field)
    assert.ok(
      fs.existsSync(path.resolve(plugin, String(listing[field]))),
      field
    )
  }
  for (const field of [
    "websiteURL",
    "supportURL",
    "privacyPolicyURL",
    "termsOfServiceURL",
  ])
    assert.match(
      String(listing[field]),
      /^https:\/\/[^/]+\.notion\.(com|so|site)(\/|$)/,
      field
    )
  assert.doesNotMatch(String(listing.websiteURL), /mcp\.notion\.com/)
})

test("Claude Code plugin has only the Sync Memory skill and no hooks or MCP server", () => {
  assert.deepEqual(fs.readdirSync(claudePlugin).sort(), [
    ".claude-plugin",
    "skills",
  ])
  assert.deepEqual(fs.readdirSync(path.join(claudePlugin, "skills")), [
    "sync-memory",
  ])
  const claude = object(
    JSON.parse(
      fs.readFileSync(
        path.join(claudePlugin, ".claude-plugin/plugin.json"),
        "utf8"
      )
    )
  )
  assert.equal(claude.name, "sync-memory")
  assert.equal(claude.version, manifest.version)
  assert.equal(claude.skills, "./skills/")
  assert.equal(claude.mcpServers, undefined)
  assert.equal(claude.hooks, undefined)
  // Same runtime as the Codex plugin, from the same source.
  for (const name of fs.readdirSync(path.join(recipe, "scripts")))
    assert.equal(
      fs.readFileSync(
        path.join(claudePlugin, "skills/sync-memory/scripts", name),
        "utf8"
      ),
      fs.readFileSync(path.join(recipe, "scripts", name), "utf8"),
      `scripts/${name} is stale; run npm run plugins:build`
    )
})
