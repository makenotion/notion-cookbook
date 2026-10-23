import path from "node:path"
import type { FileChange, SessionEvent, Turn } from "./rollout.ts"

// Notion block payloads for the Public API (`PATCH /v1/blocks/{id}/children`).

export type Block = Record<string, unknown>

export interface Annotations {
  bold?: boolean
  italic?: boolean
  code?: boolean
  color?: string
}

export interface RichText {
  type: "text"
  text: { content: string; link?: { url: string } }
  annotations?: Annotations
}

// The API limits a rich text item to 2,000 characters and an array to 100 items.
const RICH_TEXT_CHUNK = 1900
const MAX_RICH_TEXT_ITEMS = 50

export function rt(text: string, annotations: Annotations = {}): RichText[] {
  const out: RichText[] = []
  for (let i = 0; i < Math.max(text.length, 1); i += RICH_TEXT_CHUNK)
    out.push({
      type: "text",
      text: { content: text.slice(i, i + RICH_TEXT_CHUNK) },
      annotations,
    })
  return out.slice(0, MAX_RICH_TEXT_ITEMS)
}

export function clip(text: string | undefined, max: number): string {
  if (!text) return ""
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… (${text.length - max} more chars, see attached transcript)`
}

// Minimal inline markdown: `code`, **bold**, and [label](url).
export function inlineMarkdown(text: string): RichText[] {
  const out: RichText[] = []
  const token = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\))/g
  let last = 0
  for (const match of text.matchAll(token)) {
    const index = match.index ?? 0
    if (index > last) out.push(...rt(text.slice(last, index)))
    out.push(...inlineToken(match[0]))
    last = index + match[0].length
  }
  if (last < text.length) out.push(...rt(text.slice(last)))
  return out.length ? out.slice(0, 90) : rt("")
}

// Paragraphs, bullet and numbered lists, short headings, and fenced code.
export function markdownBlocks(text: string): Block[] {
  const blocks: Block[] = []
  const parts = text.split(/```(\w*)\n([\s\S]*?)```/g)
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 1) {
      blocks.push({
        code: {
          language: parts[i] || "plain text",
          rich_text: rt(clip(parts[i + 1], 6000)),
        },
      })
      i++
      continue
    }
    for (const paragraph of parts[i].split(/\n{2,}/))
      blocks.push(...paragraphBlocks(paragraph.trim()))
  }
  return blocks
}

export function renderTurn(turn: Turn, n: number): Block[] {
  const heading = `Turn ${n}${turn.started_at ? ` · ${new Date(turn.started_at).toISOString().slice(11, 16)} UTC` : ""}`
  const blocks: Block[] = [
    { divider: {} },
    { heading_2: { rich_text: rt(heading) } },
  ]
  const results = new Map(
    turn.events
      .filter((e) => e.type === "agent.tool_result")
      .map((e) => [e.tool_use_id, e])
  )
  for (const event of turn.events) {
    const block = renderEvent(event, results.get(event.tool_use_id))
    if (block) blocks.push(block)
  }
  return blocks
}

function renderEvent(
  e: SessionEvent,
  result: SessionEvent | undefined
): Block | undefined {
  const text = e.content?.[0]?.text ?? ""
  switch (e.type) {
    case "user.message":
      if (e.origin !== "user") return undefined
      return {
        callout: {
          icon: { type: "emoji", emoji: "🧑‍💻" },
          color: "blue_background",
          rich_text: inlineMarkdown(clip(text, 5000)),
        },
      }
    case "agent.message":
      if (e.phase === "final_answer")
        return {
          callout: {
            icon: { type: "emoji", emoji: "🤖" },
            color: "gray_background",
            rich_text: rt("Codex", { bold: true }),
            children: markdownBlocks(clip(text, 8000)).slice(0, 80),
          },
        }
      return {
        paragraph: {
          rich_text: inlineMarkdown(clip(text, 3000)).map((r) => ({
            ...r,
            annotations: { ...r.annotations, italic: true, color: "gray" },
          })),
        },
      }
    case "agent.thinking":
      return {
        toggle: {
          rich_text: rt("💭 Thinking", { color: "gray" }),
          children: [{ paragraph: { rich_text: rt(clip(e.summary, 3000)) } }],
        },
      }
    case "agent.tool_use":
      return renderToolUse(e, result)
    case "agent.thread_context_compacted":
      return {
        paragraph: {
          rich_text: rt("Context compacted", { color: "gray", italic: true }),
        },
      }
    default:
      return undefined
  }
}

function renderToolUse(
  e: SessionEvent,
  result: SessionEvent | undefined
): Block {
  const output =
    typeof result?.output === "string"
      ? result.output
      : JSON.stringify(result?.output ?? "")
  if (e.name === "exec_command") {
    const command = field(e.input, "command")
    const status = result
      ? result.exit_code === 0
        ? "✅"
        : `❌ exit ${result.exit_code}`
      : ""
    return {
      toggle: {
        rich_text: [
          ...rt("🔧 "),
          ...rt(clip(command.split("\n")[0], 150), { code: true }),
          ...rt(` ${status}`),
        ],
        children: [
          { code: { language: "shell", rich_text: rt(clip(command, 3000)) } },
          {
            code: {
              language: "plain text",
              rich_text: rt(clip(output || "(no output)", 4000)),
            },
          },
        ],
      },
    }
  }
  if (e.name === "apply_patch") {
    const changes = fileChanges(e.input)
    const files = Object.keys(changes)
    const children: Block[] = files.slice(0, 20).map((file) => {
      const change = changes[file]
      return {
        code: {
          language: change.unified_diff ? "diff" : "plain text",
          caption: rt(`${change.type ?? "update"} ${file}`),
          rich_text: rt(
            clip(
              change.unified_diff ?? change.content ?? JSON.stringify(change),
              4000
            )
          ),
        },
      }
    })
    return {
      toggle: {
        rich_text: [
          ...rt("✏️ Edited "),
          ...rt(files.map((f) => path.basename(f)).join(", ") || "files", {
            code: true,
          }),
        ],
        children: children.length
          ? children
          : [{ paragraph: { rich_text: rt(output) } }],
      },
    }
  }
  const input =
    typeof e.input === "string" ? e.input : JSON.stringify(e.input, null, 2)
  return {
    toggle: {
      rich_text: [...rt("🔧 "), ...rt(String(e.name), { code: true })],
      children: [
        { code: { language: "json", rich_text: rt(clip(input, 3000)) } },
        { code: { language: "plain text", rich_text: rt(clip(output, 3000)) } },
      ],
    },
  }
}

function inlineToken(token: string): RichText[] {
  if (token.startsWith("`")) return rt(token.slice(1, -1), { code: true })
  if (token.startsWith("**")) return rt(token.slice(2, -2), { bold: true })
  const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
  if (!link) return rt(token)
  const [, label, url] = link
  // Codex links local files as [name](/abs/path); only web links can be Notion links.
  if (/^https?:/.test(url))
    return [{ type: "text", text: { content: label, link: { url } } }]
  return rt(label, { code: true })
}

