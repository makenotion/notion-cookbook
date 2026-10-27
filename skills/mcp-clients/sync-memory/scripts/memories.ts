import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {
  CODEX_HOME,
  loadConfig,
  loadState,
  log,
  saveState,
  withLock,
} from "./config.ts"
import type { State } from "./config.ts"
import type { CallTool } from "./mcp.ts"

export function memoriesDir(): string {
  return path.join(loadConfig().sourceHome || CODEX_HOME, "memories_v2")
}

export interface MemoryFile {
  name: string
  content: string
  hash: string
  createdAt: string | null
  updatedAt: string
  metadataHash: string
}

export function sourceCreatedAt(birthtimeMs: number): string | null {
  const date = new Date(birthtimeMs)
  return birthtimeMs > 0 && Number.isFinite(date.getTime())
    ? date.toISOString()
    : null
}

export function renderMemory(file: MemoryFile, syncedAt: string): string {
  const metadata = {
    Source: "Codex",
    "Source root": "memories_v2",
    "Source path": file.name,
    "Source created at": file.createdAt,
    "Source updated at": file.updatedAt,
    "Synced at": syncedAt,
    "Synced by": "notion-memory",
  }
  return `# Codex memory source\n\n\`\`\`json\n${JSON.stringify(metadata, null, 2)}\n\`\`\`\n\n---\n\n${file.content}`
}

export function memoryInventory(): {
  files: MemoryFile[]
  unsupported: string[]
} {
  const dir = memoriesDir()
  if (!fs.existsSync(dir))
    throw new Error(`Memory directory does not exist: ${dir}`)
  const names: string[] = []
  const unsupported: string[] = []
  function visit(relative: string) {
    for (const entry of fs.readdirSync(path.join(dir, relative), {
      withFileTypes: true,
    })) {
      if (entry.name === ".git") continue
      const name = path.posix.join(relative, entry.name)
      if (entry.isDirectory()) visit(name)
      else if (entry.isFile() && entry.name.endsWith(".md")) names.push(name)
      else unsupported.push(name)
    }
  }
  visit("")
  const files = names.sort().map((name) => {
    const file = path.join(dir, name)
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
  })
  return { files, unsupported: unsupported.sort() }
}

export async function syncMemories(call: CallTool) {
  const state = loadState()
  await resolvePending(call, state)
  const { files, unsupported } = memoryInventory()
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
    const content = renderMemory(file, new Date().toISOString())
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
          properties: { "Last updated by": "Codex" },
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
                title: file.name,
                Type: "Notes",
                Source: "Codex",
                "Last updated by": "Codex",
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
        `Unknown ${previous ? "update" : "create"} outcome for ${file.name}${previous ? ` (page ${previous.pageId})` : ""}; reconcile the remote page and state.json before retrying. ${error instanceof Error ? error.message : String(error)}`,
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
        JSON.stringify([file.name, "Notes", content.trim()])
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
        `Unknown ${pending.operation} outcome for ${name}${pending.pageId ? ` (page ${pending.pageId})` : ""}; reconcile the remote page and state.json before retrying. No write was retried.`
      )
  }
  for (const [name, pending] of entries) {
    if (pending.phase !== "readback") continue
    const page = await snapshot(call, pending.pageId)
    if (page.deleted)
      throw new Error(
        `Pending readback page deleted: ${name} (${pending.pageId})`
      )
    if (recovering && page.hash !== pending.expectedPageHash)
      throw new Error(
        `Pending readback differs from the submitted page: ${name} (${pending.pageId}); reconcile the remote page and state.json before retrying. No write was retried.`
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

export async function verifyMemories(call: CallTool) {
  const state = loadState()
  const pending = Object.entries(state.pending ?? {})
  if (pending.length)
    throw new Error(
      `Pending writes require sync/reconciliation: ${pending.map(([name, entry]) => `${name} (${entry.phase})`).join(", ")}`
    )
  const { files, unsupported } = memoryInventory()
  for (const file of files) {
    const entry = state.files[file.name]
    if (
      !entry ||
      entry.released ||
      entry.hash !== file.hash ||
      entry.metadataHash !== file.metadataHash
    )
      throw new Error(`Unsynced file: ${file.name}`)
    const page = await snapshot(call, entry.pageId)
    if (page.deleted || page.hash !== entry.pageHash)
      throw new Error(`Page changed: ${file.name}`)
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

function digest(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex")
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
