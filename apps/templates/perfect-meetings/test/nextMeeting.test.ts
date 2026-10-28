import { describe, expect, it } from "vitest"

import type { NotionDateInput } from "@notionhq/apps/custom-blocks"
import type { PageRow } from "../blocks/main_ui/meeting.js"
import { pageRow, propertyValue } from "./pageFixtures.js"
import {
  dateRange,
  dayBounds,
  firstSentence,
  profileLinks,
  roleLabel,
  groupByCompany,
  layoutDay,
  pickMeeting,
  sortByStart,
  text,
  wallTimeToMs,
} from "../blocks/main_ui/meeting.js"

function row(id: string, when: NotionDateInput): PageRow {
  return pageRow(id, { When: when })
}

const timed = (date: string, start: string, end: string): NotionDateInput => ({
  start: `${date}T${start}:00`,
  end: `${date}T${end}:00`,
  time_zone: "America/Los_Angeles",
})

describe("dateRange", () => {
  it("converts zoned wall time to an instant", () => {
    expect(
      new Date(
        wallTimeToMs("2026-09-29", "10:00", "America/Los_Angeles")
      ).toISOString()
    ).toBe("2026-09-29T17:00:00.000Z")
    expect(new Date(wallTimeToMs("2026-09-29", "10:00")).toISOString()).toBe(
      "2026-09-29T10:00:00.000Z"
    )
  })

  it("gives a meeting without an end one hour", () => {
    const range = dateRange(
      propertyValue("when", {
        start: "2026-09-29T10:00:00Z",
      })
    )
    expect(range && range.endMs - range.startMs).toBe(60 * 60 * 1000)
  })

  it("reads SDK date ranges with explicit offsets", () => {
    expect(
      dateRange(
        propertyValue("when", {
          start: "2026-09-29T10:00:00-07:00",
          end: "2026-09-29T11:30:00-07:00",
        })
      )
    ).toEqual({
      startMs: Date.parse("2026-09-29T17:00:00Z"),
      endMs: Date.parse("2026-09-29T18:30:00Z"),
      allDay: false,
    })
  })

  it("uses the date's named zone after daylight saving time changes", () => {
    expect(
      dateRange(
        propertyValue("when", {
          start: "2026-03-08T10:00:00",
          end: "2026-03-08T11:00:00",
          time_zone: "America/Los_Angeles",
        })
      )
    ).toEqual({
      startMs: Date.parse("2026-03-08T17:00:00Z"),
      endMs: Date.parse("2026-03-08T18:00:00Z"),
      allDay: false,
    })
  })

  it("keeps an explicit UTC instant when a named zone is also present", () => {
    expect(
      dateRange(
        propertyValue("when", {
          start: "2026-09-29T17:00:00Z",
          end: "2026-09-29T18:00:00Z",
          time_zone: "America/Los_Angeles",
        })
      )
    ).toEqual({
      startMs: Date.parse("2026-09-29T17:00:00Z"),
      endMs: Date.parse("2026-09-29T18:00:00Z"),
      allDay: false,
    })
  })

  it("includes the last calendar day of an all-day date range", () => {
    expect(
      dateRange(
        propertyValue("when", {
          start: "2026-09-28",
          end: "2026-09-29",
        })
      )
    ).toEqual({
      startMs: new Date(2026, 8, 28).getTime(),
      endMs: new Date(2026, 8, 30).getTime(),
      allDay: true,
    })
  })
})

describe("SDK property text", () => {
  it("joins the rich text segments of a title", () => {
    expect(
      text({
        id: "title-id",
        type: "title",
        title: [{ plain_text: "Meeting " }, { plain_text: "prep" }],
      })
    ).toBe("Meeting prep")
  })

  it("reads profile text and links from typed property values", () => {
    expect(text(propertyValue("summary", "A useful summary."))).toBe(
      "A useful summary."
    )
    expect(text({ id: "site", type: "url", url: "https://acme.example" })).toBe(
      "https://acme.example"
    )
    expect(text({ id: "email", type: "email", email: "a@acme.example" })).toBe(
      "a@acme.example"
    )
  })

  it("reads research and prep states from select and status properties", () => {
    expect(
      text({ id: "research", type: "select", select: { name: "Researching" } })
    ).toBe("Researching")
    expect(
      text({ id: "prep", type: "status", status: { name: "Ready" } })
    ).toBe("Ready")
    expect(text({ id: "empty", type: "select", select: null })).toBe("")
    expect(text(null)).toBe("")
  })
})

