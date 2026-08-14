// Copies a canonical agent file set into every worker template's `.agents/`.
// Every `worker-*` recipe in `catalog.json` gets DEFAULT_GROUP unless its kind
// is listed in OVERRIDE_GROUPS, so a new kind inherits the default instead of
// being silently skipped. The per-template copies are generated, so hand edits
// there are overwritten; edit the canonical files instead. `--check` exits
// non-zero on drift so CI and the pre-commit hook catch copies that were edited
// or never regenerated.

import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const checkMode = process.argv.includes("--check")

const CANONICAL_ROOT = "workers/agents"
const DEFAULT_GROUP = `${CANONICAL_ROOT}/default`

// A catalog kind listed here takes its agent files from the named directory
// instead of DEFAULT_GROUP. Custom blocks are a private alpha capability, so
// their templates document what the default set tells agents not to use.
const OVERRIDE_GROUPS = {
  "worker-custom-block": `${CANONICAL_ROOT}/custom-blocks`,
}

const ENTRY_LINKS = [
  { name: "AGENTS.md", target: ".agents/INSTRUCTIONS.md" },
  { name: "CLAUDE.md", target: ".agents/INSTRUCTIONS.md" },
]

async function collectFiles(dir, prefix = "") {
  const files = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const relPath = join(prefix, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(join(dir, entry.name), relPath)))
    } else {
      files.push(relPath)
    }
  }
  return files.sort()
}

async function readIfExists(path) {
  try {
    return await readFile(path, "utf8")
  } catch {
    return null
  }
}

async function lstatIfExists(path) {
  try {
    return await lstat(path)
  } catch {
    return null
  }
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

const catalog = JSON.parse(
  await readFile(resolve(repoRoot, "catalog.json"), "utf8")
)

const workerRecipes = catalog.recipes.filter((recipe) =>
  recipe.kind.startsWith("worker-")
)
if (workerRecipes.length === 0) {
  fail("No catalog recipes with a worker- kind")
}

const kinds = new Set(workerRecipes.map((recipe) => recipe.kind))
for (const kind of Object.keys(OVERRIDE_GROUPS)) {
  if (!kinds.has(kind)) {
    fail(
      `OVERRIDE_GROUPS lists kind ${JSON.stringify(kind)}, which no recipe uses`
    )
  }
}

// One entry per canonical directory, so each group's files are read once.
const groups = new Map()
for (const recipe of workerRecipes) {
  const canonicalDir = OVERRIDE_GROUPS[recipe.kind] ?? DEFAULT_GROUP
  const group = groups.get(canonicalDir)
  if (group) group.recipes.push(recipe)
  else groups.set(canonicalDir, { canonicalDir, recipes: [recipe] })
}

let drifted = []
let synced = 0

for (const group of groups.values()) {
  const canonicalPath = resolve(repoRoot, group.canonicalDir)
  let files
  try {
    files = await collectFiles(canonicalPath)
  } catch {
    fail(`Canonical directory ${group.canonicalDir} does not exist`)
  }
  if (files.length === 0) {
    fail(`No canonical files found in ${group.canonicalDir}`)
  }

  // Directories that appear in the canonical set. The sweep only deletes
  // inside these, so template-specific files elsewhere in .agents/ survive.
  const managedDirs = new Set(
    files.map((file) => dirname(file)).filter((dir) => dir !== ".")
  )
  const canonicalSet = new Set(files)

  for (const recipe of group.recipes) {
    const agentsRoot = resolve(repoRoot, recipe.path, ".agents")

    for (const file of files) {
      const source = join(canonicalPath, file)
      const target = join(agentsRoot, file)
      const expected = await readFile(source, "utf8")
      const actual = await readIfExists(target)
      if (actual === expected) continue

      if (checkMode) {
        drifted.push(relative(repoRoot, target))
      } else {
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, expected)
        console.log(`synced ${relative(repoRoot, target)}`)
        synced += 1
      }
    }

    for (const managedDir of managedDirs) {
      const targetDir = join(agentsRoot, managedDir)
      let entries
      try {
        entries = await readdir(targetDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.isDirectory()) continue
        const relPath = join(managedDir, entry.name)
        if (canonicalSet.has(relPath)) continue
        const stale = join(agentsRoot, relPath)
        if (checkMode) {
          drifted.push(`${relative(repoRoot, stale)} (stale, not in canonical)`)
        } else {
          await rm(stale)
          console.log(`removed ${relative(repoRoot, stale)}`)
          synced += 1
        }
      }
    }

    for (const link of ENTRY_LINKS) {
      const linkPath = resolve(repoRoot, recipe.path, link.name)
      const stat = await lstatIfExists(linkPath)
      const current = stat?.isSymbolicLink() ? await readlink(linkPath) : null
      if (current === link.target) continue
      if (checkMode) {
        drifted.push(
          `${relative(repoRoot, linkPath)} (not a symlink to ${link.target})`
        )
        continue
      }
      if (stat) await rm(linkPath)
      await symlink(link.target, linkPath)
      console.log(`linked ${relative(repoRoot, linkPath)} -> ${link.target}`)
      synced += 1
    }
  }
}

if (checkMode && drifted.length > 0) {
  console.error(`Template agent files drifted from ${CANONICAL_ROOT}/:`)
  for (const file of drifted) {
    console.error(`  ${file}`)
  }
  console.error("Run `npm run agents:sync` and commit the result.")
  process.exit(1)
}

console.log(
  checkMode
    ? `Template agent files match ${CANONICAL_ROOT}/.`
    : synced === 0
      ? "Template agent files already up to date."
      : `Synced ${synced} change(s).`
)
