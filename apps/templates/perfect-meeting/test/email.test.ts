import { describe, expect, it } from "vitest"

import {
  emailLines,
  parseThreads,
  relevantThreads,
} from "../src/workflows/lib/email.js"
import {
  lastAgentText,
  MAX_PROMPT_CHARS,
  researchPrompt,
} from "../src/workflows/lib/prep.js"

// Shape observed from the Mail connection's searchEmails in a live run.
const invite = {
  threadId: "thread-1",
  url: "https://mail.google.com/mail/#all/thread-1",
  latestMessageId: "msg-1",
  subject: "Updated invitation: Team Offsite",
  systemLabels: ["UNREAD", "INBOX"],
  userLabels: [],
  date: "Mon, 28 Sep 2026 15:06:16 +0000",
  from: "mrivera@example.com",
  snippet: "You have been invited\n to the offsite",
}
const noise = {
  ...invite,
  threadId: "vendor",
  from: "updates@vendor.example",
  subject: "Vendor: weekly digest",
}

describe("parseThreads", () => {
  it("reads structured content and JSON strings", () => {
    expect(parseThreads({ threads: [invite] })).toEqual([
      {
        threadId: invite.threadId,
        date: invite.date,
        from: invite.from,
        fromName: "",
        subject: invite.subject,
        snippet: "You have been invited to the offsite",
      },
    ])
    expect(parseThreads(JSON.stringify({ threads: [invite] }))).toHaveLength(1)
  })

  it("returns null for unknown shapes", () => {
    expect(parseThreads("not json")).toBeNull()
    expect(parseThreads({ results: [] })).toBeNull()
  })
})

describe("relevantThreads", () => {
  it("keeps mail from the attendee or the mailbox owner", () => {
    const threads = parseThreads({
      threads: [
        invite,
        noise,
        { ...invite, threadId: "mine", from: "Me <ME@example.com>" },
      ],
    })!
    expect(
      relevantThreads(threads, "mrivera@example.com", "me@example.com").map(
        (t) => t.threadId
      )
    ).toEqual([invite.threadId, "mine"])
  })
})

describe("research prompt", () => {
  it("lists a thread shared by several attendees once", () => {
    const [thread] = parseThreads({ threads: [invite] })!
    const lines = emailLines({
      "a@x.example": [thread!],
      "b@x.example": [thread!],
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("with a@x.example, b@x.example")
  })

  it("stays under the sessions API limit for a large meeting", () => {
    const attendees = Array.from({ length: 10 }, (_, i) => ({
      id: `p${i}`,
      name: `Person ${i}`,
      email: `p${i}@acme.example`,
      role: "",
      companyDomain: "acme.example",
    }))
    const threads = Object.fromEntries(
      attendees.map((a) => [
        a.email,
        Array.from({ length: 10 }, (_, j) => ({
          threadId: `${a.email}-${j}`,
          date: `Mon, ${String(j + 1).padStart(2, "0")} Sep 2026 10:00:00 +0000`,
          from: a.email,
          subject: "A fairly long subject line about the partnership".repeat(2),
          snippet: "x".repeat(240),
        })),
      ])
    )
    const prompt = researchPrompt(
      {
        title: "Offsite",
        start: "2026-09-28",
        end: "2026-10-03",
        agenda: "agenda ".repeat(1000),
      },
      attendees,
      [{ id: "c", name: "Acme", domain: "acme.example", summary: "" }],
      threads
    )
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS)
    expect(prompt).toContain("older threads omitted")
    expect(prompt).toContain("Person 9")
  })
})

describe("lastAgentText", () => {
  it("returns the latest agent message among other event types", () => {
    const events = [
      {
        type: "user.message",
        sequence: 12,
        content: [{ type: "text", text: "prompt" }],
      },
      {
        type: "agent.message",
        sequence: 30,
        content: [{ type: "text", text: "draft" }],
      },
      { type: "agent.tool_use", sequence: 39, tool_name: "notion_load_page" },
      {
        type: "agent.message",
        sequence: 44,
        content: [{ type: "text", text: '{"company":"x"}' }],
      },
      { type: "session.status", sequence: 46, status: "completed" },
    ] as unknown as Parameters<typeof lastAgentText>[0]
    expect(lastAgentText(events)).toBe('{"company":"x"}')
    expect(lastAgentText(events.slice(0, 1))).toBeNull()
  })
})
