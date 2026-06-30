import { access, readFile, readdir, stat } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const errors = []

function report(message) {
  errors.push(message)
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    report(`${label} is not valid JSON: ${error.message}`)
    return null
  }
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function findProjects() {
  const projects = new Map()

  for (const root of ["examples", "workers"]) {
    const rootPath = resolve(repoRoot, root)
    const entries = await readdir(rootPath, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const projectPath = `${root}/${entry.name}`
      const packagePath = resolve(rootPath, entry.name, "package.json")
      if (!(await isFile(packagePath))) continue

      const packageJson = await readJson(
        packagePath,
        `${projectPath}/package.json`
      )
      projects.set(projectPath, packageJson)

      const expectedName = `@notion-cookbook/${entry.name}`
      if (packageJson && packageJson.name !== expectedName) {
        report(
          `${projectPath}/package.json: name must be ${JSON.stringify(expectedName)}`
        )
      }
      if (packageJson && packageJson.private !== true) {
        report(`${projectPath}/package.json: private must be true`)
      }

      if (!(await isFile(resolve(rootPath, entry.name, "README.md")))) {
        report(`${projectPath}: missing README.md`)
      }
    }
  }

  return projects
}

function requireString(recipe, field, label) {
  if (typeof recipe[field] !== "string" || recipe[field].trim() === "") {
    report(`${label}.${field} must be a non-empty string`)
    return null
  }
  return recipe[field]
}

function expectedKind(path, id) {
  if (path.startsWith("examples/")) return "api-example"
  if (id.endsWith("-sync")) return "worker-sync"
  if (id.endsWith("-webhook")) return "worker-webhook"
  return "worker-tool"
}

function validateNpmScripts(command, scripts, label) {
  for (const match of command.matchAll(/\bnpm\s+run\s+(?:--\s+)?([\w:.-]+)/g)) {
    const script = match[1]
    if (typeof scripts?.[script] !== "string") {
      report(
        `${label} references missing package script ${JSON.stringify(script)}`
      )
    }
  }

  for (const match of command.matchAll(
    /\bnpm\s+(test|start|stop|restart)\b/g
  )) {
    const script = match[1]
    if (typeof scripts?.[script] !== "string") {
      report(
        `${label} references missing package script ${JSON.stringify(script)}`
      )
    }
  }
}

