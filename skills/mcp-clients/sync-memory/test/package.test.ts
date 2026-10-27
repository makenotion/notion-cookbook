import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fixture, object, recipe } from "./support/harness.ts"

test("built plugin contains only Sync Memory runtime and declares desktop-only execution without hooks", (t) => {
  const f = fixture(t)
  assert.deepEqual(fs.readdirSync(f.installed).sort(), [
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
  assert.equal(manifest.requires_local_executor, true)
  assert.equal(manifest.hooks, undefined)
  const listing = object(manifest.interface)
  assert.equal(
    listing.privacyPolicyURL,
    "https://privacycenter.notion.so/policies"
  )
  assert.equal(
    listing.termsOfServiceURL,
    "https://notion.notion.site/Terms-and-Privacy-28ffdd083dc3473e9c2da6ec011b58ac"
  )
})
