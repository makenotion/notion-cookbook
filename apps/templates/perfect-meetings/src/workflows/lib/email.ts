import { normalizeEmail } from "../../lib/domains.js"
import { truncate } from "./calendar.js"

/** The compact form of a Gmail search result the research prompt uses. */
export type EmailThread = {
  threadId: string
  date: string
  from: string
  fromName: string
  subject: string
  snippet: string
}

const SNIPPET_CHARS = 240

function addressOf(value: string): string {
  const match = value.match(/<([^>]+)>/)
  return normalizeEmail(match?.[1] ?? value)
}

/**
 * Read threads from a searchEmails result. The Mail connection returns
 * `{ threads: [...] }` either as structured content or as a JSON string.
 * Returns null when the shape is unrecognised.
 */
export function parseThreads(content: unknown): EmailThread[] | null {
  let value = content
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  const threads = (value as { threads?: unknown } | null)?.threads
  if (!Array.isArray(threads)) return null
  return threads.flatMap((item) => {
    const thread = item as Record<string, unknown>
    if (typeof thread.threadId !== "string") return []
    const text = (key: string) =>
      typeof thread[key] === "string" ? (thread[key] as string).trim() : ""
    return [
      {
        threadId: thread.threadId,
        date: text("date"),
        from: text("from"),
        fromName: text("fromName"),
        subject: text("subject"),
        snippet: truncate(text("snippet").replace(/\s+/g, " "), SNIPPET_CHARS),
      },
    ]
  })
}

/**
 * Keep threads the attendee or the mailbox owner sent. Gmail search matches
 * loosely, so this drops notifications that merely mention the address.
 */
export function relevantThreads(
  threads: readonly EmailThread[],
  attendee: string,
  mailbox: string
): EmailThread[] {
  const allowed = new Set([normalizeEmail(attendee), normalizeEmail(mailbox)])
  return threads.filter((thread) => allowed.has(addressOf(thread.from)))
}

/** One line per thread, newest first, each thread once across all attendees. */
export function emailLines(
  threadsByAttendee: Record<string, readonly EmailThread[]>
): string[] {
  const seen = new Map<string, { thread: EmailThread; with: Set<string> }>()
  for (const [attendee, threads] of Object.entries(threadsByAttendee)) {
    for (const thread of threads) {
      const entry = seen.get(thread.threadId) ?? {
        thread,
        with: new Set<string>(),
      }
      entry.with.add(attendee)
      seen.set(thread.threadId, entry)
    }
  }
  const time = (thread: EmailThread) => Date.parse(thread.date) || 0
  return [...seen.values()]
    .sort((a, b) => time(b.thread) - time(a.thread))
    .map(({ thread, with: people }) => {
      const date = Number.isNaN(Date.parse(thread.date))
        ? thread.date
        : new Date(thread.date).toISOString().slice(0, 10)
      const who = [...people].join(", ")
      return `- ${date} · from ${addressOf(thread.from)} · with ${who} · "${thread.subject}"${thread.snippet ? ` — ${thread.snippet}` : ""}`
    })
}

/** The sender display name the attendee uses on their own email, if any. */
export function senderName(
  threads: readonly EmailThread[],
  attendee: string
): string | null {
  const email = normalizeEmail(attendee)
  const named = threads.find(
    (thread) => addressOf(thread.from) === email && thread.fromName
  )
  if (named) return named.fromName
  // Some results carry the name inside the From header instead.
  for (const thread of threads) {
    const match = thread.from.match(/^\s*"?([^"<]+?)"?\s*<([^>]+)>/)
    if (match?.[1] && normalizeEmail(match[2]!) === email)
      return match[1].trim()
  }
  return null
}
