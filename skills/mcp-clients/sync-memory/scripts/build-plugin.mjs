import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const skill = fileURLToPath(new URL("../", import.meta.url))

/** @param {string} destination */
export function buildPlugin(destination) {
  const root = path.resolve(destination)
  fs.rmSync(root, { recursive: true, force: true })
  const bundledSkill = path.join(root, "skills/sync-memory")
  fs.mkdirSync(path.join(root, ".codex-plugin"), { recursive: true })
  fs.mkdirSync(path.join(bundledSkill, "scripts"), { recursive: true })
  fs.copyFileSync(
    path.join(skill, ".codex-plugin/plugin.json"),
    path.join(root, ".codex-plugin/plugin.json")
  )
  for (const name of ["SKILL.md", ".mcp.json"]) {
    fs.copyFileSync(path.join(skill, name), path.join(bundledSkill, name))
  }
  const metadata = JSON.parse(
    fs.readFileSync(path.join(skill, "package.json"), "utf8")
  )
  delete metadata.scripts
  delete metadata.devDependencies
  fs.writeFileSync(
    path.join(bundledSkill, "package.json"),
    JSON.stringify(metadata, null, 2) + "\n"
  )
  for (const name of fs
    .readdirSync(path.join(skill, "scripts"))
    .filter((name) => name.endsWith(".ts"))) {
    fs.copyFileSync(
      path.join(skill, "scripts", name),
      path.join(bundledSkill, "scripts", name)
    )
  }
  return root
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(buildPlugin(path.resolve(skill, "../../../build/sync-memory")))
}
