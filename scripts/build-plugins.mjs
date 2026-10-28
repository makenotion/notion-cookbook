// Copies the MCP client skills into the platform plugins under `plugins/`.
// Plugins listed in PLUGIN_SKILLS get exactly those skills; every other plugin
// gets each skill that does not declare `metadata.requires-client`.
// `skills/mcp-clients/` is the only source of truth for skill content; each
// plugin directory hand-writes just its manifest, MCP config, and assets, and
// this script owns its `skills/` subdirectory. Each skill folder is named after
// the `name` in its SKILL.md frontmatter, because plugin loaders following the
// Agent Skills spec expect the two to match. `--dryRun` writes nothing and
// exits non-zero when a plugin's `skills/` differs from what it would write.

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const isDryRun = process.argv.includes("--dryRun")

const SKILLS_SOURCE = "skills/mcp-clients"
const PLUGINS_ROOT = "plugins"
const PLUGIN_SKILLS = {
  "sync-memory": ["sync-memory", "notion-setup"],
}
// Evaluations and tests are validation material for maintainers, not runtime
// instructions, so plugins do not ship them. Local installs are not tracked.
const EXCLUDED_DIRECTORIES = new Set(["evaluations", "test", "node_modules"])
const EXCLUDED_FILES = new Set(["package-lock.json", ".DS_Store"])
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
    // Checked before the entry type so a symlinked `node_modules` is skipped too.
    if (EXCLUDED_DIRECTORIES.has(entry.name)) continue
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(join(dir, entry.name), relPath)))
    } else if (!EXCLUDED_FILES.has(entry.name)) {
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
    requiresClient: /^  requires-client:\s*(\S.*?)\s*$/m.exec(frontmatter)?.[1],
  }
}

// Maps each skill name to its output files, keyed by path relative to a plugin
// root, and whether the skill is limited to one client.
async function readSkills() {
  const sourceRoot = resolve(repoRoot, SKILLS_SOURCE)
  const entries = await readdir(sourceRoot, { withFileTypes: true })
  const skills = new Map()
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
    const files = new Map()
    for (const file of await collectFiles(skillRoot)) {
      files.set(
        join("skills", name, file),
        await readFile(join(skillRoot, file))
      )
    }
    skills.set(name, { files, requiresClient })
  }
  if (skills.size === 0) fail(`No skills found in ${SKILLS_SOURCE}/`)
  return skills
}

function expectedFilesFor(pluginName, skills) {
  const selected =
    PLUGIN_SKILLS[pluginName] ??
    [...skills].flatMap(([name, skill]) => (skill.requiresClient ? [] : [name]))
  const expected = new Map()
  for (const name of selected) {
    const skill = skills.get(name)
    if (!skill)
      fail(`${PLUGINS_ROOT}/${pluginName} lists unknown skill ${name}`)
    for (const [file, contents] of skill.files) expected.set(file, contents)
  }
  return expected
}

const skills = await readSkills()
const pluginRoots = (
  await readdir(resolve(repoRoot, PLUGINS_ROOT), { withFileTypes: true })
)
  .filter((entry) => entry.isDirectory())
  .map((entry) => resolve(repoRoot, PLUGINS_ROOT, entry.name))
if (pluginRoots.length === 0) fail(`No plugin directories in ${PLUGINS_ROOT}/`)

const drifted = []
for (const pluginRoot of pluginRoots) {
  const expected = expectedFilesFor(basename(pluginRoot), skills)
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
