// Copies the MCP client skills into every platform plugin under `plugins/`,
// except skills that declare `metadata.requires-client`: those run only in that
// client, so they ship in its own package instead.
// `skills/mcp-clients/` is the only source of truth for skill content; each
// plugin directory hand-writes just its manifest, MCP config, and assets, and
// this script owns its `skills/` subdirectory. Each skill folder is named after
// the `name` in its SKILL.md frontmatter, because plugin loaders following the
// Agent Skills spec expect the two to match. `--dryRun` writes nothing and
// exits non-zero when a plugin's `skills/` differs from what it would write.

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const isDryRun = process.argv.includes("--dryRun")

const SKILLS_SOURCE = "skills/mcp-clients"
const PLUGINS_ROOT = "plugins"
// Evaluations are validation material for maintainers, not runtime
// instructions, so plugins do not ship them.
const EXCLUDED_DIRECTORIES = new Set(["evaluations"])
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

function fail(message) {
  console.error(message)
  process.exit(1)
}

async function collectFiles(dir, prefix = "") {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
  const files = []
  for (const entry of entries) {
    const relPath = join(prefix, entry.name)
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) continue
      files.push(...(await collectFiles(join(dir, entry.name), relPath)))
    } else {
      files.push(relPath)
    }
  }
  return files.sort()
}

function readSkill(skillMarkdown, path) {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skillMarkdown)?.[1]
  const name = frontmatter && /^name:\s*(.+?)\s*$/m.exec(frontmatter)?.[1]
  if (!name || !SKILL_NAME.test(name)) {
    fail(`${path} needs a frontmatter name in lowercase-hyphen form`)
  }
  return {
    name,
    requiresClient: /^  requires-client:\s*\S/m.test(frontmatter),
  }
}

// Maps each output path, relative to a plugin root, to its contents.
async function buildExpectedFiles() {
  const sourceRoot = resolve(repoRoot, SKILLS_SOURCE)
  const entries = await readdir(sourceRoot, { withFileTypes: true })
  const expected = new Map()
  const sourceByName = new Map()
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillRoot = join(sourceRoot, entry.name)
    const skillPath = `${SKILLS_SOURCE}/${entry.name}/SKILL.md`
    let skillMarkdown
    try {
      skillMarkdown = await readFile(join(skillRoot, "SKILL.md"), "utf8")
    } catch (error) {
      if (error.code === "ENOENT") continue
      throw error
    }
    const { name, requiresClient } = readSkill(skillMarkdown, skillPath)
    if (sourceByName.has(name)) {
      fail(
        `${skillPath} and ${sourceByName.get(name)} both use the skill name ${JSON.stringify(name)}`
      )
    }
    sourceByName.set(name, skillPath)
    if (requiresClient) continue
    for (const file of await collectFiles(skillRoot)) {
      expected.set(
        join("skills", name, file),
        await readFile(join(skillRoot, file))
      )
    }
  }
  if (sourceByName.size === 0) fail(`No skills found in ${SKILLS_SOURCE}/`)
  return expected
}

const expected = await buildExpectedFiles()
const pluginRoots = (
  await readdir(resolve(repoRoot, PLUGINS_ROOT), { withFileTypes: true })
)
  .filter((entry) => entry.isDirectory())
  .map((entry) => resolve(repoRoot, PLUGINS_ROOT, entry.name))
if (pluginRoots.length === 0) fail(`No plugin directories in ${PLUGINS_ROOT}/`)

const drifted = []
for (const pluginRoot of pluginRoots) {
  const actualFiles = (await collectFiles(join(pluginRoot, "skills"))).map(
    (file) => join("skills", file)
  )
  const inSync =
    actualFiles.length === expected.size &&
    (
      await Promise.all(
        actualFiles.map(async (file) => {
          const contents = expected.get(file)
          return (
            contents !== undefined &&
            contents.equals(await readFile(join(pluginRoot, file)))
          )
        })
      )
    ).every(Boolean)
  if (inSync) continue
  drifted.push(pluginRoot)
  if (isDryRun) continue
  await rm(join(pluginRoot, "skills"), { recursive: true, force: true })
  for (const [file, contents] of expected) {
    await mkdir(dirname(join(pluginRoot, file)), { recursive: true })
    await writeFile(join(pluginRoot, file), contents)
  }
}

const relative = (path) => path.slice(repoRoot.length + 1)
if (isDryRun && drifted.length > 0) {
  fail(
    `Plugin skills are out of date: ${drifted.map(relative).join(", ")}\nRun \`npm run plugins:build\` and commit the result.`
  )
}
console.log(
  drifted.length === 0
    ? `All ${pluginRoots.length} plugin(s) are in sync with ${SKILLS_SOURCE}/`
    : `Rebuilt skills in ${drifted.map(relative).join(", ")}`
)
