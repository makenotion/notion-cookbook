import { describe, expect, it } from "vitest"

import {
  companyDomain,
  companyNameFromDomain,
  isInternalDomain,
  nameFromEmail,
} from "../src/lib/domains.js"
import {
  allEventIds,
  attendeeKey,
  diagnoseListEvents,
  inclusiveEndDate,
  internalDomainsFor,
  meetingsFromListEvents,
  pastMeetingsWith,
  stripHtml,
  type CalendarEvent,
  type ListEventsScriptOutput,
} from "../src/workflows/lib/calendar.js"

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    eventId: "evt-1",
    summary: "Intro call",
    webUrl: "https://calendar.example/evt-1",
    period: {
      type: "DATE_TIME",
      start: { dateTime: "2026-09-29T17:00:00Z" },
      end: { dateTime: "2026-09-29T17:30:00Z" },
    },
    isAutoBlock: false,
    eventType: "default",
    eventStatus: "confirmed",
    attendees: [
      { isSelf: true, email: "me@example.com" },
      { isSelf: false, email: "teammate@example.com" },
      {
        isSelf: false,
        email: "Jane.Doe@Acme.example",
        displayName: "Jane Doe",
      },
      { isSelf: false, email: "bob@eu.acme.example" },
      { isSelf: false, email: "sam@gmail.com" },
      { isSelf: false, email: "room-1@resource.calendar.google.com" },
    ],
    ...overrides,
  }
}

function output(
  events: CalendarEvent[],
  extra: Partial<ListEventsScriptOutput["accounts"][number]> = {}
) {
  return {
    accounts: [
      {
        providerName: "Google",
        email: "me@example.com",
        category: "work" as const,
        coworkersEmailDomains: ["example.org"],
        calendars: [{ isHidden: false, events }],
        ...extra,
      },
    ],
  }
}

describe("domains", () => {
  it("collapses subdomains and handles two-part suffixes", () => {
    expect(companyDomain("eu.acme.example")).toBe("acme.example")
    expect(companyDomain("mail.example.co.uk")).toBe("example.co.uk")
    expect(companyDomain("acme.example")).toBe("acme.example")
  })

  it("treats subdomains of internal domains as internal", () => {
    const internal = new Set(["example.com"])
    expect(isInternalDomain("eng.example.com", internal)).toBe(true)
    expect(isInternalDomain("notexample.com", internal)).toBe(false)
  })

  it("derives readable names", () => {
    expect(companyNameFromDomain("big-co.io")).toBe("Big Co")
    expect(nameFromEmail("jane.doe@acme.example")).toBe("Jane Doe")
  })
})

describe("meetingsFromListEvents", () => {
  it("reads every account selected by the target, including hidden calendars", () => {
    const data = {
      accounts: [
        ...output([event({ eventId: "work" })]).accounts,
        ...output([event({ eventId: "personal" })], {
          email: "me@gmail.com",
          category: "personal",
          calendars: [
            { isHidden: true, events: [event({ eventId: "personal" })] },
          ],
        }).accounts,
      ],
    }
    expect(
      meetingsFromListEvents(data).map((meeting) => meeting.eventId)
    ).toEqual(["work", "personal"])
    expect(allEventIds(data)).toEqual(["work", "personal"])
  })

  it("diagnoses selected calendars using each account's own internal domains", () => {
    const data = {
      accounts: [
        ...output([
          event({ attendees: [{ isSelf: false, email: "peer@example.com" }] }),
        ]).accounts,
        ...output(
          [event({ attendees: [{ isSelf: false, email: "peer@gmail.com" }] })],
          {
            email: "me@gmail.com",
            category: "personal",
            coworkersEmailDomains: [],
          }
        ).accounts,
      ],
    }
    expect(meetingsFromListEvents(data)[0]?.attendees[0]?.email).toBe(
      "peer@gmail.com"
    )
    expect(diagnoseListEvents(data).attendeeDomains).toEqual({
      "example.com": 1,
      "gmail.com": 1,
    })
  })

  it("keeps only outside attendees, grouped by company domain", () => {
    const [meeting] = meetingsFromListEvents(output([event()]))
    expect(meeting?.attendees).toEqual([
      {
        email: "bob@eu.acme.example",
        name: "Bob",
        companyDomain: "acme.example",
      },
      {
        email: "jane.doe@acme.example",
        name: "Jane Doe",
        companyDomain: "acme.example",
      },
      { email: "sam@gmail.com", name: "Sam", companyDomain: null },
    ])
    expect(meeting?.start).toBe("2026-09-29T17:00:00Z")
    expect(meeting?.cancelled).toBe(false)
  })

  it("skips internal-only meetings, auto-blocks, and focus time", () => {
    const internalOnly = event({
      eventId: "internal",
      attendees: [
        { isSelf: true, email: "me@example.com" },
        { isSelf: false, email: "a@example.org" },
      ],
    })
    const autoBlock = event({ eventId: "block", isAutoBlock: true })
    const focus = event({ eventId: "focus", eventType: "focusTime" })
    expect(
      meetingsFromListEvents(output([internalOnly, autoBlock, focus]))
    ).toEqual([])
  })

  it("includes coworkers only when the development flag is on", () => {
    const internalOnly = event({
      attendees: [
        { isSelf: true, email: "me@example.com" },
        { isSelf: false, email: "teammate@example.com" },
        { isSelf: false, email: "room-1@resource.calendar.google.com" },
      ],
    })
    expect(meetingsFromListEvents(output([internalOnly]))).toEqual([])
    const [meeting] = meetingsFromListEvents(output([internalOnly]), {
      includeInternal: true,
    })
    expect(meeting?.attendees.map((a) => a.email)).toEqual([
      "teammate@example.com",
    ])
  })

  it("reports every event ID, including ones the attendee filter drops", () => {
    const internalOnly = event({
      eventId: "internal",
      attendees: [{ isSelf: false, email: "a@example.com" }],
    })
    const data = output([event(), internalOnly])
    expect(meetingsFromListEvents(data).map((m) => m.eventId)).toEqual([
      "evt-1",
    ])
    expect(allEventIds(data).sort()).toEqual(["evt-1", "internal"])
  })

  it("deduplicates an event that appears on two calendars", () => {
    const data = output([event()])
    data.accounts[0]!.calendars.push({ isHidden: false, events: [event()] })
    expect(meetingsFromListEvents(data)).toHaveLength(1)
  })

  it("reads all-day periods and cancelled status", () => {
    const [meeting] = meetingsFromListEvents(
      output([
        event({
          eventStatus: "cancelled",
          period: {
            type: "DATE",
            start: { date: "2026-09-30" },
            end: { date: "2026-10-01" },
          },
        }),
      ])
    )
    // Google's exclusive end (Oct 1) becomes a single-day Notion date.
    expect(meeting).toMatchObject({
      isAllDay: true,
      start: "2026-09-30",
      end: null,
      cancelled: true,
    })
  })

  it("does not treat every gmail.com attendee as internal for a personal account", () => {
    const internal = internalDomainsFor({
      email: "me@gmail.com",
      coworkersEmailDomains: [],
    })
    expect(internal.has("gmail.com")).toBe(false)
  })
})

