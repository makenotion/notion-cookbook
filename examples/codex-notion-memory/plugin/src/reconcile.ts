import crypto from "node:crypto"
import { log, saveState, type MemoryState, type State } from "./config.ts"
import type { CallTool } from "./mcp.ts"
import type { CodexMemory, MemorySyncResult } from "./memories.ts"

type Destination = "memory" | "archive"

export async function syncProjection(
  call: CallTool,
  state: State,
  knowledge: CodexMemory[],
  archive?: CodexMemory[]
): Promise<MemorySyncResult> {
  const archives = (state.archives ??= {})
  for (const [key, entry] of Object.entries(state.memories)) {
    if (!key.startsWith("archive:")) continue
    archives[key] = { ...entry, destination: "memory" }
    delete state.memories[key]
  }
  saveState(state)
  const result: MemorySyncResult = {
    total: knowledge.length + (archive?.length ?? 0),
    created: 0,
    updated: 0,
    unchanged: 0,
    changedInNotion: 0,
    skippedExisting: 0,
    noLongerInCodex: 0,
  }

  async function root(): Promise<{ pageId: string; url: string }> {
    if (state.archiveRoot) return state.archiveRoot
    const created = await call("create-pages", {
      creation_mode: "draft",
      pages: [
        {
          properties: { title: "Codex memory source archive" },
          content:
            "Supporting Codex memory sources. These are evidence and backups, not active Notion Memories. Removed projections contain no active knowledge.",
        },
      ],
    })
    const page = createdPage(created)
    state.archiveRoot = page
    saveState(state)
    return page
  }

  async function moveOut(entry: MemoryState): Promise<void> {
    const parent = await root()
    if (entry.pendingMove) {
      const page = await snapshot(call, entry.pageId, entry.type)
      if (
        page.parent === parent.pageId &&
        !release(entry, page, parent.pageId)
      ) {
        entry.destination = "archive"
        entry.pageHash = page.hash
        entry.pendingMove = false
        saveState(state)
        return
      }
    }
    entry.pendingMove = true
    saveState(state)
    await call("move-pages", {
      page_or_database_ids: [entry.pageId],
      new_parent: { page_id: parent.pageId },
    })
    entry.destination = "archive"
    entry.pageHash = (await snapshot(call, entry.pageId)).hash
    entry.pendingMove = false
    saveState(state)
  }

  // Migrate owned legacy source pages before allowing new archive writes.
  for (const entry of Object.values(archives)) {
    if (entry.destination !== "memory" || entry.released) continue
    const page = await snapshot(call, entry.pageId, entry.type)
    if (release(entry, page, state.archiveRoot?.pageId)) {
      saveState(state)
      continue
    }
    if (entry.pendingMove && page.parent === state.archiveRoot?.pageId) {
      entry.destination = "archive"
      entry.pageHash = page.hash
      entry.pendingMove = false
      saveState(state)
    } else await moveOut(entry)
  }
  if (archive?.length) await root()

  let titles: string[] | undefined
  async function reconcile(
    memories: CodexMemory[],
    entries: Record<string, MemoryState>,
    destination: Destination
  ) {
    if (destination === "memory")
      for (const [key, entry] of Object.entries(entries)) {
        if (!entry.pendingMove || entry.released) continue
        if (
          release(
            entry,
            await snapshot(call, entry.pageId, entry.type),
            state.archiveRoot?.pageId
          )
        ) {
          saveState(state)
          continue
        }
        await moveOut(entry)
        await call("update-page", {
          page_id: entry.pageId,
          command: "replace_content",
          new_str:
            "This projection was removed from Codex. It contains no active memory or source text.",
        })
        delete entries[key]
        result.noLongerInCodex++
        saveState(state)
      }
    for (const memory of memories) {
      const evidence =
        destination === "memory" && archive && state.archiveRoot
          ? `\n\nSource evidence: <mention-page url="${state.archiveRoot.url}"/>`
          : ""
      const content = `${memory.content}\n\nFrom Codex memories (${memory.from}).${evidence}`
      const hash = digest(`${memory.title}\n${content}`)
      const previous = entries[memory.key]
      if (previous?.released) {
        result.changedInNotion++
        continue
      }
      if (previous?.hash === hash) {
        result.unchanged++
        continue
      }
      if (previous) {
        if (release(previous, await snapshot(call, previous.pageId))) {
          result.changedInNotion++
          saveState(state)
          continue
        }
        await call("update-page", {
          page_id: previous.pageId,
          command: "replace_content",
          new_str: content,
        })
        previous.hash = hash
        result.updated++
      } else {
        if (destination === "memory") {
          titles ??= await memoryTitles(call)
          if (titles.some((title) => sameTitle(title, memory.title))) {
            result.skippedExisting++
            continue
          }
        }
        const parent =
          destination === "memory"
            ? "memory"
            : { page_id: (await root()).pageId }
        const properties =
          destination === "memory"
            ? { title: memory.title, Type: memory.type }
            : { title: memory.title }
        const page = createdPage(
          await call("create-pages", {
            parent,
            pages: [{ properties, content }],
          })
        )
        entries[memory.key] = {
          hash,
          title: memory.title,
          type: memory.type,
          pageId: page.pageId,
          destination,
        }
        titles?.push(memory.title)
        result.created++
      }
      entries[memory.key].pageHash = (
        await snapshot(call, entries[memory.key].pageId)
      ).hash
      saveState(state)
    }

    const live = new Set(memories.map((memory) => memory.key))
    for (const [key, entry] of Object.entries(entries)) {
      if (live.has(key) || entry.released) continue
      if (
        release(
          entry,
          await snapshot(call, entry.pageId, entry.type),
          state.archiveRoot?.pageId
        )
      ) {
        saveState(state)
        continue
      }
      // Retraction uses normal content edits and a move, not unapproved Trash calls.
      if (destination === "memory") await moveOut(entry)
      await call("update-page", {
        page_id: entry.pageId,
        command: "replace_content",
        new_str:
          "This projection was removed from Codex. It contains no active memory or source text.",
      })
      delete entries[key]
      result.noLongerInCodex++
      saveState(state)
    }
  }

  await reconcile(knowledge, state.memories, "memory")
  if (archive) await reconcile(archive, archives, "archive")
  if (result.updated || result.noLongerInCodex) {
    await call("finish-revision", {
      title: "Synchronize Codex knowledge",
      description:
        "Updated current knowledge and retracted removed projections.",
    }).catch((error) => log("could not finish sync revision:", String(error)))
  }
  saveState(state)
  log(`memories: ${JSON.stringify(result)}`)
  return result
}

