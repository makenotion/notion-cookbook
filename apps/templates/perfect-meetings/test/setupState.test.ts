import { describe, expect, it } from "vitest"
import type { NotionDataSourcePage } from "@notionhq/apps/custom-blocks"
import { initialQuery, type QueryState } from "../blocks/main_ui/live.js"
import {
  setupStages,
  morningScheduleLabel,
  type SetupQueries,
} from "../blocks/main_ui/setupState.js"

const NOW = Date.parse("2026-10-02T12:00:00Z")
const researching = {
  kind: "researching" as const,
  done: 0,
  total: 2,
  stalled: 0,
}
const row = (status: string, properties: Record<string, unknown> = {}) =>
  ({
    id: status,
    propertiesById: {},
    propertiesByKey: { "Research status": status, ...properties },
  }) as unknown as NotionDataSourcePage
const loaded = (
  items: NotionDataSourcePage[] = []
): QueryState<NotionDataSourcePage> => ({
  phase: "settled",
  loaded: true,
  hasData: true,
  items,
})
const queries = (overrides: Partial<SetupQueries> = {}): SetupQueries => ({
  people: loaded(),
  companies: loaded(),
  meetings: loaded(),
  ...overrides,
})
const meeting = (status: string, day = "2026-10-03") =>
  row("Ready", {
    "Prep status": status,
    Status: "Scheduled",
    "Attendee emails": "a@acme.example",
    When: { type: "date", start_date: day },
  })

describe("first-run stages", () => {
  it("shows instructions before starting and immediate feedback while awaiting a run row", () => {
    expect(
      setupStages({ kind: "never_run" }, queries(), false, NOW).every(
        (stage) => stage.status === "pending"
      )
    ).toBe(true)
    expect(
      setupStages({ kind: "never_run" }, queries(), true, NOW)[0]
    ).toMatchObject({
      status: "active",
      title: "Syncing calendar",
      detail: "Waiting for sync to start",
    })
  })

  it("tracks overlapping work without waiting for the calendar stage to finish", () => {
    const stages = setupStages(
      { kind: "syncing", stale: false },
      queries({
        people: loaded([row("Done"), row("Researching")]),
        companies: loaded([row("Ready")]),
        meetings: loaded([meeting("Researching")]),
      }),
      false,
      NOW
    )
    expect(stages.map((stage) => stage.status)).toEqual([
      "active",
      "active",
      "pending",
      "active",
    ])
    expect(stages[1]).toMatchObject({
      title: "2 participants",
      completed: 1,
      total: 2,
    })
    expect(stages[1]?.detail).toContain("1 researching")
    expect(stages[2]?.detail).toContain("1 queued")
  })

  it("doesn't mark research complete while calendar ingestion can still add rows", () => {
    const data = queries({ people: loaded([row("Done")]) })
    expect(
      setupStages({ kind: "syncing", stale: false }, data, false, NOW)[1]
        ?.status
    ).toBe("pending")
    expect(setupStages(researching, data, false, NOW)[1]).toMatchObject({
      title: "1 participant researched",
      status: "complete",
    })
  })

  it("distinguishes unknown, failed, partial, and genuinely empty results", () => {
    const data = queries({
      people: initialQuery(),
      companies: { ...initialQuery(), error: { message: "offline" } },
    })
    const stages = setupStages(researching, data, false, NOW)
    expect(stages[1]).toMatchObject({
      status: "pending",
      detail: "Waiting for research updates",
    })
    expect(stages[1]?.total).toBeUndefined()
    expect(stages[2]).toMatchObject({
      status: "attention",
      detail: "Couldn't load progress",
    })
    expect(setupStages(researching, queries(), false, NOW)[2]).toMatchObject({
      status: "complete",
      title: "No companies to research",
    })
    const partial = setupStages(
      researching,
      queries({ people: { ...loaded([row("Done")]), hasMore: true } }),
      false,
      NOW
    )[1]!
    expect(partial.status).not.toBe("complete")
    expect(partial.detail).toContain("partial counts")
  })

  it("counts successful briefs separately from failures and skips ended queued meetings", () => {
    const stage = setupStages(
      researching,
      queries({
        meetings: loaded([
          meeting("Ready"),
          meeting("Failed"),
          meeting("Queued", "2026-10-01"),
        ]),
      }),
      false,
      NOW
    )[3]!
    expect(stage).toMatchObject({ status: "attention", completed: 1, total: 2 })
    expect(stage.detail).toContain("1 ready")
    expect(stage.detail).toContain("1 failed")
  })

  it("stops the activity indicator for stale research and failed syncs", () => {
    const stale = row("Researching")
    stale.propertiesById.last_edited_time = {
      type: "datetime",
      start_date: "2026-10-01",
      start_time: "12:00",
    }
    const stages = setupStages(
      { kind: "failed", error: "Calendar disconnected" },
      queries({ people: loaded([stale]) }),
      false,
      NOW
    )
    expect(stages[0]?.status).toBe("attention")
    expect(stages[1]?.status).toBe("attention")
    expect(stages[1]?.detail).toContain("1 may be stuck")
  })

  it("uses the configured morning time and zone across daylight-saving changes", () => {
    expect(morningScheduleLabel(NOW)).toBe("7:45 AM Pacific Time")
    expect(morningScheduleLabel(Date.parse("2026-12-01T12:00:00Z"))).toBe(
      "7:45 AM Pacific Time"
    )
  })
})
