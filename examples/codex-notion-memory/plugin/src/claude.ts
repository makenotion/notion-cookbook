import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { AGENT_HOME } from "./config.ts"
import {
  type AgentMemory,
  type MemorySource,
  type MemoryType,
  personalize,
  readIfExists,
} from "./memories.ts"

// Claude Code's auto memory keeps one Markdown file per memory in
// ~/.claude/projects/<project>/memory/, with `name`, `description`, and `type` in its
// frontmatter. MEMORY.md in the same directory is only an index of those files. Each file
// is already one topic, so each becomes one Notion memory.

const TYPES: Record<string, MemoryType> = {
  user: "Profile",
  feedback: "Preference",
  project: "Work",
  reference: "Notes",
}

export const claudeSource: MemorySource = {
  name: "Claude Code",
  dir: path.join(AGENT_HOME, "projects"),
  parse: parseClaudeMemories,
  emptyHint: "has Claude Code saved any auto memories yet?",
}

export function parseClaudeMemories(
  projectsDir: string,
  userName?: string
): AgentMemory[] {
  const out: AgentMemory[] = []
  for (const project of listDir(projectsDir)) {
    const dir = path.join(projectsDir, project, "memory")
    for (const file of listDir(dir)) {
      if (!file.endsWith(".md") || file === "MEMORY.md") continue
      const memory = parseMemoryFile(readIfExists(path.join(dir, file)), file)
      if (!memory) continue
      out.push({
        ...memory,
        key: `claude:${project}/${file}`,
        content: personalize(memory.content, userName),
        from: `${projectLabel(project)} › \`${file}\``,
      })
    }
  }
  return out
}

// True when a Write or Edit from a PostToolUse hook touched an auto memory file.
export function isClaudeMemoryFile(file: string): boolean {
  const rel = path.relative(claudeSource.dir, path.resolve(file))
  const parts = rel.split(path.sep)
  return (
    parts.length === 3 &&
    parts[0] !== ".." &&
    parts[1] === "memory" &&
    parts[2].endsWith(".md") &&
    parts[2] !== "MEMORY.md"
  )
}

function parseMemoryFile(
  text: string,
  file: string
): Pick<AgentMemory, "type" | "title" | "content"> | undefined {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return undefined
  const meta = frontmatter(match[1])
  // Older memories put `type` at the top level, newer ones under `metadata`.
  const type = TYPES[meta.type ?? ""]
  const body = match[2].trim()
  if (!type || !body) return undefined
  return {
    type,
    // `name` is a topic slug such as "integration-tests-real-db"; the one-line
    // `description` is a summary, so it leads the body instead.
    title: topicTitle(meta.name || file.replace(/\.md$/, "")),
    content: meta.description ? `${meta.description}\n\n${body}` : body,
  }
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

function topicTitle(slug: string): string {
  const words = slug.replace(/^(user|feedback|project|reference)[-_]/, "")
  const text = words.replace(/[-_]+/g, " ").trim()
  return text.charAt(0).toUpperCase() + text.slice(1)
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
