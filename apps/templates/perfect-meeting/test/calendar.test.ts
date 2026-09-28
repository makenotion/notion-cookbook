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
  inclusiveEndDate,
  currentOrNextMeeting,
  internalDomainsFor,
  meetingsFromListEvents,
  pickBusinessAccount,
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

  it("prefers the work Google account", () => {
    const accounts = [
      {
        providerName: "Google",
        category: "personal" as const,
        email: "me@gmail.com",
      },
      {
        providerName: "Google",
        category: "work" as const,
        email: "me@acme.example",
      },
    ]
    expect(pickBusinessAccount(accounts)?.email).toBe("me@acme.example")
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

describe("currentOrNextMeeting", () => {
  const base = meetingsFromListEvents(output([event()]))[0]!
  const at = (id: string, start: string, end: string, cancelled = false) => ({
    ...base,
    eventId: id,
    start,
    end,
    cancelled,
  })
  const meetings = [
    at("later", "2026-09-29T20:00:00Z", "2026-09-29T21:00:00Z"),
    at("offsite", "2026-09-29", "2026-10-01"),
    at("done", "2026-09-29T15:00:00Z", "2026-09-29T16:00:00Z"),
    at("cancelled", "2026-09-29T16:30:00Z", "2026-09-29T17:30:00Z", true),
  ]

  it("prefers the event in progress with the earliest start", () => {
    expect(
      currentOrNextMeeting(meetings, Date.parse("2026-09-29T17:00:00Z"))
        ?.eventId
    ).toBe("offsite")
  })

  it("falls through to the next meeting", () => {
    expect(
      currentOrNextMeeting(
        meetings.slice(0, 1),
        Date.parse("2026-09-29T17:00:00Z")
      )?.eventId
    ).toBe("later")
    expect(
      currentOrNextMeeting(meetings, Date.parse("2026-10-02T00:00:00Z"))
    ).toBeNull()
  })
})
