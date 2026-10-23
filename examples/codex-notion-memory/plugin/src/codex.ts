import fs from "node:fs"
import path from "node:path"
import { AGENT_HOME, log, sleep, withLock } from "./config.ts"
import type { CallTool } from "./mcp.ts"
import {
  type AgentMemory,
  type MemorySource,
  normalizeKey,
  personalize,
  readIfExists,
  sha1,
  syncMemories,
} from "./memories.ts"

// Codex memories (`[features] memories = true`) are written by Codex itself, in the
// background: phase 1 extracts notes from idle sessions, phase 2 consolidates them into
// $CODEX_HOME/memories/memory_summary.md and MEMORY.md. This module turns those files into
// one memory per topic.

const POLL_MS = 5000
const PROFILE_TITLE = "Role and background"
const PREFERENCES_TITLE = "Coding workflow preferences"

export const codexSource: MemorySource = {
  name: "Codex",
  dir: path.join(AGENT_HOME, "memories"),
  parse: parseCodexMemories,
  emptyHint: "is [features] memories = true?",
}

export function parseCodexMemories(
  dir: string,
  userName?: string
): AgentMemory[] {
  const summary = readIfExists(path.join(dir, "memory_summary.md"))
  const memoryFile = readIfExists(path.join(dir, "MEMORY.md"))
  const out: AgentMemory[] = []
  const seenPreferences: string[] = []

  for (const section of sections(summary, 2)) {
    if (/^user profile/i.test(section.title) && isReal(section.body))
      out.push({
        key: "profile",
        type: "Profile",
        title: PROFILE_TITLE,
        content: unwrap(section.body),
        from: "`memory_summary.md` › User Profile",
      })
    if (/^user preferences/i.test(section.title)) {
      const prefs = bullets(section.body).filter(isReal)
      seenPreferences.push(...prefs.map(preferenceKey))
      if (prefs.length)
        out.push({
          key: "preferences",
          type: "Preference",
          title: PREFERENCES_TITLE,
          content: prefs.map((p) => `- ${p}`).join("\n"),
          from: "`memory_summary.md` › User preferences",
        })
    }
  }

  for (const group of sections(memoryFile, 1)) {
    const name = group.title.replace(/^Task Group:\s*/i, "").trim()
    const parts = sections(group.body, 2)
    const scope = group.body.match(/^scope:\s*(.+)$/m)?.[1]
    const appliesTo = group.body.match(/^applies_to:\s*(.+)$/m)?.[1]
    const tasks = parts
      .filter((s) => /^task \d+/i.test(s.title))
      .map((s) => s.title.replace(/^Task \d+:\s*/i, ""))
    const knowledge = parts.filter((s) =>
      /^(reusable knowledge|failures)/i.test(s.title)
    )
    // Preferences already in the global summary are not repeated per project.
    const prefs = parts
      .filter((s) => /^user preferences/i.test(s.title))
      .flatMap((s) => bullets(s.body))
      .filter(
        (p) =>
          isReal(p) &&
          !seenPreferences.some((k) => overlaps(k, preferenceKey(p)))
      )
    const blocks = [
      scope && `Scope: ${scope}`,
      appliesTo && `Applies to: ${appliesTo}`,
      tasks.length && `Recent tasks:\n${tasks.map((t) => `- ${t}`).join("\n")}`,
      prefs.length && `Preferences:\n${prefs.map((p) => `- ${p}`).join("\n")}`,
      ...knowledge.map(
        (k) =>
          `${k.title}:\n${bullets(k.body)
            .map((b) => `- ${b}`)
            .join("\n")}`
      ),
    ].filter(Boolean)
    if (tasks.length || knowledge.length || prefs.length)
      out.push({
        key: `work:${normalizeKey(name)}`,
        type: "Work",
        title: name,
        content: blocks.join("\n\n"),
        from: `\`MEMORY.md\` › ${group.title}`,
      })
  }

  return out.map((m) => ({
    ...m,
    content: personalize(m.content.replace(/\s*\[Task \d+\]/g, ""), userName),
  }))
}

// Codex has no hook for "memories updated", so a hook worker watches Codex's own job table
// and the memory files, and imports as soon as a consolidation run finishes.
export async function watchMemories(
  callTool: CallTool,
  opts: { startWindowMs: number; maxMs: number }
): Promise<void> {
  const started = Date.now()
  let lastHash = memoryFilesHash()
  let sawRunning = false
  while (Date.now() - started < opts.maxMs) {
    await sleep(POLL_MS)
    const running = await memoryJobRunning()
    sawRunning ||= running
    const hash = memoryFilesHash()
    if (hash !== lastHash && !running) {
      log("memories: Codex updated its memory files, importing")
      await withLock(() => syncMemories(callTool, codexSource))
      lastHash = hash
    }
    if (!running && (sawRunning || Date.now() - started > opts.startWindowMs))
      return
  }
}

async function memoryJobRunning(): Promise<boolean> {
  const db = path.join(AGENT_HOME, "memories_1.sqlite")
  if (!fs.existsSync(db)) return false
  try {
    const { DatabaseSync } = await import("node:sqlite")
    const conn = new DatabaseSync(db, { readOnly: true })
    try {
      return (
        conn
          .prepare("SELECT 1 FROM jobs WHERE status = 'running' LIMIT 1")
          .all().length > 0
      )
    } finally {
      conn.close()
    }
  } catch (e) {
    log(
      "memories: job table unavailable:",
      e instanceof Error ? e.message : String(e)
    )
    return false
  }
}

function memoryFilesHash(): string {
  return sha1(
    ["MEMORY.md", "memory_summary.md"]
      .map((f) => readIfExists(path.join(codexSource.dir, f)))
      .join("\0")
  )
}

function sections(
  text: string,
  level: number
): { title: string; body: string }[] {
  const heading = new RegExp(`^${"#".repeat(level)} (.+)$`, "gm")
  const out: { title: string; body: string }[] = []
  let prev: { title: string; end: number } | undefined
  for (const match of text.matchAll(heading)) {
    const index = match.index ?? 0
    if (prev) out.push({ title: prev.title, body: text.slice(prev.end, index) })
    prev = { title: match[1].trim(), end: index + match[0].length }
  }
  if (prev) out.push({ title: prev.title, body: text.slice(prev.end) })
  return out
}

// Codex hard-wraps prose. Notion would keep each line break, so join wrapped lines.
function unwrap(text: string): string {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " "))
    .join("\n\n")
}

function bullets(section: string): string[] {
  return section
    .split("\n")
    .filter((l) => /^\s*- /.test(l))
    .map((l) => l.replace(/^\s*- /, "").trim())
    .filter(Boolean)
}

// Codex seeds memory files with placeholder text such as "No preferences recorded yet."
function isReal(content: string): boolean {
  const text = content.trim()
  return text.length >= 12 && !/^(no|not)\b[^.]*\b(yet|recorded)\b/i.test(text)
}

// The same preference often appears in both files with different wording around a quote.
function preferenceKey(bullet: string): string {
  return normalizeKey(bullet.match(/[“"]([^”"]{8,})[”"]/)?.[1] ?? bullet)
}

function overlaps(a: string, b: string): boolean {
  return a.includes(b) || b.includes(a)
}