function paragraphBlocks(paragraph: string): Block[] {
  if (!paragraph) return []
  const lines = paragraph.split("\n")
  if (lines.every((l) => /^\s*[-*] /.test(l)))
    return lines.map((l) => ({
      bulleted_list_item: {
        rich_text: inlineMarkdown(l.replace(/^\s*[-*] /, "")),
      },
    }))
  if (lines.every((l) => /^\s*\d+\. /.test(l)))
    return lines.map((l) => ({
      numbered_list_item: {
        rich_text: inlineMarkdown(l.replace(/^\s*\d+\. /, "")),
      },
    }))
  if (lines.length === 1 && /^#{1,3} /.test(paragraph))
    return [
      {
        heading_3: { rich_text: inlineMarkdown(paragraph.replace(/^#+ /, "")) },
      },
    ]
  return [{ paragraph: { rich_text: inlineMarkdown(paragraph) } }]
}

function field(input: unknown, key: string): string {
  if (input && typeof input === "object" && key in input) {
    const value: unknown = Reflect.get(input, key)
    return typeof value === "string" ? value : ""
  }
  return ""
}

function fileChanges(input: unknown): Record<string, FileChange> {
  if (!input || typeof input !== "object" || !("changes" in input)) return {}
  const changes: unknown = input.changes
  if (!changes || typeof changes !== "object") return {}
  const out: Record<string, FileChange> = {}
  for (const [file, change] of Object.entries(changes))
    if (change && typeof change === "object") out[file] = change
  return out
}
