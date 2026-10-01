import { describe, expect, it } from "vitest"

import type { NotionDataSourcePage } from "@notionhq/apps/custom-blocks"
import {
  MEETINGS_LOOKBACK_DAYS,
  RUNS_QUERY,
  deriveMeetings,
  deriveRuns,
  meetingsQuery,
  meetingsWindowStart,
} from "../blocks/main_ui/derive.js"

const row = (id: string, props: Record<string, unknown>) =>
  ({
    id,
    propertiesById: {},
    propertiesByKey: props,
  }) as unknown as NotionDataSourcePage

const when = (date: string, time: string) => ({
  type: "datetime",
  start_date: date,
  start_time: time,
})

describe("query options", () => {
  it("keep the same window and JSON all day, so the query is not replaced", () => {
    const morning = new Date(2026, 8, 29, 8).getTime()
    const evening = new Date(2026, 8, 29, 23, 59).getTime()
    expect(meetingsWindowStart(morning)).toBe(meetingsWindowStart(evening))
    expect(JSON.stringify(meetingsQuery(meetingsWindowStart(morning)))).toBe(
      JSON.stringify(meetingsQuery(meetingsWindowStart(evening)))
    )
    expect(Date.parse(meetingsWindowStart(morning))).toBe(
      new Date(2026, 8, 29 - MEETINGS_LOOKBACK_DAYS).getTime()
    )
  })

  it("moves the window once the day changes", () => {
    expect(meetingsWindowStart(new Date(2026, 8, 30, 0, 1).getTime())).not.toBe(
      meetingsWindowStart(new Date(2026, 8, 29, 23, 59).getTime())
    )
  })

  it("read the newest runs first", () => {
    expect(RUNS_QUERY.sorts).toEqual([
      { key: "Started", direction: "descending" },
    ])
  })
})

describe("deriveRuns", () => {
  it("takes the newest row as the latest run and counts successes up to 2", () => {
    const rows = [
      row("new", { Status: "Pending", Started: when("2026-09-29", "17:00") }),
      row("a", { Status: "Success" }),
      row("b", { Status: "Failed", Error: "boom" }),
      row("c", { Status: "Success" }),
      row("d", { Status: "Success" }),
    ]
    expect(deriveRuns(rows)).toEqual({
      latestRun: {
        id: "new",
        status: "Pending",
        startedMs: Date.parse("2026-09-29T17:00:00Z"),
        error: "",
      },
      successRuns: 2,
    })
    expect(deriveRuns([])).toEqual({ latestRun: null, successRuns: 0 })
  })
})

describe("deriveMeetings", () => {
  it("sorts the one meetings array and finds the populated signals", () => {
    const rows = [
      row("late", {
        When: when("2026-09-29", "18:00"),
        "Prep status": "Queued",
      }),
      row("early", {
        When: when("2026-09-29", "09:00"),
        "Prep status": "Researching",
      }),
    ]
    const queued = deriveMeetings(rows)
    expect(queued.meetings.map((r) => r.id)).toEqual(["early", "late"])
    expect(queued).toMatchObject({
      hasPrepUpdated: false,
      hasPrepFinished: false,
    })

    expect(
      deriveMeetings([
        ...rows,
        row("done", {
          When: when("2026-09-28", "09:00"),
          "Prep status": "Failed",
        }),
      ]).hasPrepFinished
    ).toBe(true)
    expect(
      deriveMeetings([
        row("old", {
          When: when("2026-09-28", "09:00"),
          "Prep status": "Researching",
          "Prep updated": when("2026-09-28", "08:00"),
        }),
      ]).hasPrepUpdated
    ).toBe(true)
  })
})