function release(
  entry: MemoryState,
  page: {
    deleted: boolean
    hash: string
    legacyHash: string
    parent?: string
    beforeMoveHashes: string[]
  },
  archiveParent?: string
): boolean {
  if (page.deleted) entry.released = "deleted"
  else if (
    page.hash !== entry.pageHash &&
    page.legacyHash !== entry.pageHash &&
    !(
      entry.pendingMove &&
      archiveParent &&
      page.parent === archiveParent &&
      page.beforeMoveHashes.includes(entry.pageHash ?? "")
    )
  )
    entry.released = "edited"
  return !!entry.released
}

export async function snapshot(
  call: CallTool,
  id: string,
  beforeMoveType?: string
): Promise<{
  deleted: boolean
  hash: string
  legacyHash: string
  parent?: string
  beforeMoveHashes: string[]
}> {
  const result = await call("fetch", { id })
  if (!isObject(result) || typeof result.text !== "string")
    throw new Error("invalid page readback")
  const text = result.text
  let properties: unknown
  try {
    properties = JSON.parse(
      text.match(/<properties>\s*([\s\S]*?)\s*<\/properties>/)?.[1] ?? "{}"
    )
  } catch {
    throw new Error("invalid page properties")
  }
  if (!isObject(properties)) throw new Error("invalid page properties")
  const content =
    text.match(/<content>([\s\S]*?)<\/content>/)?.[1]?.trim() ?? ""
  const payload = `${properties.Title ?? properties.title}\n${properties.Type}\n${content}`
  const parentUrl = text.match(/<parent-page\b[^>]*url="([^"]+)"/)?.[1]
  const parentRaw = parentUrl?.split("/").pop()?.split("?")[0]
  const parent =
    parentRaw && /^[0-9a-f]{32}$/i.test(parentRaw)
      ? parentRaw.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5")
      : parentRaw
  const beforePayload = `${properties.Title ?? properties.title}\n${beforeMoveType}\n${content}`
  return {
    deleted: /<page\b[^>]*\sdeleted\b/.test(text),
    hash: digest(payload),
    legacyHash: crypto.createHash("sha1").update(payload).digest("hex"),
    parent,
    beforeMoveHashes: beforeMoveType
      ? [
          digest(beforePayload),
          crypto.createHash("sha1").update(beforePayload).digest("hex"),
        ]
      : [],
  }
}

function createdPage(result: unknown): { pageId: string; url: string } {
  if (!isObject(result) || !Array.isArray(result.pages))
    throw new Error("create-pages returned no pages")
  const page: unknown = result.pages[0]
  if (!isObject(page) || typeof page.id !== "string")
    throw new Error("create-pages returned no page ID")
  return {
    pageId: page.id,
    url:
      typeof page.url === "string"
        ? page.url
        : `https://www.notion.so/${page.id.replace(/-/g, "")}`,
  }
}

async function memoryTitles(call: CallTool): Promise<string[]> {
  const fetched = await call("fetch", { id: "memory" })
  const collection = JSON.stringify(fetched).match(
    /collection:\/\/[0-9a-f-]{36}/
  )?.[0]
  if (!collection)
    throw new Error("Notion Memories are not available for this connection")
  const titles: string[] = []
  for (let offset = 0; ; offset += 200) {
    const response = await call("query-data-sources", {
      data: {
        mode: "sql",
        data_source_urls: [collection],
        query: `SELECT "Title" FROM "${collection}" ORDER BY url LIMIT 200 OFFSET ${offset}`,
      },
    })
    if (!isObject(response) || !Array.isArray(response.results))
      throw new Error("invalid memory title query")
    for (const row of response.results) {
      if (!isObject(row) || typeof row.Title !== "string")
        throw new Error("invalid memory title")
      titles.push(row.Title)
    }
    if (response.results.length < 200) return titles
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function sameTitle(a: string, b: string): boolean {
  return (
    a.normalize("NFC").toLowerCase().trim() ===
    b.normalize("NFC").toLowerCase().trim()
  )
}

function digest(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex")
}
