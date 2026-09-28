import { describe, expect, it, vi } from "vitest"

import { queryAll, type Notion } from "../src/lib/props.js"
import type { MeetingInput } from "../src/workflows/lib/calendar.js"
import {
  needsUpdate,
  upsertMeetings,
  type StoredMeeting,
} from "../src/workflows/lib/ingest.js"
import { ensureRelations } from "../src/workflows/lib/relations.js"

const page = (id: string, properties: Record<string, unknown> = {}) => ({
  object: "page",
  id,
  properties,
})

describe("queryAll", () => {
  it("follows cursors until has_more is false", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        results: [page("a"), page("b")],
        has_more: true,
        next_cursor: "c1",
      })
      .mockResolvedValueOnce({
        results: [page("c")],
        has_more: false,
        next_cursor: null,
      })
    const notion = { dataSources: { query } } as unknown as Notion
    const pages = await queryAll(notion, { data_source_id: "ds" })
    expect(pages.map((p) => p.id)).toEqual(["a", "b", "c"])
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ start_cursor: "c1" })
    )
  })
})

const meeting: MeetingInput = {
  eventId: "evt-1",
  title: "Intro",
  start: "2026-09-29T17:00:00Z",
  end: "2026-09-29T17:30:00Z",
  isAllDay: false,
  cancelled: false,
  agenda: "",
  calendarUrl: "https://cal/evt-1",
  videoUrl: null,
  attendees: [
    { email: "jane@acme.example", name: "Jane", companyDomain: "acme.example" },
  ],
}

const stored: StoredMeeting = {
  pageId: "m1",
  title: "Intro",
  // Notion returns the same instant with an offset.
  start: "2026-09-29T10:00:00.000-07:00",
  end: "2026-09-29T10:30:00.000-07:00",
  status: "Scheduled",
  attendees: "jane@acme.example",
  agenda: "",
  videoUrl: null,
  calendarUrl: "https://cal/evt-1",
}

describe("needsUpdate", () => {
  it("treats equal instants in different offsets as unchanged", () => {
    expect(needsUpdate(meeting, stored)).toBe(false)
  })

  it("detects attendee and time changes", () => {
    expect(
      needsUpdate({ ...meeting, start: "2026-09-29T18:00:00Z" }, stored)
    ).toBe(true)
    expect(needsUpdate(meeting, { ...stored, attendees: "" })).toBe(true)
    expect(needsUpdate(meeting, undefined)).toBe(true)
  })
})

/** A replaying step runner: completed keys return their saved value. */
function replayingStep() {
  const saved = new Map<string, unknown>()
  const step = (async (name: string, optsOrFn: unknown, maybeFn?: unknown) => {
    const opts =
      typeof optsOrFn === "function"
        ? {}
        : (optsOrFn as { key?: string | string[] })
    const fn = (
      typeof optsOrFn === "function" ? optsOrFn : maybeFn
    ) as () => unknown
    const key = JSON.stringify(opts.key ?? name)
    if (saved.has(key)) return saved.get(key)
    const value = (await fn()) ?? null
    saved.set(key, value)
    return value
  }) as Parameters<typeof upsertMeetings>[0]
  return { step, saved }
}

describe("upsertMeetings", () => {
  it("looks rows up before creating, so a retried create does not duplicate", async () => {
    const rows: Record<string, ReturnType<typeof page>[]> = {
      companies: [],
      people: [],
      meetings: [],
    }
    let nextId = 0
    const notion = {
      dataSources: {
        query: vi.fn(
          async ({ data_source_id }: { data_source_id: string }) => ({
            results: rows[data_source_id]!.slice(0, 1),
            has_more: false,
            next_cursor: null,
          })
        ),
      },
      pages: {
        create: vi.fn(
          async ({ parent }: { parent: { data_source_id: string } }) => {
            const created = page(`id-${nextId++}`)
            rows[parent.data_source_id]!.push(created)
            return created
          }
        ),
        update: vi.fn(async () => ({})),
      },
    } as unknown as Notion
    const ids = {
      meetings: "meetings",
      people: "people",
      companies: "companies",
    }

    // First attempt: every write succeeds.
    const first = replayingStep()
    await expect(
      upsertMeetings(first.step, notion, ids, [meeting], {})
    ).resolves.toEqual({ created: 1, updated: 0 })

    // A later run whose stored snapshot missed the new row updates instead of creating.
    const second = replayingStep()
    await expect(
      upsertMeetings(second.step, notion, ids, [meeting], {})
    ).resolves.toEqual({ created: 0, updated: 1 })
    expect(rows.meetings).toHaveLength(1)
    expect(rows.people).toHaveLength(1)
    expect(rows.companies).toHaveLength(1)
  })

  it("skips meetings that have not changed", async () => {
    const notion = {
      dataSources: { query: vi.fn() },
      pages: { create: vi.fn(), update: vi.fn() },
    }
    const { step } = replayingStep()
    await upsertMeetings(
      step,
      notion as unknown as Notion,
      { meetings: "m", people: "p", companies: "c" },
      [meeting],
      {
        "evt-1": stored,
      }
    )
    expect(notion.dataSources.query).not.toHaveBeenCalled()
  })
})

describe("ensureRelations", () => {
  it("adds only missing relations", async () => {
    const update = vi.fn(async () => ({}))
    const retrieve = vi.fn(
      async ({ data_source_id }: { data_source_id: string }) => ({
        properties:
          data_source_id === "m" ? { Title: {}, Attendees: {} } : { Name: {} },
      })
    )
    const notion = { dataSources: { retrieve, update } } as unknown as Notion
    const created = await ensureRelations(notion, {
      meetings: "m",
      people: "p",
      companies: "c",
    })
    expect(created).toEqual(["meetings.Companies", "people.Company"])
    expect(update).toHaveBeenCalledWith({
      data_source_id: "m",
      properties: {
        Companies: {
          relation: {
            data_source_id: "c",
            type: "dual_property",
            dual_property: { synced_property_name: "Meetings" },
          },
        },
      },
    })
  })
})
