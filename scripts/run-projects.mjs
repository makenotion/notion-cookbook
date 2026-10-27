import { spawn } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const stage = process.argv[2]
if (!["install", "typecheck", "test"].includes(stage)) {
  console.error("Usage: node scripts/run-projects.mjs {install|typecheck|test}")
  process.exit(2)
}

const jobsText = process.env.PROJECT_VERIFY_JOBS ?? "5"
const jobs = Number(jobsText)
if (!/^[1-9][0-9]*$/.test(jobsText) || !Number.isSafeInteger(jobs)) {
  console.error("PROJECT_VERIFY_JOBS must be a positive integer")
  process.exit(2)
}

const projectParents = [
  "examples",
  "apps/templates",
  "workers/templates",
  "workers/templates/custom-blocks",
  "workers/templates/workflows",
]
const projects = []
for (const parent of projectParents) {
  const parentPath = join(root, parent)
  if (!existsSync(parentPath)) {
    continue
  }
  for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }
    const path = join(parentPath, entry.name)
    if (!existsSync(join(path, "package.json"))) {
      continue
    }
    const name = relative(root, path)
    if (stage === "typecheck" && !existsSync(join(path, "tsconfig.json"))) {
      continue
    }
    const { scripts } = JSON.parse(
      readFileSync(join(path, "package.json"), "utf8")
    )
    if (stage === "test" && !scripts?.test) {
      console.log(`Skipping ${name} (no test script).`)
      continue
    }
    projects.push({ name, path, scripts })
  }
}

function runProject(project) {
  const args =
    stage === "install"
      ? ["install"]
      : stage === "test"
        ? ["test"]
        : project.scripts?.check
          ? ["run", "check"]
          : ["exec", "--", "tsc", "--noEmit"]

  console.log(`Running ${stage}: ${project.name}`)
  return new Promise((resolveResult) => {
    const child = spawn("npm", args, {
      cwd: project.path,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk
    })
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      output += chunk
    })
    child.on("error", (error) =>
      resolveResult({ project, error: error.message, output })
    )
    child.on("close", (code) => resolveResult({ project, code, output }))
  })
}

let nextIndex = 0
let failed = false

async function worker() {
  while (!failed && nextIndex < projects.length) {
    const { project, code, error, output } = await runProject(
      projects[nextIndex++]
    )
    if (code === 0) {
      console.log(`Passed ${stage}: ${project.name}`)
    } else {
      console.error(`Failed ${stage}: ${project.name}`)
      console.error(error ?? output)
      failed = true
    }
  }
}

await Promise.all(
  Array.from({ length: Math.min(jobs, projects.length) }, worker)
)
if (failed) {
  process.exitCode = 1
}
