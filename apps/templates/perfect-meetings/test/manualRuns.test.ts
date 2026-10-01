import { describe, expect, it } from "vitest"

import {
  BACKLOG_MAX_MEETINGS,
  personResearched,
  selectBacklog,
  type BacklogMeeting,
  type BacklogPerson,
} from "../src/workflows/lib/backlog.js"
import { ingestPlan } from "../src/workflows/lib/ingest.js"

describe("ingestPlan", () => {
  it("makes the no-input manual run a full catch-up", () => {
    expect(ingestPlan({ type: "workflow.manual" })).toEqual({
      type: "catchUp",
    })
  })

  it("keeps the schedule and Workflow runs rows as catch-ups", () => {
    expect(ingestPlan({ type: "recurrence" })).toEqual({ type: "catchUp" })
    expect(ingestPlan({ type: "notion.page.created" })).toEqual({
      type: "catchUp",
    })
  })

  it("keeps calendar event triggers unchanged", () => {
    expect(
      ingestPlan({
        type: "calendar.event.created",
        startTime: "2026-09-29T17:00:00Z",
      })
    ).toEqual({ type: "event", startTime: "2026-09-29T17:00:00Z" })
    expect(
      ingestPlan({
        type: "calendar.event.updated",
        startTime: "2026-09-29T17:00:00Z",
      })
    ).toEqual({ type: "event", startTime: "2026-09-29T17:00:00Z" })
    expect(
      ingestPlan({ type: "calendar.event.canceled", eventId: "evt-1" })
    ).toEqual({ type: "cancel", eventId: "evt-1" })
  })
})

const NOW = Date.parse("2026-09-29T17:00:00Z")
const HOUR = 60 * 60 * 1000

function m(
  id: string,
  offsetHours: number,
  prepStatus: string | null,
  attendees: string[]
): BacklogMeeting {
  const startMs = NOW + offsetHours * HOUR
  return { id, startMs, endMs: startMs + HOUR, prepStatus, attendees }
}

const person = (
  email: string,
  researched: boolean,
  companyDomain = email.split("@")[1]!
): BacklogPerson => ({ email, researched, companyDomain })

describe("personResearched", () => {
  it("counts a role or a confidence as researched", () => {
    expect(personResearched({ role: "CTO", confidence: null })).toBe(true)
    expect(personResearched({ role: "", confidence: "Low" })).toBe(true)
    expect(personResearched({ role: " ", confidence: null })).toBe(false)
  })
})

describe("selectBacklog", () => {
  const people = [
    person("a@acme.com", true),
    person("b@globex.com", false),
    person("c@initech.com", true),
    person("d@gmail.com", false, ""),
  ]
  const researched = new Set(["acme.com", "initech.com"])

  it("picks upcoming unfinished preps and unresearched people, soonest first", () => {
    const { picks, remaining } = selectBacklog(
      [
        m("ready-done", 2, "Ready", ["a@acme.com"]),
        m("failed", 3, "Failed", ["c@initech.com"]),
        m("empty", 1, null, ["a@acme.com"]),
        m("new-person", 4, "Ready", ["b@globex.com"]),
      ],
      people,
      researched,
      NOW
    )
    expect(picks.map((pick) => pick.id)).toEqual([
      "empty",
      "failed",
      "new-person",
    ])
    expect(picks[2]!.reasons).toEqual([
      "1 unresearched attendee(s)",
      "1 unresearched company(ies)",
    ])
    expect(remaining).toBe(0)
  })

  it("skips meetings being researched, without attendees, or already covered", () => {
    const { picks } = selectBacklog(
      [
        m("researching", 1, "Researching", ["b@globex.com"]),
        m("no-attendees", 2, null, []),
        m("first", 3, "Ready", ["b@globex.com"]),
        m("same-person", 4, "Ready", ["b@globex.com"]),
      ],
      people,
      researched,
      NOW
    )
    expect(picks.map((pick) => pick.id)).toEqual(["first"])
  })

  it("uses past meetings only for unresearched people, most recent first", () => {
    const { picks } = selectBacklog(
      [
        m("old-failed", -48, "Failed", ["a@acme.com"]),
        m("older", -72, "Ready", ["d@gmail.com"]),
        m("recent", -24, "Ready", ["d@gmail.com"]),
      ],
      people,
      researched,
      NOW
    )
    expect(picks.map((pick) => pick.id)).toEqual(["recent"])
  })

  it("caps the run and reports the remainder", () => {
    const many = Array.from({ length: BACKLOG_MAX_MEETINGS + 3 }, (_, i) =>
      m(`m${i}`, i + 1, "Queued", ["a@acme.com"])
    )
    const { picks, remaining } = selectBacklog(many, people, researched, NOW)
    expect(picks).toHaveLength(BACKLOG_MAX_MEETINGS)
    expect(picks[0]!.id).toBe("m0")
    expect(remaining).toBe(3)
  })
})
