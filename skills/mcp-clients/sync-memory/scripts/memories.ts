import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { loadState, log, saveState } from "./config.ts"
import type { CallTool } from "./mcp.ts"

// Mirrors an agent's memory files into the user's Notion Memories with the same Notion MCP
// tools any agent uses. One source file becomes one page, and its Markdown passes through
// unchanged after a source metadata preamble. Each agent has a MemorySource that lists
// its own files (codex.ts, claude.ts).

export type MemoryType = "Profile" | "Preference" | "Work" | "Notes"

export interface SourceFile {
  // Path relative to the source root with `/` separators: the state key and Source path.
  name: string
  content: string
  hash: string
  createdAt: string | null
  updatedAt: string
  metadataHash: string
}

export interface MemoryFile extends SourceFile {
  title: string
  type: MemoryType
}

export interface MemorySource {
  // Agent name: the Source and Last updated by option on the pages it writes.
  name: "Codex" | "Claude Code"
  // Source root named in the preamble. Never an absolute path.
  root: string
  // Read on every sync, because the agent's memory files can change between syncs.
  files(): MemoryFile[]
}

export async function syncMemories(call: CallTool, source: MemorySource) {
  const files = source.files()
  const state = loadState()
  const result = {
    total: files.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    changedInNotion: 0,
  }
  for (const file of files) {
    const previous = state.files[file.name]
    if (previous?.released) {
      result.changedInNotion++
      continue
    }
    if (
      previous?.hash === file.hash &&
      previous.metadataHash === file.metadataHash
    ) {
      result.unchanged++
      continue
    }
    let pageId: string
    if (previous) {
      const page = await snapshot(call, previous.pageId)
      if (page.deleted || page.hash !== previous.pageHash) {
        previous.released = true
        saveState(state)
        result.changedInNotion++
        continue
      }
    }
    const content = renderMemory(source, file, new Date().toISOString())
    if (previous) {
      await call("update-page", {
        page_id: previous.pageId,
        command: "update_properties",
        properties: { "Last updated by": source.name },
      })
      await call("update-page", {
        page_id: previous.pageId,
        command: "replace_content",
        new_str: content,
      })
      pageId = previous.pageId
      result.updated++
    } else {
      const result = await call("create-pages", {
        parent: "memory",
        pages: [
          {
            properties: {
              title: file.title,
              Type: file.type,
              Source: source.name,
              "Last updated by": source.name,
            },
            content,
          },
        ],
      })
      if (!isObject(result) || !Array.isArray(result.pages))
        throw new Error("create-pages returned no pages")
      const page: unknown = result.pages[0]
      if (!isObject(page) || typeof page.id !== "string")
        throw new Error("create-pages returned no page ID")
      pageId = page.id
    }
    if (!previous) result.created++
    state.files[file.name] = {
      pageId,
      hash: file.hash,
      metadataHash: file.metadataHash,
      pageHash: (await snapshot(call, pageId)).hash,
    }
    saveState(state)
  }
  log("memories:", result)
  return result
}

export async function verifyMemories(call: CallTool, source: MemorySource) {
  const files = source.files()
  const state = loadState()
  for (const file of files) {
    const entry = state.files[file.name]
    if (
      !entry ||
      entry.released ||
      entry.hash !== file.hash ||
      entry.metadataHash !== file.metadataHash
    )
      throw new Error(`Unsynced file: ${file.title}`)
    const page = await snapshot(call, entry.pageId)
    if (page.deleted || page.hash !== entry.pageHash)
      throw new Error(`Page changed: ${file.title}`)
  }
  return { verified: files.length }
}

export function memoryFilesHash(source: MemorySource): string {
  return digest(
    JSON.stringify(
      source
        .files()
        .map(({ name, hash, metadataHash }) => [name, hash, metadataHash])
    )
  )
}

// Reads one source file with the timestamps its preamble reports.
export function readSourceFile(root: string, name: string): SourceFile {
  const file = path.join(root, name)
  const content = fs.readFileSync(file, "utf8")
  const stat = fs.statSync(file)
  const createdAt = sourceCreatedAt(stat.birthtimeMs)
  const updatedAt = stat.mtime.toISOString()
  return {
    name,
    content,
    hash: digest(content),
    createdAt,
    updatedAt,
    metadataHash: digest(JSON.stringify([createdAt, updatedAt])),
  }
}

// Birth time when the filesystem reports one. Never falls back to ctime.
export function sourceCreatedAt(birthtimeMs: number): string | null {
  const date = new Date(birthtimeMs)
  return birthtimeMs > 0 && Number.isFinite(date.getTime())
    ? date.toISOString()
    : null
}

export function renderMemory(
  source: MemorySource,
  file: SourceFile,
  syncedAt: string
): string {
  const metadata = {
    Source: source.name,
    "Source root": source.root,
    "Source path": file.name,
    "Source created at": file.createdAt,
    "Source updated at": file.updatedAt,
    "Synced at": syncedAt,
    "Synced by": "notion-memory",
  }
  return `# ${source.name} memory source\n\n\`\`\`json\n${JSON.stringify(metadata, null, 2)}\n\`\`\`\n\n---\n\n${file.content}`
}

export function digest(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex")
}

async function snapshot(call: CallTool, id: string) {
  const result = await call("fetch", { id })
  if (!isObject(result) || typeof result.text !== "string")
    throw new Error("Invalid page readback")
  const text = result.text
  const properties: unknown = JSON.parse(
    text.match(/<properties>\s*([\s\S]*?)\s*<\/properties>/)?.[1] ?? "{}"
  )
  if (!isObject(properties)) throw new Error("Invalid page properties")
  const start = text.indexOf("<content>")
  const end = text.lastIndexOf("</content>")
  if (start < 0 || end < start) throw new Error("Missing page content frame")
  const content = text.slice(start + "<content>".length, end).trim()
  return {
    deleted: /<page\b[^>]*\sdeleted\b/.test(text),
    hash: digest(
      JSON.stringify([
        properties.Title ?? properties.title,
        properties.Type,
        content,
      ])
    ),
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
