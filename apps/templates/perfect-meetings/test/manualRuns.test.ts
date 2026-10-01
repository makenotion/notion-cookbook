import { describe, expect, it } from "vitest"

import {
  BACKLOG_MAX_MEETINGS,
  FAILED_RETRY_MS,
  STALE_RESEARCH_MS,
  companyAttempted,
  personAttempted,
  selectBacklog,
  type BacklogMeeting,
  type BacklogPerson,
} from "../src/workflows/lib/backlog.js"
import calendarIngest from "../src/workflows/calendarIngest.js"

describe("calendarIngest triggers", () => {
  it("runs only hourly, on a Workflow runs row, or by hand with no input", () => {
    const text = JSON.stringify(calendarIngest)
    for (const type of ["recurrence", "notion.page.created", "workflow.manual"])
      expect(text).toContain(`"${type}"`)
    expect(text).not.toMatch(/calendar\.event\./)
  })
})

const NOW = Date.parse("2026-09-29T17:00:00Z")
const HOUR = 60 * 60 * 1000

function m(
  id: string,
  offsetHours: number,
  prepStatus: string | null,
  attendees: string[],
  lastEditedMs: number | null = NOW - 24 * HOUR
): BacklogMeeting {
  const startMs = NOW + offsetHours * HOUR
  return {
    id,
    startMs,
    endMs: startMs + HOUR,
    prepStatus,
    lastEditedMs,
    attendees,
  }
}

const person = (
  email: string,
  attempted: boolean,
  companyDomain = email.split("@")[1]!
): BacklogPerson => ({ email, attempted, companyDomain })

describe("personAttempted and companyAttempted", () => {
  it("counts Researched at, or older research, as attempted", () => {
    const blank = { researchedAt: null, role: "", confidence: null }
    expect(personAttempted(blank)).toBe(false)
    expect(personAttempted({ ...blank, researchedAt: "2026-09-29" })).toBe(true)
    expect(personAttempted({ ...blank, role: "CTO" })).toBe(true)
    expect(personAttempted({ ...blank, confidence: "Low" })).toBe(true)
    expect(companyAttempted({ researchedAt: null, summary: " " })).toBe(false)
    expect(companyAttempted({ researchedAt: null, summary: "Anvils" })).toBe(
      true
    )
  })
})

describe("selectBacklog", () => {
  const people = [
    person("a@acme.com", true),
    person("b@globex.com", false),
    person("c@initech.com", true),
    person("d@gmail.com", false, ""),
  ]
  const attempted = new Set(["acme.com", "initech.com"])

  it("puts never-attempted people first, then unfinished upcoming preps", () => {
    const { picks, remaining } = selectBacklog(
      [
        m("ready-done", 2, "Ready", ["a@acme.com"]),
        m("failed", 3, "Failed", ["c@initech.com"]),
        m("empty", 1, null, ["a@acme.com"]),
        m("new-person", 4, "Ready", ["b@globex.com"]),
      ],
      people,
      attempted,
      NOW
    )
    expect(picks.map((pick) => pick.id)).toEqual([
      "new-person",
      "empty",
      "failed",
    ])
    expect(picks[0]!.reasons).toEqual([
      "1 unresearched attendee(s)",
      "1 unresearched company(ies)",
    ])
    expect(remaining).toBe(0)
  })

  it("skips meetings being researched, without attendees, or already covered", () => {
    const { picks } = selectBacklog(
      [
        m("researching", 1, "Researching", ["b@globex.com"], NOW - 60_000),
        m("no-attendees", 2, null, []),
        m("first", 3, "Ready", ["b@globex.com"]),
        m("same-person", 4, "Ready", ["b@globex.com"]),
      ],
      people,
      attempted,
      NOW
    )
    expect(picks.map((pick) => pick.id)).toEqual(["first"])
  })

  it("retries a meeting stuck in Researching", () => {
    const { picks } = selectBacklog(
      [
        m(
          "stuck",
          1,
          "Researching",
          ["a@acme.com"],
          NOW - STALE_RESEARCH_MS - 1
        ),
      ],
      people,
      attempted,
      NOW
    )
    expect(picks).toEqual([
      { id: "stuck", reasons: ["prep stuck researching"] },
    ])
  })

  it("waits FAILED_RETRY_MS before retrying a failed meeting", () => {
    const fresh = m("failed", 1, "Failed", ["b@globex.com"], NOW - HOUR)
    expect(selectBacklog([fresh], people, attempted, NOW).picks).toEqual([])
    const old = { ...fresh, lastEditedMs: NOW - FAILED_RETRY_MS - 1 }
    expect(
      selectBacklog([old], people, attempted, NOW).picks.map((p) => p.id)
    ).toEqual(["failed"])
  })

  it("uses past meetings only for unresearched people, most recent first", () => {
    const { picks } = selectBacklog(
      [
        m("old-failed", -48, "Failed", ["a@acme.com"]),
        m("older", -72, "Ready", ["d@gmail.com"]),
        m("recent", -24, "Ready", ["d@gmail.com"]),
      ],
      people,
      attempted,
      NOW
    )
    expect(picks.map((pick) => pick.id)).toEqual(["recent"])
  })

  it("caps the run and reports the remainder", () => {
    const many = Array.from({ length: BACKLOG_MAX_MEETINGS + 3 }, (_, i) =>
      m(`m${i}`, i + 1, "Queued", ["a@acme.com"])
    )
    const { picks, remaining } = selectBacklog(many, people, attempted, NOW)
    expect(picks).toHaveLength(BACKLOG_MAX_MEETINGS)
    expect(picks[0]!.id).toBe("m0")
    expect(remaining).toBe(3)
  })

  it("makes progress across successive runs, even when research finds nothing or fails", () => {
    // 25 upcoming meetings, each with its own never-researched person at a
    // new company. Research returns nothing for most, and always fails for
    // every fifth meeting.
    let meetings = Array.from({ length: 25 }, (_, i) =>
      m(`m${i}`, i + 1, "Queued", [`p${i}@co${i}.com`])
    )
    let folks = meetings.map((meeting) => person(meeting.attendees[0]!, false))
    const companies = new Set<string>()
    const counts: number[] = []
    let clock = NOW
    for (let run = 0; run < 10; run++) {
      const { picks } = selectBacklog(meetings, folks, companies, clock)
      counts.push(picks.length)
      if (picks.length === 0) break
      const ids = new Set(picks.map((pick) => pick.id))
      meetings = meetings.map((meeting) => {
        if (!ids.has(meeting.id)) return meeting
        const fails = Number(meeting.id.slice(1)) % 5 === 0
        if (!fails) {
          // Research returned: stamp Researched at on the person and company.
          const email = meeting.attendees[0]!
          folks = folks.map((p) =>
            p.email === email ? { ...p, attempted: true } : p
          )
          companies.add(email.split("@")[1]!)
        }
        return {
          ...meeting,
          prepStatus: fails ? "Failed" : "Ready",
          lastEditedMs: clock,
        }
      })
      clock += 10 * 60 * 1000
    }
    // 10, 10, then the 5 left; failed meetings wait out their cooldown.
    expect(counts).toEqual([10, 10, 5, 0])
    expect(meetings.filter((x) => x.prepStatus === "Ready")).toHaveLength(20)
  })
})
