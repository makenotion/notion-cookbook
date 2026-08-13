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

const GROUPS = [
  {
    canonicalDir: "instructions/custom-blocks",
    kinds: ["worker-custom-block"],
  },
  {
    canonicalDir: "instructions/default",
    kinds: ["worker-template", "worker-sync", "worker-tool", "worker-webhook"],
  },
]

const ENTRY_LINKS = [
  { name: "AGENTS.md", target: ".agents/INSTRUCTIONS.md" },
  { name: "CLAUDE.md", target: ".agents/INSTRUCTIONS.md" },
  { name: ".claude/skills", target: "../.agents/skills" },
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

const catalog = JSON.parse(
  await readFile(resolve(repoRoot, "catalog.json"), "utf8")
)

let drifted = []
let synced = 0

for (const group of GROUPS) {
  const canonicalPath = resolve(repoRoot, group.canonicalDir)
  const files = await collectFiles(canonicalPath)
  if (files.length === 0) {
    console.error(`No canonical files found in ${group.canonicalDir}`)
    process.exit(1)
  }

  const recipes = catalog.recipes.filter((recipe) =>
    group.kinds.includes(recipe.kind)
  )
  if (recipes.length === 0) {
    console.error(
      `No catalog recipes with kinds ${JSON.stringify(group.kinds)}`
    )
    process.exit(1)
  }

  // Directories that appear in the canonical set. The sweep only deletes
  // inside these, so template-specific files elsewhere in .agents/ survive.
  const managedDirs = new Set(
    files.map((file) => dirname(file)).filter((dir) => dir !== ".")
  )
  const canonicalSet = new Set(files)

  for (const recipe of recipes) {
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
      if (stat) await rm(linkPath, { recursive: true })
      await mkdir(dirname(linkPath), { recursive: true })
      await symlink(link.target, linkPath)
      console.log(`linked ${relative(repoRoot, linkPath)} -> ${link.target}`)
      synced += 1
    }
  }
}

if (checkMode && drifted.length > 0) {
  console.error("Template instructions drifted from instructions/:")
  for (const file of drifted) {
    console.error(`  ${file}`)
  }
  console.error("Run `npm run instructions:sync` and commit the result.")
  process.exit(1)
}

console.log(
  checkMode
    ? "Template instructions match instructions/."
    : synced === 0
      ? "Template instructions already up to date."
      : `Synced ${synced} change(s).`
)
