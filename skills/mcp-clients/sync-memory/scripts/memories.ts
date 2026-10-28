import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { loadState, log, saveState, type State } from "./config.ts"
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
  inventory(): MemoryInventory
}

export interface MemoryInventory {
  files: MemoryFile[]
  // Other entries in the memory directory, which are reported but not copied.
  unsupported: string[]
}

export async function syncMemories(call: CallTool, source: MemorySource) {
  const state = loadState()
  await resolvePending(call, state)
  const { files, unsupported } = source.inventory()
  const present = new Set(files.map((file) => file.name))
  const result = {
    unsupported,
    missing: Object.keys(state.files)
      .filter((name) => !present.has(name))
      .sort(),
    total: files.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    changedInNotion: 0,
  }
  let destinationChecked = false
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
    // Finish connection selection and workspace validation before journaling a
    // mutation; a setup failure is not an unknown remote write.
    if (!destinationChecked) {
      await call("get-self", {})
      destinationChecked = true
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
    state.pending ??= {}
    state.pending[file.name] = {
      phase: "unknown",
      operation: previous ? "update" : "create",
      hash: file.hash,
      metadataHash: file.metadataHash,
      ...(previous ? { pageId: previous.pageId } : {}),
    }
    saveState(state)
    try {
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
        if (!isObject(page) || typeof page.id !== "string" || !page.id)
          throw new Error("create-pages returned no page ID")
        pageId = page.id
      }
    } catch (error) {
      throw new Error(
        `Unknown ${previous ? "update" : "create"} outcome for ${file.name}${previous ? ` (page ${previous.pageId})` : ""}; run status for the reconcile command and instructions. No write will be retried. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      )
    }
    if (!previous) result.created++
    state.pending[file.name] = {
      phase: "readback",
      operation: previous ? "update" : "create",
      pageId,
      hash: file.hash,
      metadataHash: file.metadataHash,
      expectedPageHash: digest(
        JSON.stringify([file.title, file.type, content.trim()])
      ),
    }
    saveState(state)
    await resolvePending(call, state, false)
  }
  log("memories:", result)
  return result
}

async function resolvePending(call: CallTool, state: State, recovering = true) {
  const entries = Object.entries(state.pending ?? {})
  for (const [name, pending] of entries) {
    if (pending.phase === "unknown")
      throw new Error(
        `Unknown ${pending.operation} outcome for ${name}${pending.pageId ? ` (page ${pending.pageId})` : ""}; run status for the reconcile command and instructions. No write was retried.`
      )
  }
  for (const [name, pending] of entries) {
    if (pending.phase !== "readback") continue
    const page = await snapshot(call, pending.pageId)
    if (page.deleted)
      throw new Error(
        `Pending readback page deleted: ${name} (${pending.pageId}); run status for the reconcile command and instructions.`
      )
    if (recovering && page.hash !== pending.expectedPageHash)
      throw new Error(
        `Pending readback differs from the submitted page: ${name} (${pending.pageId}); run status for the reconcile command and instructions. No write was retried.`
      )
    state.files[name] = {
      pageId: pending.pageId,
      hash: pending.hash,
      metadataHash: pending.metadataHash,
      pageHash: page.hash,
    }
    delete state.pending![name]
    saveState(state)
  }
}

export function memoryStatus() {
  const state = loadState()
  return {
    ...state,
    recovery: Object.entries(state.pending ?? {}).map(([name, pending]) => ({
      path: name,
      phase: pending.phase,
      operation: pending.operation,
      pageId: pending.pageId ?? null,
      instructions:
        "Inspect the affected page in the pinned workspace. If a create response was lost, locate the page by its title and Source path; never assume it was not created. With explicit user approval, keep that Notion page and release this source path from future sync using these command arguments. If the page cannot be identified or fetched, keep the pending entry and report the unresolved outcome.",
      command: [
        "node",
        "scripts/main.ts",
        "reconcile",
        name,
        "--keep-notion",
        pending.pageId ?? "<confirmed-page-id>",
      ],
    })),
  }
}

// Recovery preserves the reviewed remote page and retires this mapping; it never
// adopts possibly edited content as a new baseline or retries an unknown write.
export async function reconcileMemory(
  call: CallTool,
  name: string,
  pageId: string
) {
  const state = loadState()
  const pending = state.pending?.[name]
  if (!pending) throw new Error(`No pending write for ${name}`)
  if (pending.pageId && pending.pageId !== pageId)
    throw new Error(`Pending page ID for ${name} is ${pending.pageId}`)
  const page = await snapshot(call, pageId)
  state.files[name] = {
    pageId,
    hash: pending.hash,
    metadataHash: pending.metadataHash,
    pageHash: page.hash,
    released: true,
  }
  delete state.pending![name]
  saveState(state)
  return { path: name, pageId, released: true }
}

export async function verifyMemories(call: CallTool, source: MemorySource) {
  const state = loadState()
  const pending = Object.entries(state.pending ?? {})
  if (pending.length)
    throw new Error(
      `Pending writes require sync/reconciliation: ${pending.map(([name, entry]) => `${name} (${entry.phase})`).join(", ")}`
    )
  const { files, unsupported } = source.inventory()
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
  const present = new Set(files.map((file) => file.name))
  return {
    verified: files.length,
    unsupported,
    missing: Object.keys(state.files)
      .filter((name) => !present.has(name))
      .sort(),
  }
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
  const propertiesFrame = text.match(
    /<properties>\s*([\s\S]*?)\s*<\/properties>/
  )
  if (!propertiesFrame) throw new Error("Missing page properties frame")
  const properties: unknown = JSON.parse(propertiesFrame[1])
  if (
    !isObject(properties) ||
    typeof (properties.Title ?? properties.title) !== "string" ||
    typeof properties.Type !== "string"
  )
    throw new Error("Invalid page properties")
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
