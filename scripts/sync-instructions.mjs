import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const checkMode = process.argv.includes("--check")

const GROUPS = [{ canonicalDir: "instructions/custom-blocks", kind: "worker-custom-block" }]

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

  const recipes = catalog.recipes.filter((recipe) => recipe.kind === group.kind)
  if (recipes.length === 0) {
    console.error(`No catalog recipes with kind ${JSON.stringify(group.kind)}`)
    process.exit(1)
  }

  for (const recipe of recipes) {
    for (const file of files) {
      const source = join(canonicalPath, file)
      const target = resolve(repoRoot, recipe.path, ".agents", file)
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
      : `Synced ${synced} file(s).`
)
