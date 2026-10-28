import assert from "node:assert/strict"
import { test } from "node:test"
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

async function fixture(t, skills) {
  const root = await mkdtemp(join(tmpdir(), "cookbook-plugins-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path, contents) => {
    await mkdir(join(root, path, ".."), { recursive: true })
    await writeFile(join(root, path), contents)
  }
  await mkdir(join(root, "scripts"))
  await copyFile(
    new URL("./build-plugins.mjs", import.meta.url),
    join(root, "scripts/build-plugins.mjs")
  )
  for (const [path, contents] of Object.entries(skills)) {
    await put(join("skills/mcp-clients", path), contents)
  }
  await put("plugins/demo/plugin.json", '{"name":"demo"}')
  const run = (...args) =>
    spawnSync(process.execPath, ["scripts/build-plugins.mjs", ...args], {
      cwd: root,
      encoding: "utf8",
    })
  return { root, put, run }
}

const skill = (name) => `---\nname: ${name}\ndescription: Test.\n---\n\nBody\n`

test("names skill folders by frontmatter and leaves out evaluations", async (t) => {
  const { root, run } = await fixture(t, {
    "designer/SKILL.md": skill("notion-designer"),
    "designer/reference/schema.md": "schema",
    "designer/evaluations/case.json": "{}",
    "README.md": "not a skill",
  })

  assert.equal(run().status, 0)

  const plugin = join(root, "plugins/demo")
  assert.deepEqual(await readdir(join(plugin, "skills")), ["notion-designer"])
  assert.deepEqual(
    (await readdir(join(plugin, "skills/notion-designer"))).sort(),
    ["SKILL.md", "reference"]
  )
  assert.equal(
    await readFile(
      join(plugin, "skills/notion-designer/reference/schema.md"),
      "utf8"
    ),
    "schema"
  )
  assert.equal(
    await readFile(join(plugin, "plugin.json"), "utf8"),
    '{"name":"demo"}'
  )
})

test("check fails on edited or stale output until rebuilt", async (t) => {
  const { put, run } = await fixture(t, {
    "designer/SKILL.md": skill("notion-designer"),
  })
  assert.equal(run().status, 0)
  assert.equal(run("--dryRun").status, 0)

  await put("plugins/demo/skills/notion-designer/SKILL.md", "hand edit")
  assert.equal(run("--dryRun").status, 1)
  assert.equal(run().status, 0)

  await put("plugins/demo/skills/notion-removed/SKILL.md", skill("old"))
  const check = run("--dryRun")
  assert.equal(check.status, 1)
  assert.match(check.stderr, /plugins\/demo/)
  assert.equal(run().status, 0)
  assert.equal(run("--dryRun").status, 0)
})

test("rejects two skills with the same name", async (t) => {
  const { run } = await fixture(t, {
    "a/SKILL.md": skill("notion-same"),
    "b/SKILL.md": skill("notion-same"),
  })
  const result = run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /both use the skill name "notion-same"/)
})

test("portable plugins omit skills requiring a specific client", async (t) => {
  const { root, run } = await fixture(t, {
    "designer/SKILL.md": skill("notion-designer"),
    "memory/SKILL.md":
      "---\nname: sync-memory\ndescription: Copy memory.\nmetadata:\n  requires-client: codex\n---\n\nBody\n",
    "memory/scripts/main.ts": "throw new Error('Codex only')",
    "memory/node_modules/development-only/index.js":
      "throw new Error('not runtime')",
  })
  assert.equal(run().status, 0)
  assert.deepEqual(await readdir(join(root, "plugins/demo/skills")), [
    "notion-designer",
  ])
  assert.equal(run("--dryRun").status, 0)
})

test("listed plugins get exactly their skills, including client-specific ones", async (t) => {
  const { root, put, run } = await fixture(t, {
    "designer/SKILL.md": skill("notion-designer"),
    "setup/SKILL.md": skill("notion-setup"),
    "memory/SKILL.md":
      "---\nname: sync-memory\ndescription: Copy memory.\nmetadata:\n  requires-client: codex\n---\n\nBody\n",
    "memory/scripts/main.ts": "export {}",
    "memory/test/main.test.ts": "throw new Error('not runtime')",
    "memory/package-lock.json": "{}",
  })
  await put(
    "plugins/sync-memory/.codex-plugin/plugin.json",
    '{"name":"sync-memory"}'
  )
  assert.equal(run().status, 0)
  const plugin = join(root, "plugins/sync-memory/skills")
  assert.deepEqual((await readdir(plugin)).sort(), [
    "notion-setup",
    "sync-memory",
  ])
  assert.deepEqual((await readdir(join(plugin, "sync-memory"))).sort(), [
    "SKILL.md",
    "scripts",
  ])
  assert.deepEqual(await readdir(join(root, "plugins/demo/skills")), [
    "notion-designer",
    "notion-setup",
  ])
  assert.equal(run("--dryRun").status, 0)
})
