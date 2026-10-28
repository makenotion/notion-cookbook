import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { AGENT_HOME } from "./config.ts"
import {
  type MemoryFile,
  type MemoryInventory,
  type MemorySource,
  type MemoryType,
  readSourceFile,
} from "./memories.ts"

// Claude Code's auto memory keeps one Markdown file per memory in
// ~/.claude/projects/<project>/memory/, or in one `autoMemoryDirectory` when the user set
// it, with `name`, `description`, and `type` in its frontmatter. MEMORY.md in the same
// directory is only an index of those files. Each file becomes one page, with its Markdown
// unchanged and its frontmatter `type` as the page Type.

const TYPES: Record<string, MemoryType> = {
  user: "Profile",
  feedback: "Preference",
  project: "Work",
  reference: "Notes",
}

const PROJECTS_DIR = path.join(AGENT_HOME, "projects")
// Settings files Claude Code reads, highest precedence first. `autoMemoryDirectory` is
// ignored in checked-in project settings, as Claude Code does.
const MANAGED_SETTINGS =
  process.platform === "darwin"
    ? "/Library/Application Support/ClaudeCode/managed-settings.json"
    : process.platform === "win32"
      ? "C:\\Program Files\\ClaudeCode\\managed-settings.json"
      : "/etc/claude-code/managed-settings.json"
const USER_SETTINGS = path.join(AGENT_HOME, "settings.json")
const CUSTOM_DIR = customMemoryDir()

export const claudeSource: MemorySource = {
  name: "Claude Code",
  root: CUSTOM_DIR ? "autoMemoryDirectory" : "projects",
  inventory: () => claudeMemoryInventory(CUSTOM_DIR ?? PROJECTS_DIR),
}

// Reads ~/.claude/projects/*/memory/, or a flat memory directory such as a custom
// `autoMemoryDirectory`.
export function claudeMemoryInventory(dir: string): MemoryInventory {
  const flat = listDir(dir).some((f) => f.endsWith(".md"))
  const dirs = flat
    ? [{ project: undefined, memoryDir: dir }]
    : listDir(dir).map((project) => ({
        project,
        memoryDir: path.join(dir, project, "memory"),
      }))
  const files: MemoryFile[] = []
  const unsupported: string[] = []
  for (const { project, memoryDir } of dirs) {
    for (const file of listDir(memoryDir)) {
      if (file === "MEMORY.md") continue
      if (!file.endsWith(".md")) {
        unsupported.push(
          project ? path.posix.join(project, "memory", file) : file
        )
        continue
      }
      let source
      try {
        source = readSourceFile(
          dir,
          project ? path.posix.join(project, "memory", file) : file
        )
      } catch {
        continue
      }
      // The same file name can exist in several projects, so the title names the project.
      files.push({
        ...source,
        title: project ? `${projectLabel(project)}/${file}` : file,
        type: memoryType(source.content),
      })
    }
  }
  return { files, unsupported: unsupported.sort() }
}

function customMemoryDir(): string | undefined {
  for (const file of [MANAGED_SETTINGS, USER_SETTINGS]) {
    const value = readSettings(file).autoMemoryDirectory
    if (typeof value === "string" && value.trim())
      return path.resolve(value.trim().replace(/^~(?=$|\/)/, os.homedir()))
  }
  return undefined
}

function readSettings(file: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
    return value && typeof value === "object" && !Array.isArray(value)
      ? { ...value }
      : {}
  } catch {
    return {}
  }
}

// Older memories put `type` at the top level, newer ones under `metadata`.
function memoryType(text: string): MemoryType {
  const meta = frontmatter(text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "")
  return TYPES[meta.type ?? ""] ?? "Notes"
}

// Flat `key: value` reader, enough for the frontmatter Claude Code writes. Nested keys
// such as `metadata.type` are read by their last segment.
function frontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([\w-]+):\s*(.*)$/)
    if (m && m[2]) out[m[1]] = unquote(m[2].trim())
  }
  return out
}

function unquote(value: string): string {
  if (/^".*"$/.test(value)) return value.slice(1, -1).replace(/\\(.)/g, "$1")
  if (/^'.*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'")
  return value
}

// Project directories are the working directory with every non-alphanumeric character
// replaced by "-", so "-Users-me-code-app" becomes "code-app".
function projectLabel(project: string): string {
  const home = os.homedir().replace(/[^a-zA-Z0-9]/g, "-")
  return project.startsWith(`${home}-`)
    ? project.slice(home.length + 1)
    : project
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort()
  } catch {
    return []
  }
}