async function validateRecipe(recipe, index, projects, readme, ids, paths) {
  const label = `catalog.json recipes[${index}]`
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) {
    report(`${label} must be an object`)
    return
  }

  const id = requireString(recipe, "id", label)
  requireString(recipe, "title", label)
  requireString(recipe, "summary", label)
  const path = requireString(recipe, "path", label)
  const kind = requireString(recipe, "kind", label)
  const status = requireString(recipe, "status", label)
  const language = requireString(recipe, "language", label)
  const runtime = requireString(recipe, "runtime", label)

  if (!id || !path) return

  if (ids.has(id)) report(`${label}.id duplicates ${JSON.stringify(id)}`)
  else ids.add(id)

  if (paths.has(path))
    report(`${label}.path duplicates ${JSON.stringify(path)}`)
  else paths.add(path)

  const pathParts = path.split("/")
  if (
    pathParts.length !== 2 ||
    !["examples", "workers"].includes(pathParts[0]) ||
    pathParts[1] !== id
  ) {
    report(`${label}.path must be examples/${id} or workers/${id}`)
  }

  const allowedKinds = new Set([
    "api-example",
    "worker-sync",
    "worker-tool",
    "worker-webhook",
  ])
  if (!allowedKinds.has(kind)) {
    report(`${label}.kind is invalid: ${JSON.stringify(kind)}`)
  } else if (kind !== expectedKind(path, id)) {
    report(`${label}.kind must be ${JSON.stringify(expectedKind(path, id))}`)
  }

  if (status !== "ready") report(`${label}.status must be "ready"`)
  if (language !== "typescript") {
    report(`${label}.language must be "typescript"`)
  }
  if (runtime !== "node") report(`${label}.runtime must be "node"`)

  if (!Array.isArray(recipe.integrations) || recipe.integrations.length === 0) {
    report(`${label}.integrations must be a non-empty array`)
  } else {
    const integrations = new Set()
    for (const integration of recipe.integrations) {
      if (
        typeof integration !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(integration)
      ) {
        report(`${label}.integrations contains an invalid lowercase slug`)
      } else if (integrations.has(integration)) {
        report(
          `${label}.integrations duplicates ${JSON.stringify(integration)}`
        )
      } else {
        integrations.add(integration)
      }
    }
  }

  const project = projects.get(path)
  if (!project) {
    report(`${label}.path does not identify a package-backed project: ${path}`)
  }

  if (!Array.isArray(recipe.entrypoints) || recipe.entrypoints.length === 0) {
    report(`${label}.entrypoints must be a non-empty array`)
  } else if (project) {
    const projectRoot = resolve(repoRoot, path)
    for (const entrypoint of recipe.entrypoints) {
      if (typeof entrypoint !== "string" || entrypoint.trim() === "") {
        report(`${label}.entrypoints must contain non-empty strings`)
        continue
      }

      const entrypointPath = resolve(projectRoot, entrypoint)
      if (
        !entrypointPath.startsWith(`${projectRoot}${sep}`) ||
        !(await isFile(entrypointPath))
      ) {
        report(`${label}.entrypoints file does not exist: ${entrypoint}`)
      }
    }
  }

  const allowedCommands = new Set([
    "install",
    "run",
    "check",
    "test",
    "build",
    "deploy",
  ])
  if (
    !recipe.commands ||
    typeof recipe.commands !== "object" ||
    Array.isArray(recipe.commands)
  ) {
    report(`${label}.commands must be an object`)
  } else {
    if (recipe.commands.install !== "npm install") {
      report(`${label}.commands.install must be "npm install"`)
    }

    for (const [name, command] of Object.entries(recipe.commands)) {
      if (!allowedCommands.has(name)) {
        report(`${label}.commands has unsupported key ${JSON.stringify(name)}`)
      }
      if (typeof command !== "string" || command.trim() === "") {
        report(`${label}.commands.${name} must be a non-empty string`)
      } else if (project) {
        validateNpmScripts(
          command,
          project.scripts,
          `${label}.commands.${name}`
        )
      }
    }
  }

  if (!readme.includes(`(${path}/)`)) {
    report(`README.md must link directly to ${path}/`)
  }
}

async function main() {
  const catalog = await readJson(
    resolve(repoRoot, "catalog.json"),
    "catalog.json"
  )
  const readmePath = resolve(repoRoot, "README.md")
  let readme = ""
  try {
    await access(readmePath)
    readme = await readFile(readmePath, "utf8")
  } catch (error) {
    report(`README.md could not be read: ${error.message}`)
  }

  const projects = await findProjects()
  if (catalog) {
    if (catalog.version !== 1) report("catalog.json.version must be 1")
    if (!Array.isArray(catalog.recipes)) {
      report("catalog.json.recipes must be an array")
    } else {
      const ids = new Set()
      const paths = new Set()
      for (const [index, recipe] of catalog.recipes.entries()) {
        await validateRecipe(recipe, index, projects, readme, ids, paths)
      }

      for (const projectPath of projects.keys()) {
        if (!paths.has(projectPath)) {
          report(
            `catalog.json is missing package-backed project ${projectPath}`
          )
        }
      }

      for (const recipePath of paths) {
        if (!projects.has(recipePath)) {
          report(`catalog.json contains non-project path ${recipePath}`)
        }
      }
    }
  }

  if (errors.length > 0) {
    console.error(`Catalog validation failed with ${errors.length} error(s):`)
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
    return
  }

  console.log(`Catalog validation passed for ${projects.size} projects.`)
}

await main()