describe("pickMeeting", () => {
  const rows = [
    row("all-day", { start: "2026-09-29" }),
    row("past", timed("2026-09-29", "08:00", "09:00")),
    row("now", timed("2026-09-29", "10:00", "11:00")),
    row("later", timed("2026-09-29", "13:00", "14:00")),
  ]

  it("picks the meeting in progress", () => {
    expect(pickMeeting(rows, Date.parse("2026-09-29T17:30:00Z"))?.row.id).toBe(
      "now"
    )
  })

  it("between meetings, an all-day event in progress beats the next meeting", () => {
    expect(pickMeeting(rows, Date.parse("2026-09-29T19:00:00Z"))?.row.id).toBe(
      "all-day"
    )
    expect(
      pickMeeting(rows.slice(1), Date.parse("2026-09-29T19:00:00Z"))?.row.id
    ).toBe("later")
  })

  it("returns null when nothing is left", () => {
    expect(
      pickMeeting(rows.slice(1), Date.parse("2026-09-30T12:00:00Z"))
    ).toBeNull()
  })
})

describe("profileLinks", () => {
  it("lists set profile links in a fixed order", () => {
    expect(
      profileLinks(
        pageRow("person", {
          "Personal site": {
            id: "site-id",
            type: "url",
            url: "https://d.example",
          },
          LinkedIn: {
            id: "linkedin-id",
            type: "url",
            url: "https://linkedin.com/in/d",
          },
          X: { id: "x-id", type: "url", url: null },
          Instagram: { id: "instagram-id", type: "url", url: "not a url" },
        })
      )
    ).toEqual([
      { label: "LinkedIn", url: "https://linkedin.com/in/d" },
      { label: "Website", url: "https://d.example" },
    ])
  })
})

describe("roleLabel", () => {
  it("marks a role from a low-confidence match", () => {
    expect(roleLabel("Engineer", "Low")).toBe("(low confidence) Engineer")
    expect(roleLabel("Engineer", "High")).toBe("Engineer")
    expect(roleLabel("Engineer", "")).toBe("Engineer")
    expect(roleLabel("", "Low")).toBe("")
  })
})

describe("firstSentence", () => {
  it("keeps the first sentence", () => {
    expect(firstSentence("Acme makes anvils. It is based in Ohio.")).toBe(
      "Acme makes anvils."
    )
    expect(firstSentence("No period")).toBe("No period")
  })
})

describe("multi-day events", () => {
  it("finds an offsite that started before the query cutoff", () => {
    const offsite = row("offsite", {
      start: "2026-09-28",
      end: "2026-10-02",
    })
    const merged = sortByStart([
      row("later", timed("2026-10-05", "10:00", "11:00")),
      offsite,
      offsite,
    ])
    expect(merged.map((r) => r.id)).toEqual(["offsite", "later"])
    const noon = new Date(2026, 8, 29, 12).getTime()
    expect(pickMeeting(merged, noon)?.row.id).toBe("offsite")
  })
})

describe("layoutDay", () => {
  // Hours in the machine's zone, so the day boundaries line up.
  const hhmm = (hours: number) =>
    `${String(Math.floor(hours)).padStart(2, "0")}:${String((hours % 1) * 60).padStart(2, "0")}`
  const at = (start: number, end: number) => ({
    start: `2026-09-29T${hhmm(start)}:00`,
    end: `2026-09-29T${hhmm(end)}:00`,
    time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
  const day = dayBounds(new Date(2026, 8, 29, 12).getTime())

  it("splits overlapping meetings into columns", () => {
    const { timed } = layoutDay(
      [
        row("a", at(9, 10)),
        row("b", at(9.5, 11)),
        row("c", at(10, 10.5)),
        row("d", at(13, 14)),
      ],
      day
    )
    const byId = Object.fromEntries(
      timed.map((e) => [e.row.id, [e.column, e.columns]])
    )
    expect(byId).toEqual({ a: [0, 2], b: [1, 2], c: [0, 2], d: [0, 1] })
  })

  it("puts all-day and whole-day events on the all-day strip and skips other days", () => {
    const { allDay, timed } = layoutDay(
      [
        row("all-day", { start: "2026-09-29" }),
        row("offsite", {
          start: "2026-09-28",
          end: "2026-10-01",
        }),
        row("tomorrow", { start: "2026-09-30" }),
        row("meeting", at(9, 10)),
      ],
      day
    )
    expect(allDay.map((e) => e.row.id)).toEqual(["offsite", "all-day"])
    expect(timed.map((e) => e.row.id)).toEqual(["meeting"])
  })
})

describe("groupByCompany", () => {
  it("keeps one entry per domain in attendee order and skips personal mailboxes", () => {
    const people = [
      { email: "a@acme.com", domain: "acme.com" },
      { email: "b@globex.com", domain: "Globex.com" },
      { email: "c@gmail.com", domain: "" },
      { email: "d@acme.com", domain: "acme.com" },
    ]
    expect(
      groupByCompany(people, (p) => p.domain).map((g) => [
        g.domain,
        g.attendees.map((p) => p.email),
      ])
    ).toEqual([
      ["acme.com", ["a@acme.com", "d@acme.com"]],
      ["globex.com", ["b@globex.com"]],
    ])
  })
})
