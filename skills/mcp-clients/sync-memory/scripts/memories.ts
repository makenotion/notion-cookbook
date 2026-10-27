import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  CODEX_HOME,
  loadConfig,
  loadState,
  log,
  saveState,
  sleep,
  withLock,
} from "./config.ts"
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

export function memoryFiles(): MemoryFile[] {
  const dir = memoriesDir()
  if (!fs.existsSync(path.join(dir, "memory_summary.md")))
    throw new Error("Codex v2 memory_summary.md is not ready")
  const names: string[] = []
  function visit(relative: string) {
    for (const entry of fs.readdirSync(path.join(dir, relative), {
      withFileTypes: true,
    })) {
      if (entry.name === ".git") continue
      const name = path.posix.join(relative, entry.name)
      if (entry.isDirectory()) visit(name)
      else if (entry.isFile() && entry.name.endsWith(".md")) names.push(name)
    }
  }
  visit("")
  return names.sort().map((name) => {
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
}

export async function syncMemories(call: CallTool) {
  const files = memoryFiles()
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
    const content = renderMemory(file, new Date().toISOString())
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

export async function verifyMemories(call: CallTool) {
  const files = memoryFiles()
  const state = loadState()
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
  return { verified: files.length }
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

export function memoryFilesHash(): string {
  return digest(
    JSON.stringify(
      memoryFiles().map(({ name, hash, metadataHash }) => [
        name,
        hash,
        metadataHash,
      ])
    )
  )
}

export async function watchMemories(
  call: CallTool,
  opts: { maxMs: number; initialHash: string }
) {
  const started = Date.now()
  let previous = opts.initialHash
  while (Date.now() - started < opts.maxMs) {
    await sleep(5000)
    if (memoryJobRunning()) continue
    const hash = memoryFilesHash()
    if (hash !== previous) {
      await withLock(() => syncMemories(call))
      previous = hash
    }
  }
}

function memoryJobRunning(): boolean {
  const file = path.join(
    loadConfig().sourceHome || CODEX_HOME,
    "memories_v2_1.sqlite"
  )
  if (!fs.existsSync(file)) return false
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return (
      db.prepare("SELECT 1 FROM jobs WHERE status = 'running' LIMIT 1").all()
        .length > 0
    )
  } finally {
    db.close()
  }
}

function digest(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex")
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
