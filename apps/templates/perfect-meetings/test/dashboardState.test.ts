import { describe, expect, it } from "vitest"
import type { NotionDataSourcePage } from "@notionhq/apps/custom-blocks"
import { calendarStatus } from "../blocks/main_ui/dashboardState.js"
import { researchActivity } from "../blocks/main_ui/derive.js"
import { STALE_RUN_MS, type LatestRun } from "../blocks/main_ui/state.js"

const NOW = Date.parse("2026-10-02T18:00:00Z")
const loaded = { hasData: true }
const run = (
  status: string | null,
  overrides: Partial<LatestRun> = {}
): LatestRun => ({
  id: "run",
  status,
  startedMs: NOW - 60_000,
  error: "",
  ...overrides,
})

describe("calendar health in the returning view", () => {
  it("keeps missing and failed queries distinct from a successfully checked calendar", () => {
    expect(calendarStatus(null, false, { hasData: false }, NOW).kind).toBe(
      "loading"
    )
    expect(
      calendarStatus(
        run("Success"),
        false,
        { hasData: true, error: { message: "offline" } },
        NOW
      ).kind
    ).toBe("unavailable")
    expect(calendarStatus(null, false, loaded, NOW).kind).toBe("idle")
  })

  it("shows an immediate request, waiting, and running as separate calendar states", () => {
    expect(calendarStatus(run("Success"), true, loaded, NOW)).toMatchObject({
      kind: "waiting",
      busy: true,
    })
    expect(calendarStatus(run(null), false, loaded, NOW)).toMatchObject({
      kind: "waiting",
      busy: true,
    })
    expect(calendarStatus(run("Pending"), false, loaded, NOW)).toMatchObject({
      kind: "syncing",
      busy: true,
    })
  })

  it("uses the finish time for freshness, and never fabricates one", () => {
    expect(
      calendarStatus(
        run("Success", { finishedMs: NOW - 180_000 }),
        false,
        loaded,
        NOW
      )
    ).toMatchObject({ kind: "success", busy: false, label: "Synced 3 min ago" })
    expect(calendarStatus(run("Success"), false, loaded, NOW).label).toBe(
      "Calendar synced"
    )
  })

  it("keeps failures visible and lets stale calendar runs be retried", () => {
    expect(
      calendarStatus(
        run("Failed", { error: "Reconnect Calendar" }),
        false,
        loaded,
        NOW
      )
    ).toMatchObject({
      kind: "failed",
      busy: false,
      detail: "Reconnect Calendar",
    })
    for (const status of [null, "Pending"]) {
      expect(
        calendarStatus(
          run(status, { startedMs: NOW - STALE_RUN_MS - 1 }),
          false,
          loaded,
          NOW
        )
      ).toMatchObject({ kind: "stale", busy: false })
    }
  })

  it("does not treat unknown statuses as a successful sync", () => {
    expect(calendarStatus(run("Unexpected"), false, loaded, NOW).kind).toBe(
      "unavailable"
    )
  })
})

describe("research activity", () => {
  it("separates stale records from running and queued work without losing the total", () => {
    const row = (status: string, edited: string): NotionDataSourcePage =>
      ({
        id: `${status}-${edited}`,
        propertiesByKey: { "Research status": status },
        propertiesById: {
          last_edited_time: {
            type: "datetime",
            start_date: "2026-10-02",
            start_time: edited,
          },
        },
      }) as unknown as NotionDataSourcePage
    const counts = researchActivity(
      [
        row("Researching", "17:59"),
        row("Researching", "17:00"),
        row("Ready", "17:59"),
        row("Ready", "17:00"),
        row("Done", "17:00"),
        row("Failed", "17:00"),
        row("", "17:00"),
      ],
      NOW
    )
    expect(counts).toEqual({
      total: 7,
      researching: 1,
      queued: 1,
      done: 1,
      failed: 1,
      stalled: 2,
      unrequested: 1,
    })
  })
})
