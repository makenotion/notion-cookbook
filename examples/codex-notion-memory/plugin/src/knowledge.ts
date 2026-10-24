import fs from "node:fs"
import path from "node:path"
import type { AgentMemory } from "./memories.ts"

// Project Codex's consolidated knowledge, never the extraction database or chat logs.
export function parseCodexMemories(
  dir: string,
  userName?: string
): AgentMemory[] {
  const read = (name: string) => {
    const file = path.join(dir, name)
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
  }
  const summary = read("memory_summary.md")
  const entries = read("MEMORY.md")
  const memories: AgentMemory[] = []
  const add = (memory: AgentMemory) => {
    const content = memory.content
      .trim()
      .replace(/\s*\[Task \d+\]/g, "")
      .replace(/\b[Tt]he user's\b/g, userName ? `${userName}'s` : "the user's")
      .replace(/\b[Tt]he user\b/g, userName || "the user")
    if (isReal(content) && !memories.some((m) => m.key === memory.key))
      memories.push({ ...memory, content })
  }

  for (const section of sections(summary, 2)) {
    if (/^user profile/i.test(section.title))
      add({
        key: "profile",
        type: "Profile",
        title: "Role and background",
        content: unwrap(section.body),
        from: "memory_summary.md / User Profile",
      })
    else if (/^user preferences/i.test(section.title))
      add({
        key: "preferences",
        type: "Preference",
        title: "Coding workflow preferences",
        content: section.body,
        from: "memory_summary.md / User preferences",
      })
    else if (/^general tips/i.test(section.title))
      add({
        key: "practices",
        type: "Preference",
        title: "Working practices",
        content: section.body,
        from: "memory_summary.md / General Tips",
      })
    else if (/^what.s in memory/i.test(section.title)) {
      for (const topic of sections(section.body, 3)) {
        // Strip source filenames and transport IDs, retain the already-consolidated findings.
        const content = topic.body
          .replace(
            /(^\s*-\s+)(?:`?rollout_summaries\/[^\s`]+`?)\s*[—–-]\s*/gm,
            "$1"
          )
          .replace(/\s+thread_id=[a-z0-9-]+/gi, "")
        add({
          key: `topic:${topic.title
            .normalize("NFC")
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]/gu, "")}`,
          type: "Work",
          title: topic.title,
          content,
          from: `memory_summary.md / ${topic.title}`,
        })
      }
    }
  }

  for (const group of sections(entries, 1)) {
    const name = group.title.replace(/^Task Group:\s*/i, "").trim()
    const globalPreferences =
      memories.find((m) => m.key === "preferences")?.content ?? ""
    const key = (s: string) =>
      (s.match(/[“"]([^”"]{8,})[”"]/)?.[1] ?? s)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]/gu, "")
    const globalKeys = globalPreferences
      .split("\n")
      .filter((s) => /^\s*- /.test(s))
      .map(key)
    const durable = sections(group.body, 2)
      .filter((s) =>
        /^(user preferences|reusable knowledge|failures|general tips)/i.test(
          s.title
        )
      )
      .map((s) =>
        /^user preferences/i.test(s.title)
          ? {
              ...s,
              body: s.body
                .split("\n")
                .filter(
                  (line) =>
                    !/^\s*- /.test(line) ||
                    !globalKeys.some(
                      (k) =>
                        k && (key(line).includes(k) || k.includes(key(line)))
                    )
                )
                .join("\n"),
            }
          : s
      )
      .filter((s) => s.body.trim())
    const scope = group.body.match(/^scope:\s*(.+)$/m)?.[1]
    // Task histories, rollout references and retrieval keywords remain in the archive.
    const content = [
      scope && `Scope: ${scope}`,
      ...durable.map((s) => `## ${s.title}\n\n${s.body.trim()}`),
    ]
      .filter(Boolean)
      .join("\n\n")
    if (durable.length)
      add({
        key: `work:${name
          .normalize("NFC")
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]/gu, "")}`,
        type: "Work",
        title: name,
        content,
        from: `MEMORY.md / ${group.title}`,
      })
  }
  return memories
}

function sections(
  text: string,
  level: number
): { title: string; body: string }[] {
  const matches = [...text.matchAll(new RegExp(`^#{${level}} (.+)$`, "gm"))]
  return matches.map((m, i) => ({
    title: m[1].trim(),
    body: text.slice(
      (m.index ?? 0) + m[0].length,
      matches[i + 1]?.index ?? text.length
    ),
  }))
}

function unwrap(text: string): string {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " "))
    .join("\n\n")
}

function isReal(text: string): boolean {
  return (
    text.length >= 12 &&
    !/^(?:-\s*)?(no|not)\b[^.]*\b(yet|recorded)\b/i.test(text.trim())
  )
}
