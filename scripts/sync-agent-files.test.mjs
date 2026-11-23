import assert from "node:assert/strict"
import { test } from "node:test"
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  readFile,
  readlink,
  symlink,
  rm,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cookbook-agents-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, "scripts"))
  await copyFile(
    new URL("./sync-agent-files.mjs", import.meta.url),
    join(root, "scripts/sync-agent-files.mjs")
  )
  const recipes = [
    { id: "app", kind: "app-default", path: "apps/templates/app" },
    {
      id: "blocks",
      kind: "worker-custom-block",
      title: "Example custom block",
      commands: { deploy: "ntn workers deploy --name example" },
      path: "workers/templates/blocks",
    },
    {
      id: "workflow",
      kind: "worker-workflow",
      path: "workers/templates/workflow",
    },
  ]
  const put = async (path, contents) => {
    await mkdir(join(root, path, ".."), { recursive: true })
    await writeFile(join(root, path), contents)
  }
  await put("catalog.json", JSON.stringify({ recipes }))
  await put(
    "workers/templates/custom-blocks/README.template.md",
    "# {{title}}\n\n{{deployCommand}}\n"
  )
  for (const family of ["apps", "workers"]) {
    for (const group of ["default", "custom-blocks", "workflow"]) {
      await put(
        family + "/agents/instructions/" + group + "/INSTRUCTIONS.md",
        family + " instructions"
      )
    }
    for (const skill of [
      "auth-guide",
      "sync",
      "sync-debug",
      "sync-guide",
      "sync-validate",
      "workflow",
      "workflow-guide",
      "workflow-validate",
      "custom-blocks",
      "connections",
      "notion-as-code",
      "sketch",
    ]) {
      await put(
        family + "/agents/skills/" + skill + "/SKILL.md",
        family + " " + skill
      )
    }
  }
  const run = (...args) =>
    spawnSync(process.execPath, ["scripts/sync-agent-files.mjs", ...args], {
      cwd: root,
      encoding: "utf8",
    })
  return { root, recipes, put, run }
}

test("sync uses family-specific sources, removes stale files, and checks links", async (t) => {
  const { root, put, run } = await fixture(t)
  await put("apps/templates/app/.agents/skills/obsolete/SKILL.md", "stale")
  assert.equal(run("--dryRun").status, 1)
  assert.equal(run().status, 0)
  assert.equal(
    await readFile(
      join(root, "apps/templates/app/.agents/skills/sync/SKILL.md"),
      "utf8"
    ),
    "apps sync"
  )
  assert.equal(
    await readFile(
      join(root, "workers/templates/workflow/.agents/skills/sync/SKILL.md"),
      "utf8"
    ),
    "workers sync"
  )
  await assert.rejects(
    readFile(join(root, "apps/templates/app/.agents/skills/obsolete/SKILL.md")),
    { code: "ENOENT" }
  )
  assert.equal(
    await readlink(join(root, "apps/templates/app/AGENTS.md")),
    ".agents/INSTRUCTIONS.md"
  )
  assert.equal(run("--dryRun").status, 0)
  await put("apps/templates/app/.agents/INSTRUCTIONS.md", "edited copy")
  assert.equal(run("--dryRun").status, 1)
})

test("an App path outside apps/templates is rejected before writes", async (t) => {
  const { root, recipes, put, run } = await fixture(t)
  recipes[0].path = "workers/templates/app"
  await put("catalog.json", JSON.stringify({ recipes }))
  await put("workers/templates/app/.agents/INSTRUCTIONS.md", "preserve")
  assert.equal(run().status, 1)
  assert.equal(
    await readFile(
      join(root, "workers/templates/app/.agents/INSTRUCTIONS.md"),
      "utf8"
    ),
    "preserve"
  )
})

test("sync refuses to traverse a symlinked App template", async (t) => {
  const { root, put, run } = await fixture(t)
  await put("outside/.agents/INSTRUCTIONS.md", "preserve")
  await mkdir(join(root, "apps/templates"), { recursive: true })
  await symlink(join(root, "outside"), join(root, "apps/templates/app"))
  assert.equal(run().status, 1)
  assert.equal(
    await readFile(join(root, "outside/.agents/INSTRUCTIONS.md"), "utf8"),
    "preserve"
  )
})

test("sync renders custom block READMEs from catalog metadata and detects drift without writing", async (t) => {
  const { root, put, run } = await fixture(t)
  await put(
    "workers/templates/workflow/README.md",
    "Hand-maintained workflow guide"
  )
  assert.equal(run().status, 0)
  const readmePath = join(root, "workers/templates/blocks/README.md")
  const expected =
    "<!-- Generated from workers/templates/custom-blocks/README.template.md. Run npm run agents:sync to update. -->\n\n# Example custom block\n\nntn workers deploy --name example\n"
  assert.equal(await readFile(readmePath, "utf8"), expected)
  assert.equal(
    await readFile(join(root, "workers/templates/workflow/README.md"), "utf8"),
    "Hand-maintained workflow guide"
  )
  assert.equal(run("--dryRun").status, 0)
  await writeFile(readmePath, "Edited generated copy")
  const checked = run("--dryRun")
  assert.equal(checked.status, 1)
  assert.match(checked.stderr, /workers\/templates\/blocks\/README\.md/)
  assert.equal(await readFile(readmePath, "utf8"), "Edited generated copy")
  assert.equal(run().status, 0)
  assert.equal(await readFile(readmePath, "utf8"), expected)
})

test("custom block templates get the default Worker guide as workers.md", async (t) => {
  const { root, put, run } = await fixture(t)
  await put(
    "workers/agents/instructions/default/INSTRUCTIONS.md",
    "default worker guide"
  )
  assert.equal(run().status, 0)
  const workersMd = join(root, "workers/templates/blocks/.agents/workers.md")
  assert.equal(await readFile(workersMd, "utf8"), "default worker guide")
  await assert.rejects(
    readFile(join(root, "workers/templates/workflow/.agents/workers.md")),
    { code: "ENOENT" }
  )
  assert.equal(run("--dryRun").status, 0)
  await put("workers/agents/instructions/default/INSTRUCTIONS.md", "edited")
  assert.equal(run("--dryRun").status, 1)
})
