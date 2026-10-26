import crypto from "node:crypto"
import { loadState, log, saveState } from "./config.ts"
import type { CallTool } from "./mcp.ts"

// Mirrors an agent's memory files into the user's Notion Memories with the same Notion MCP
// tools any agent uses. One source file becomes one page, and its Markdown passes through
// unchanged. Each agent has a MemorySource that lists its own files (codex.ts, claude.ts).

export type MemoryType = "Profile" | "Preference" | "Work" | "Notes"

export interface MemoryFile {
  // Stable state key, unique within the agent.
  key: string
  title: string
  type: MemoryType
  content: string
  hash: string
}

export interface MemorySource {
  // Agent name: the Source and Last updated by option on the pages it writes.
  name: "Codex" | "Claude Code"
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
    const previous = state.files[file.key]
    if (previous?.released) {
      result.changedInNotion++
      continue
    }
    if (previous?.hash === file.hash) {
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
      await call("update-page", {
        page_id: previous.pageId,
        command: "update_properties",
        properties: { "Last updated by": source.name },
      })
      await call("update-page", {
        page_id: previous.pageId,
        command: "replace_content",
        new_str: file.content,
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
            content: file.content,
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
    state.files[file.key] = {
      pageId,
      hash: file.hash,
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
    const entry = state.files[file.key]
    if (!entry || entry.released || entry.hash !== file.hash)
      throw new Error(`Unsynced file: ${file.title}`)
    const page = await snapshot(call, entry.pageId)
    if (page.deleted || page.hash !== entry.pageHash)
      throw new Error(`Page changed: ${file.title}`)
  }
  return { verified: files.length }
}

export function memoryFilesHash(source: MemorySource): string {
  return digest(
    JSON.stringify(source.files().map(({ key, hash }) => [key, hash]))
  )
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