describe("helpers", () => {
  it("converts Google's exclusive all-day end to Notion's inclusive end", () => {
    expect(inclusiveEndDate("2026-09-28", "2026-10-03")).toBe("2026-10-02")
    expect(inclusiveEndDate("2026-09-30", "2026-10-01")).toBeNull()
  })

  it("builds an order-independent attendee key", () => {
    expect(
      attendeeKey([{ email: "b@x.example" }, { email: "a@x.example" }])
    ).toBe("a@x.example, b@x.example")
  })

  it("strips calendar description HTML", () => {
    expect(stripHtml("<p>Agenda</p><ul><li>One</li></ul>&amp; more")).toBe(
      "Agenda\nOne\n& more"
    )
  })
})

describe("pastMeetingsWith", () => {
  const at = (id: string, day: string, extra: Partial<CalendarEvent> = {}) =>
    event({
      eventId: id,
      summary: `Meeting ${id}`,
      period: {
        type: "DATE_TIME",
        start: { dateTime: `2026-09-${day}T17:00:00Z` },
        end: { dateTime: `2026-09-${day}T17:30:00Z` },
      },
      ...extra,
    })
  const now = Date.parse("2026-09-29T12:00:00Z")

  it("uses history from every selected account", () => {
    const data = {
      accounts: [
        ...output([at("work", "10")]).accounts,
        ...output([at("personal", "20")], {
          email: "me@gmail.com",
          category: "personal",
        }).accounts,
      ],
    }
    expect(
      pastMeetingsWith([data], ["jane.doe@acme.example"], now, 10)[
        "jane.doe@acme.example"
      ]?.map((meeting) => meeting.eventId)
    ).toEqual(["personal", "work"])
  })

  it("keeps meetings that happened, newest first, across listEvents calls", () => {
    const result = pastMeetingsWith(
      [
        output([at("a", "10"), at("b", "20")]),
        output([
          at("b", "20"),
          at("cancelled", "21", { eventStatus: "cancelled" }),
          at("declined", "22", { responseStatus: "declined" }),
          at("block", "23", { isAutoBlock: true }),
          at("future", "30"),
        ]),
      ],
      ["jane.doe@acme.example", "nobody@acme.example"],
      now,
      10
    )
    expect(result["jane.doe@acme.example"]?.map((m) => m.eventId)).toEqual([
      "b",
      "a",
    ])
    expect(result["nobody@acme.example"]).toEqual([])
  })

  it("limits each attendee's list", () => {
    const result = pastMeetingsWith(
      [output([at("a", "10"), at("b", "20"), at("c", "25")])],
      ["jane.doe@acme.example"],
      now,
      2
    )
    expect(result["jane.doe@acme.example"]?.map((m) => m.title)).toEqual([
      "Meeting c",
      "Meeting b",
    ])
  })
})
