// Hooks may inherit an older system Node than the worker requires.
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
const file =
  process.env.NOTION_MEMORY_CONFIG || path.join(home, "notion-memory.json")
try {
  const config = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : {}
  const result = spawnSync(
    config.nodePath || process.execPath,
    [path.join(__dirname, "scripts/main.ts"), "hook", process.argv[2]],
    { stdio: "inherit" }
  )
  if (result.error) console.error(`Sync Memory hook: ${result.error.message}`)
} catch (error) {
  console.error(`Sync Memory hook: ${error.message}`)
}
