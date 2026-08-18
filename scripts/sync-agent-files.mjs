// Rewrites every worker template's `.agents/` from a canonical file set. Each
// `worker-*` recipe in `catalog.json` gets DEFAULT_GROUP unless its kind is
// listed in OVERRIDE_GROUPS, so a new kind inherits the default instead of
// being silently skipped. Sync deletes `.agents/` and copies the set back, so a
// renamed or removed canonical file needs no special handling. `--dryRun` writes
// nothing and exits non-zero when a template's copies differ from its set.

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
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const isDryRun = process.argv.includes("--dryRun")

const AGENTS_ROOT = "workers/agents"
const INSTRUCTIONS_ROOT = `${AGENTS_ROOT}/instructions`

// This script deletes each template's `.agents/` before rewriting it, and the
// directory it deletes comes from `catalog.json`. A path such as `../../..`
// would resolve outside the repository, so every recipe path is confined to
// this root before anything is removed.
const TEMPLATES_ROOT = "workers/templates"

// Skills live in one shared pool. A group names the ones it ships, so an
// override can spread the defaults instead of repeating them.
const SKILLS_ROOT = `${AGENTS_ROOT}/skills`
const DEFAULT_SKILLS = [
  "auth-guide",
  "sync",
  "sync-debug",
  "sync-guide",
  "sync-validate",
]

const DEFAULT_GROUP = {
  instructions: `${INSTRUCTIONS_ROOT}/default`,
  skills: DEFAULT_SKILLS,
}

// A catalog kind listed here takes its agent files from this group instead of
// DEFAULT_GROUP. Custom blocks are a private alpha capability, so their
// templates document what the default set tells agents not to use. `instructions`
// replaces the default set and is never merged; `skills` spreads the defaults
// because a custom-block template can still declare a sync.
const OVERRIDE_GROUPS = {
  "worker-custom-block": {
    instructions: `${INSTRUCTIONS_ROOT}/custom-blocks`,
    skills: [...DEFAULT_SKILLS, "custom-blocks"],
  },
}

const AGENT_SYMLINKS = [
  { name: "AGENTS.md", target: ".agents/INSTRUCTIONS.md" },
  { name: "CLAUDE.md", target: ".agents/INSTRUCTIONS.md" },
]

// Copied to every worker template root, whatever the recipe's group, so no
// group can drop one. Unlike `.agents/`, the template root is never deleted, so
// removing a file here leaves the stale per-template copies behind for a
// follow-up commit to clean up.
const ROOT_FILES_ROOT = `${AGENTS_ROOT}/root-files`

// Returns [] when the directory is absent, so a template with no `.agents/`
// reads as empty rather than throwing.
async function collectFiles(dir, prefix = "") {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files = []
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

// Resolve and confine every recipe path up front, so a path that escapes the
// templates root fails before the first delete rather than partway through.
const templatesRoot = resolve(repoRoot, TEMPLATES_ROOT)
const recipeRoots = new Map()
for (const recipe of workerRecipes) {
  const recipeRoot = resolve(repoRoot, recipe.path)
  if (!recipeRoot.startsWith(templatesRoot + sep)) {
    fail(
      `Recipe ${JSON.stringify(recipe.id)} has path ${JSON.stringify(recipe.path)}, which resolves outside ${TEMPLATES_ROOT}/`
    )
  }
  recipeRoots.set(recipe, recipeRoot)
}

const kinds = new Set(workerRecipes.map((recipe) => recipe.kind))
for (const [kind, group] of Object.entries(OVERRIDE_GROUPS)) {
  if (!kinds.has(kind)) {
    fail(
      `OVERRIDE_GROUPS lists kind ${JSON.stringify(kind)}, which no recipe uses`
    )
  }
  if (!group.instructions) {
    fail(`OVERRIDE_GROUPS entry ${JSON.stringify(kind)} has no instructions`)
  }
}

// Keyed by the group object, so two kinds sharing one instruction set still
// get separate entries once groups differ in other fields.
const groups = new Map()
for (const recipe of workerRecipes) {
  const config = OVERRIDE_GROUPS[recipe.kind] ?? DEFAULT_GROUP
  const group = groups.get(config)
  if (group) group.recipes.push(recipe)
  else groups.set(config, { config, recipes: [recipe] })
}

const rootFilesPath = resolve(repoRoot, ROOT_FILES_ROOT)
const rootFiles = new Map()
for (const file of await collectFiles(rootFilesPath)) {
  rootFiles.set(file, await readFile(join(rootFilesPath, file), "utf8"))
}
if (rootFiles.size === 0) {
  fail(`No canonical files found in ${ROOT_FILES_ROOT}`)
}

const drifted = []
let rewritten = 0

for (const group of groups.values()) {
  const instructionsDir = group.config.instructions
  const canonicalPath = resolve(repoRoot, instructionsDir)
  const files = await collectFiles(canonicalPath)
  if (files.length === 0) {
    fail(`No canonical files found in ${instructionsDir}`)
  }

  // Every file this group's templates should hold, keyed by its path inside
  // `.agents/`. Instructions land at the root; each skill lands under `skills/`.
  const contents = new Map()
  for (const file of files) {
    contents.set(file, await readFile(join(canonicalPath, file), "utf8"))
  }
  for (const skill of group.config.skills ?? []) {
    const skillPath = resolve(repoRoot, SKILLS_ROOT, skill)
    const skillFiles = await collectFiles(skillPath)
    for (const file of skillFiles) {
      contents.set(
        join("skills", skill, file),
        await readFile(join(skillPath, file), "utf8")
      )
    }
  }

  for (const recipe of group.recipes) {
    const agentsRoot = join(recipeRoots.get(recipe), ".agents")

    if (isDryRun) {
      for (const file of await collectFiles(agentsRoot)) {
        if (!contents.has(file)) {
          drifted.push(
            `${relative(repoRoot, join(agentsRoot, file))} (not in this group's config)`
          )
        }
      }
      for (const [file, expected] of contents) {
        const target = join(agentsRoot, file)
        if ((await readIfExists(target)) !== expected) {
          drifted.push(relative(repoRoot, target))
        }
      }
    } else {
      await rm(agentsRoot, { recursive: true, force: true })
      for (const [file, expected] of contents) {
        const target = join(agentsRoot, file)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, expected)
      }
      rewritten += 1
    }

    for (const link of AGENT_SYMLINKS) {
      const linkPath = join(recipeRoots.get(recipe), link.name)
      if (isDryRun) {
        const stat = await lstat(linkPath).catch(() => null)
        const current = stat?.isSymbolicLink() ? await readlink(linkPath) : null
        if (current !== link.target) {
          drifted.push(
            `${relative(repoRoot, linkPath)} (not a symlink to ${link.target})`
          )
        }
        continue
      }
      await rm(linkPath, { force: true })
      await symlink(link.target, linkPath)
    }

    for (const [file, expected] of rootFiles) {
      const target = join(recipeRoots.get(recipe), file)
      if (isDryRun) {
        if ((await readIfExists(target)) !== expected) {
          drifted.push(relative(repoRoot, target))
        }
        continue
      }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, expected)
    }
  }
}

if (isDryRun) {
  if (drifted.length > 0) {
    console.error(`Template agent files drifted from ${AGENTS_ROOT}/:`)
    for (const file of drifted) {
      console.error(`  ${file}`)
    }
    console.error("Run `npm run agents:sync` and commit the result.")
    process.exit(1)
  }
  console.log(`Template agent files match ${AGENTS_ROOT}/.`)
} else {
  console.log(`Rewrote .agents/ for ${rewritten} template(s).`)
}
