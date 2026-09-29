import { describe, expect, it } from "vitest"

import type { NotionDataSourcePage } from "@notionhq/apps/custom-blocks"
import {
  dateRange,
  dayBounds,
  firstSentence,
  groupByCompany,
  layoutDay,
  pickMeeting,
  sortByStart,
  wallTimeToMs,
} from "../blocks/nextMeeting/meeting.js"

function row(id: string, when: unknown): NotionDataSourcePage {
  return {
    id,
    propertiesById: {},
    propertiesByKey: { When: when },
  } as unknown as NotionDataSourcePage
}

const timed = (date: string, start: string, end: string) => ({
  type: "datetimerange",
  start_date: date,
  start_time: start,
  end_date: date,
  end_time: end,
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
    const range = dateRange({
      type: "datetime",
      start_date: "2026-09-29",
      start_time: "10:00",
    })
    expect(range && range.endMs - range.startMs).toBe(60 * 60 * 1000)
  })
})

describe("pickMeeting", () => {
  const rows = [
    row("all-day", { type: "date", start_date: "2026-09-29" }),
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
      type: "daterange",
      start_date: "2026-09-28",
      end_date: "2026-10-02",
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
    type: "datetimerange",
    start_date: "2026-09-29",
    start_time: hhmm(start),
    end_date: "2026-09-29",
    end_time: hhmm(end),
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
        row("all-day", { type: "date", start_date: "2026-09-29" }),
        row("offsite", {
          type: "daterange",
          start_date: "2026-09-28",
          end_date: "2026-10-01",
        }),
        row("tomorrow", { type: "date", start_date: "2026-09-30" }),
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
