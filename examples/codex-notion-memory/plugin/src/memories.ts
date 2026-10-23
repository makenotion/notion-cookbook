import crypto from "node:crypto"
import fs from "node:fs"
import { loadState, log, saveState } from "./config.ts"
import type { NotionClient, PageResponse } from "./notion.ts"

// Mirrors an agent's own memories into the user's Notion Memories. Each agent has a
// MemorySource that parses its memory files (codex.ts, claude.ts); the import, the
// state file, and edit protection are shared.

export type MemoryType = "Profile" | "Preference" | "Work" | "Notes"

export interface AgentMemory {
  // Stable identity across rewrites of the same memory.
  key: string
  type: MemoryType
  title: string
  content: string
  from: string
}

export interface MemorySource {
  // Value of the Source property in Notion Memories.
  name: "Codex" | "Claude Code"
  dir: string
  parse(dir: string): AgentMemory[]
  // Logged when the source has no memories.
  emptyHint: string
}

export interface MemorySyncResult {
  total: number
  created: number
  updated: number
  removed: number
  skippedEdited: number
}

export async function syncMemories(
  client: NotionClient,
  source: MemorySource
): Promise<MemorySyncResult> {
  const memories = source.parse(source.dir)
  const result: MemorySyncResult = {
    total: memories.length,
    created: 0,
    updated: 0,
    removed: 0,
    skippedEdited: 0,
  }
  if (!memories.length) {
    log("memories: none found in", source.dir, `(${source.emptyHint})`)
    return result
  }
  const state = loadState()
  const live = new Set<string>()
  for (const memory of memories) {
    const key = sha1(memory.key)
    const hash = sha1(memory.content)
    live.add(key)
    const prev = state.memories[key]
    if (prev?.hash === hash) continue
    if (prev?.pageId) {
      if (await editedInNotion(client, prev.pageId, prev.lastEditedTime)) {
        state.memories[key] = { ...prev, hash }
        saveState(state)
        result.skippedEdited++
        continue
      }
      await client.trashPage(prev.pageId)
      result.updated++
    } else {
      result.created++
    }
    const page = await createMemoryPage(client, source, memory)
    state.memories[key] = {
      hash,
      title: memory.title,
      type: memory.type,
      pageId: page?.id,
      lastEditedTime: page?.last_edited_time,
    }
    saveState(state)
  }
  for (const [key, prev] of Object.entries(state.memories)) {
    if (live.has(key)) continue
    if (
      prev.pageId &&
      !(await editedInNotion(client, prev.pageId, prev.lastEditedTime))
    ) {
      await client.trashPage(prev.pageId)
      result.removed++
    }
    delete state.memories[key]
  }
  saveState(state)
  log(`memories: ${JSON.stringify(result)}`)
  return result
}

async function createMemoryPage(
  client: NotionClient,
  source: MemorySource,
  memory: AgentMemory
): Promise<PageResponse | undefined> {
  // `parent: "memory"` writes to the token owner's Notion Memories database.
  const res = await client.request<{ pages?: { id: string }[] }>(
    "POST",
    "/v1/tools/run",
    {
      type: "create_pages",
      create_pages: {
        parent: "memory",
        allow_async: false,
        pages: [
          {
            properties: {
              title: memory.title,
              Type: memory.type,
              Source: source.name,
            },
            content: `${memory.content}\n\n(Imported from ${source.name} memories: ${memory.from})`,
          },
        ],
      },
    }
  )
  const id = res.pages?.[0]?.id
  return id ? client.getPage(id) : undefined
}

async function editedInNotion(
  client: NotionClient,
  pageId: string,
  lastEditedTime: string | undefined
): Promise<boolean> {
  const page = await client.getPage(pageId).catch((e: Error) => {
    log("memories: could not read", pageId, e.message)
    return undefined
  })
  if (!page || page.in_trash) return false
  const edited = Boolean(
    lastEditedTime &&
      page.last_edited_time &&
      page.last_edited_time !== lastEditedTime
  )
  if (edited)
    log("memories: keeping", pageId, "because it was edited in Notion")
  return edited
}

export function titleFrom(text: string): string {
  const t = text
    .replace(/\s*\[Task \d+\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[“"]([^”"]+)[”"]\.?$/, "$1")
  const title = t.charAt(0).toUpperCase() + t.slice(1)
  return title.length > 90 ? `${title.slice(0, 87)}…` : title
}

export function readIfExists(file: string): string {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

export function sha1(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex")
}
