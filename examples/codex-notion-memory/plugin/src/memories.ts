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

export function memoryFiles(): {
  name: string
  content: string
  hash: string
}[] {
  const dir = memoriesDir()
  if (!fs.existsSync(path.join(dir, "memory_summary.md")))
    throw new Error("Codex v2 memory_summary.md is not ready")
  return ["memory_summary.md", "MEMORY.md"]
    .filter((name) => fs.existsSync(path.join(dir, name)))
    .map((name) => {
      const content = fs.readFileSync(path.join(dir, name), "utf8")
      return { name, content, hash: digest(content) }
    })
}

// One source file becomes one page. Pass its Markdown through unchanged.
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
        properties: { "Last updated by": "Codex" },
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
              title: file.name,
              Type: "Notes",
              Source: "Codex",
              "Last updated by": "Codex",
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
    state.files[file.name] = {
      pageId,
      hash: file.hash,
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
    if (!entry || entry.released || entry.hash !== file.hash)
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
    JSON.stringify(memoryFiles().map(({ name, hash }) => [name, hash]))
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
