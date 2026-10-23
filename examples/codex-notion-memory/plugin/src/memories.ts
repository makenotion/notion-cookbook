import crypto from "node:crypto"
import fs from "node:fs"
import { loadState, log, saveState } from "./config.ts"
import type { CallTool } from "./mcp.ts"

// Writes an agent's memories to the user's Notion Memories with the same Notion MCP tools
// any agent uses, following the Notion memory guide (notion://docs/memory): one topic per
// memory, a topic title, a Type, details in the body, and no Source property. Each agent
// has a MemorySource that parses its own memory files (codex.ts, claude.ts).

export type MemoryType = "Profile" | "Preference" | "Work" | "Notes"

export interface AgentMemory {
  key: string
  type: MemoryType
  title: string
  content: string
  from: string
}

export interface MemorySource {
  // Agent name, used in the memory body and the revision title.
  name: "Codex" | "Claude Code"
  dir: string
  // Pure: reads the memory files in `dir` and returns one memory per topic.
  parse(dir: string, userName?: string): AgentMemory[]
  // Logged when the source has no memories.
  emptyHint: string
}

export interface MemorySyncResult {
  total: number
  created: number
  updated: number
  unchanged: number
  changedInNotion: number
  skippedExisting: number
  noLongerInAgent: number
}

// Writes changed agent memories to the user's Notion Memories through Notion MCP.
export async function syncMemories(
  callTool: CallTool,
  source: MemorySource
): Promise<MemorySyncResult> {
  const state = loadState()
  if (source.parse(source.dir).length)
    state.userName ??= await userName(callTool)
  const memories = source.parse(source.dir, state.userName)
  const result: MemorySyncResult = {
    total: memories.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    changedInNotion: 0,
    skippedExisting: 0,
    noLongerInAgent: 0,
  }
  if (!memories.length) {
    log("memories: none in", source.dir, `(${source.emptyHint})`)
    saveState(state)
    return result
  }

  let titles: string[] | undefined
  for (const memory of memories) {
    const hash = sha1(`${memory.title}\n${memory.content}`)
    const prev = state.memories[memory.key]
    if (prev?.released) {
      result.changedInNotion++
      continue
    }
    if (prev?.hash === hash) {
      result.unchanged++
      continue
    }
    const body = `${memory.content}\n\nFrom ${source.name} memories (${memory.from}).`

    if (prev) {
      // Only overwrite the page if it is still exactly what the plugin wrote.
      const page = await fetchPage(callTool, prev.pageId)
      const released = page.deleted
        ? "deleted"
        : page.hash !== prev.pageHash
          ? "edited"
          : undefined
      if (released) {
        log(`memories: ${prev.title} was ${released} in Notion, leaving it`)
        state.memories[memory.key] = { ...prev, released }
        result.changedInNotion++
        saveState(state)
        continue
      }
      await callTool("update-page", {
        page_id: prev.pageId,
        command: "replace_content",
        new_str: body,
        allow_deleting_content: true,
      })
      state.memories[memory.key] = { ...prev, hash }
      result.updated++
    } else {
      // Search first: one memory per topic, so never add a second "Coding workflow
      // preferences" next to one the user or another agent already keeps.
      titles ??= await memoryTitles(callTool)
      if (titles.some((t) => sameTitle(t, memory.title))) {
        log("memories: a memory titled", memory.title, "already exists")
        result.skippedExisting++
        continue
      }
      const created = (await callTool("create-pages", {
        parent: "memory",
        pages: [
          {
            properties: { title: memory.title, Type: memory.type },
            content: body,
          },
        ],
      })) as { pages?: { id: string }[] }
      const pageId = created.pages?.[0]?.id
      if (!pageId) throw new Error(`no page returned for ${memory.title}`)
      state.memories[memory.key] = {
        hash,
        title: memory.title,
        type: memory.type,
        pageId,
      }
      result.created++
    }
    const entry = state.memories[memory.key]
    entry.pageHash = (await fetchPage(callTool, entry.pageId)).hash
    saveState(state)
  }

  // The agent dropped these. Deleting a memory needs the user's confirmation, so the plugin
  // only stops managing them.
  const live = new Set(memories.map((m) => m.key))
  for (const key of Object.keys(state.memories)) {
    if (live.has(key)) continue
    log(`memories: ${source.name} no longer has`, state.memories[key].title)
    delete state.memories[key]
    result.noLongerInAgent++
  }

  if (result.updated)
    await callTool("finish-revision", {
      title: `Update memories from ${source.name}`,
      description: `${source.name} updated ${result.updated} memor${result.updated === 1 ? "y" : "ies"}.`,
    }).catch((e: unknown) =>
      log("memories: could not name the revision:", String(e))
    )
  saveState(state)
  log(`memories: ${JSON.stringify(result)}`)
  return result
}

async function userName(callTool: CallTool): Promise<string | undefined> {
  const self = (await callTool("get-self", {}).catch(() => undefined)) as
    | { user?: { name?: string } }
    | undefined
  return self?.user?.name?.split(/\s+/)[0] || undefined
}

// Titles of the user's existing memories. Uses the SQL view of the Memories data source,
// which can lag behind recent writes; the plugin's own pages are tracked by ID instead.
async function memoryTitles(callTool: CallTool): Promise<string[]> {
  const fetched = await callTool("fetch", { id: "memory" })
  const dataSource = JSON.stringify(fetched).match(
    /collection:\/\/[0-9a-f-]{36}/
  )?.[0]
  if (!dataSource)
    throw new Error(
      "Notion Memories are not available for this connection (fetch id: memory)"
    )
  const res = (await callTool("query-data-sources", {
    data: {
      mode: "sql",
      data_source_urls: [dataSource],
      query: `SELECT "Title" FROM "${dataSource}" LIMIT 1000`,
    },
  })) as { results?: { Title?: string }[] }
  return (res.results ?? []).map((r) => r.Title ?? "")
}

// Reads a memory page and hashes what a person could change: title, type, and content.
async function fetchPage(
  callTool: CallTool,
  pageId: string
): Promise<{ deleted: boolean; hash: string }> {
  const fetched = (await callTool("fetch", { id: pageId })) as {
    text?: string
  }
  const text = fetched.text ?? ""
  const tag = text.match(/<page\b[^>]*>/)?.[0] ?? ""
  let properties: Record<string, unknown> = {}
  try {
    properties = JSON.parse(
      text.match(/<properties>\s*([\s\S]*?)\s*<\/properties>/)?.[1] ?? "{}"
    )
  } catch {}
  const content = text.match(/<content>([\s\S]*?)<\/content>/)?.[1] ?? ""
  return {
    deleted: /\sdeleted\b/.test(tag),
    hash: sha1(`${properties.Title}\n${properties.Type}\n${content.trim()}`),
  }
}

// The Notion memory guide asks for the user's name instead of "the user".
export function personalize(text: string, name: string | undefined): string {
  if (!name) return text
  return text
    .replace(/\b([Tt])he user's\b/g, `${name}'s`)
    .replace(/\b[Tt]he user\b/g, name)
}

function sameTitle(a: string | undefined, b: string): boolean {
  return normalizeKey(a ?? "") === normalizeKey(b)
}

export function normalizeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\[task \d+\]/g, "")
    .replace(/[^a-z0-9]/g, "")
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
