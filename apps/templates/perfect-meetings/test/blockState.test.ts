import { describe, expect, it } from "vitest"

import type { NotionDataSourcePage } from "@notionhq/apps/custom-blocks"
import {
  STALE_RUN_MS,
  attendeeCopy,
  blockState,
  canSync,
  latchPopulated,
  quietSync,
  researchProgress,
  runStartedMs,
  statusText,
  type BlockStateInput,
} from "../blocks/main_ui/state.js"

const NOW = Date.parse("2026-09-29T17:00:00Z")

function input(overrides: Partial<BlockStateInput> = {}): BlockStateInput {
  return {
    latestRun: null,
    successRuns: 0,
    hasPrepUpdated: false,
    hasPrepFinished: false,
    meetingCount: 0,
    progress: { done: 0, total: 0, stalled: 0 },
    now: NOW,
    ...overrides,
  }
}

const run = (status: string | null, error = "", startedMs = NOW - 60_000) => ({
  id: "run-1",
  status,
  startedMs,
  error,
})

const at = (iso: string) => {
  const [date, time] = iso.split("T") as [string, string]
  return { date, time: time.slice(0, 5) }
}

function meeting(
  id: string,
  props: {
    prep?: string
    attendees?: string
    start?: string
    end?: string
    status?: string
    lastEditedMs?: number
  } = {}
): NotionDataSourcePage {
  const edited = at(new Date(props.lastEditedMs ?? NOW - 60_000).toISOString())
  const start = at(props.start ?? "2026-09-29T18:00:00Z")
  const end = at(props.end ?? "2026-09-29T19:00:00Z")
  return {
    id,
    propertiesById: {
      last_edited_time: {
        type: "datetime",
        start_date: edited.date,
        start_time: edited.time,
      },
    },
    propertiesByKey: {
      "Prep status": props.prep ?? "",
      "Attendee emails": props.attendees ?? "a@acme.com",
      Status: props.status ?? "Scheduled",
      When: {
        type: "datetimerange",
        start_date: start.date,
        start_time: start.time,
        end_date: end.date,
        end_time: end.time,
      },
    },
  } as unknown as NotionDataSourcePage
}

describe("blockState", () => {
  it("is never_run without any run rows", () => {
    const state = blockState(input())
    expect(state).toEqual({ kind: "never_run" })
    expect(canSync(state)).toBe(true)
  })

  it("is waiting while the latest run has no Status", () => {
    const state = blockState(input({ latestRun: run(null), meetingCount: 0 }))
    expect(state).toEqual({ kind: "waiting", stale: false })
    expect(statusText(state)).toBe("Waiting for flow to start")
    expect(canSync(state)).toBe(false)
  })

  it("is syncing while the latest run is Pending", () => {
    const state = blockState(input({ latestRun: run("Pending") }))
    expect(state).toEqual({ kind: "syncing", stale: false })
    expect(statusText(state)).toBe("Reading latest calendar events")
    expect(canSync(state)).toBe(false)
  })

  it("lets a stuck waiting or syncing run be retried", () => {
    const old = NOW - STALE_RUN_MS - 1
    for (const status of [null, "Pending"]) {
      const state = blockState(input({ latestRun: run(status, "", old) }))
      expect(state).toMatchObject({ stale: true })
      expect(canSync(state)).toBe(true)
    }
  })

  it("is researching after a successful sync while meetings are queued", () => {
    const state = blockState(
      input({
        latestRun: run("Success"),
        successRuns: 1,
        meetingCount: 3,
        progress: { done: 1, total: 3, stalled: 0 },
      })
    )
    expect(state).toEqual({
      kind: "researching",
      done: 1,
      total: 3,
      stalled: 0,
    })
    expect(statusText(state)).toBe(
      "Researching companies and people (1 of 3 meetings ready)"
    )
    expect(canSync(state)).toBe(false)
  })

  it("is failed with the run's error before the App is populated", () => {
    const state = blockState(
      input({ latestRun: run("Failed", "Calendar not connected") })
    )
    expect(state).toEqual({ kind: "failed", error: "Calendar not connected" })
    expect(canSync(state)).toBe(true)
    expect(blockState(input({ latestRun: run("Failed", "  ") }))).toMatchObject(
      { kind: "failed", error: expect.stringContaining("failed") }
    )
  })

  it("is ready once a successful sync has nothing left to research", () => {
    expect(
      blockState(
        input({
          latestRun: run("Success"),
          successRuns: 1,
          meetingCount: 2,
          progress: { done: 2, total: 2, stalled: 0 },
        })
      )
    ).toEqual({ kind: "ready", noMeetings: false })
  })

  it("never regresses once a meeting has Prep updated", () => {
    for (const latestRun of [
      null,
      run(null),
      run("Pending"),
      run("Failed", "boom"),
      run("Success"),
    ]) {
      const state = blockState(
        input({
          latestRun,
          hasPrepUpdated: true,
          meetingCount: 4,
          progress: { done: 0, total: 4, stalled: 0 },
        })
      )
      expect(state).toEqual({ kind: "ready", noMeetings: false })
      expect(canSync(state)).toBe(false)
    }
  })

  it("treats a successful sync with no outside meetings as populated", () => {
    const empty = input({
      latestRun: run("Success"),
      successRuns: 1,
      meetingCount: 0,
    })
    expect(blockState(empty)).toEqual({ kind: "ready", noMeetings: true })
    // Later runs that are pending or fail do not bring back setup states.
    for (const latestRun of [run(null), run("Pending"), run("Failed", "x")])
      expect(blockState({ ...empty, latestRun })).toEqual({
        kind: "ready",
        noMeetings: true,
      })
  })
})

describe("researchProgress", () => {
  it("counts upcoming meetings, with Ready and Failed as done", () => {
    const rows = [
      meeting("queued", { prep: "Queued" }),
      meeting("researching", { prep: "Researching" }),
      meeting("ready", { prep: "Ready" }),
      meeting("failed", { prep: "Failed" }),
      // Duplicates from overlapping queries count once.
      meeting("ready", { prep: "Ready" }),
    ]
    expect(researchProgress(rows, NOW)).toEqual({
      done: 2,
      total: 4,
      stalled: 0,
    })
  })

  it("skips meetings research will not cover", () => {
    const rows = [
      // Ended and still Queued: prep skips past meetings.
      meeting("past", {
        prep: "Queued",
        start: "2026-09-28T18:00:00Z",
        end: "2026-09-28T19:00:00Z",
      }),
      meeting("cancelled", { prep: "Queued", status: "Cancelled" }),
      meeting("no-attendees", { prep: "Queued", attendees: "" }),
      meeting("empty-status"),
    ]
    expect(researchProgress(rows, NOW)).toEqual({
      done: 0,
      total: 0,
      stalled: 0,
    })
  })

  it("keeps a meeting being researched even after it ends", () => {
    const rows = [
      meeting("late", {
        prep: "Researching",
        start: "2026-09-29T15:00:00Z",
        end: "2026-09-29T16:00:00Z",
      }),
    ]
    expect(researchProgress(rows, NOW)).toEqual({
      done: 0,
      total: 1,
      stalled: 0,
    })
  })
})

describe("attendeeCopy", () => {
  it("says when a meeting has no outside attendees", () => {
    expect(
      attendeeCopy(meeting("m", { attendees: "" }), 0, false, NOW)
    ).toEqual({
      kind: "message",
      text: "No outside attendees on this meeting.",
    })
  })

  it("waits for the people query before deciding", () => {
    expect(attendeeCopy(meeting("m", { prep: "Ready" }), 0, true, NOW)).toEqual(
      { kind: "loading" }
    )
  })

  it("says still loading only while research is running or due", () => {
    for (const prep of ["Queued", "Researching"])
      expect(attendeeCopy(meeting("m", { prep }), 0, false, NOW)).toEqual({
        kind: "message",
        text: "Attendee details are still loading.",
      })
    const done = attendeeCopy(meeting("m", { prep: "Ready" }), 0, false, NOW)
    expect(done.kind === "message" && done.text).not.toContain("still loading")
    const past = attendeeCopy(
      meeting("m", {
        prep: "Queued",
        start: "2026-09-28T18:00:00Z",
        end: "2026-09-28T19:00:00Z",
      }),
      0,
      false,
      NOW
    )
    expect(past.kind === "message" && past.text).not.toContain("still loading")
  })

  it("points to Regenerate prep when prep failed", () => {
    const copy = attendeeCopy(meeting("m", { prep: "Failed" }), 0, false, NOW)
    expect(copy.kind === "message" && copy.text).toContain("Regenerate prep")
    const withCards = attendeeCopy(
      meeting("m", { prep: "Failed" }),
      2,
      false,
      NOW
    )
    expect(withCards).toMatchObject({ kind: "cards" })
    expect(withCards.kind === "cards" && withCards.note).toContain(
      "Regenerate prep"
    )
  })

  it("shows cards once attendees are found", () => {
    expect(
      attendeeCopy(meeting("m", { prep: "Researching" }), 1, true, NOW)
    ).toEqual({ kind: "cards", note: null })
  })
})

describe("populated", () => {
  it("counts a Ready or Failed meeting as populated, even without Prep updated", () => {
    const state = blockState(
      input({
        latestRun: run("Pending"),
        hasPrepFinished: true,
        meetingCount: 2,
        progress: { done: 0, total: 2, stalled: 0 },
      })
    )
    expect(state).toEqual({ kind: "ready", noMeetings: false })
  })

  it("counts a second successful sync as populated", () => {
    const base = input({
      latestRun: run("Pending"),
      meetingCount: 3,
      progress: { done: 0, total: 3, stalled: 0 },
    })
    expect(blockState({ ...base, successRuns: 1 }).kind).toBe("syncing")
    expect(blockState({ ...base, successRuns: 2 }).kind).toBe("ready")
  })

  it("latches for the session once populated", () => {
    const empty = input({
      latestRun: run("Success"),
      successRuns: 1,
      meetingCount: 0,
    })
    let latched = latchPopulated(false, empty)
    expect(latched).toBe(true)
    // Meetings arrive and the next sync is pending: still ready.
    const later = input({
      latestRun: run("Pending"),
      successRuns: 1,
      meetingCount: 2,
      progress: { done: 0, total: 2, stalled: 0 },
    })
    latched = latchPopulated(latched, later)
    expect(latched).toBe(true)
    expect(blockState(later, latched)).toEqual({
      kind: "ready",
      noMeetings: false,
    })
    // An unknown input (still loading) never clears the latch.
    expect(latchPopulated(true, null)).toBe(true)
    expect(latchPopulated(false, null)).toBe(false)
  })
})

describe("stuck research", () => {
  const stuck = NOW - STALE_RUN_MS - 1

  it("counts stuck Queued or Researching meetings as stalled, not pending", () => {
    const rows = [
      meeting("fresh", { prep: "Researching" }),
      meeting("stuck", { prep: "Researching", lastEditedMs: stuck }),
      meeting("stuck-queued", { prep: "Queued", lastEditedMs: stuck }),
    ]
    expect(researchProgress(rows, NOW)).toEqual({
      done: 0,
      total: 1,
      stalled: 2,
    })
  })

  it("lets the viewer act while some meetings are stuck", () => {
    const state = blockState(
      input({
        latestRun: run("Success"),
        successRuns: 1,
        meetingCount: 3,
        progress: { done: 1, total: 2, stalled: 1 },
      })
    )
    expect(canSync(state)).toBe(true)
    expect(statusText(state)).toContain("Regenerate prep")
  })

  it("leaves researching once only stuck meetings remain", () => {
    const rows = [
      meeting("stuck", { prep: "Researching", lastEditedMs: stuck }),
    ]
    const state = blockState(
      input({
        latestRun: run("Success"),
        successRuns: 1,
        meetingCount: 1,
        progress: researchProgress(rows, NOW),
      })
    )
    expect(state.kind).toBe("ready")
    const copy = attendeeCopy(rows[0]!, 0, false, NOW)
    expect(copy.kind === "message" && copy.text).toContain("stuck")
  })
})

describe("runStartedMs", () => {
  it("falls back to the row's created time when Started is empty", () => {
    const row = (started: unknown) =>
      ({
        id: "r",
        propertiesByKey: { Started: started },
        propertiesById: {
          created_time: {
            type: "datetime",
            start_date: "2026-09-29",
            start_time: "16:00",
          },
        },
      }) as unknown as NotionDataSourcePage
    expect(runStartedMs(row(undefined))).toBe(
      Date.parse("2026-09-29T16:00:00Z")
    )
    expect(
      runStartedMs(
        row({ type: "datetime", start_date: "2026-09-29", start_time: "16:30" })
      )
    ).toBe(Date.parse("2026-09-29T16:30:00Z"))
    // A stale run with no Started is still recognised as stale.
    const state = blockState(
      input({
        latestRun: {
          id: "r",
          status: null,
          startedMs: runStartedMs(row(undefined)),
          error: "",
        },
      })
    )
    expect(state).toEqual({ kind: "waiting", stale: true })
  })
})

describe("quietSync", () => {
  it("is idle when the newest run finished", () => {
    for (const status of ["Success", "Failed"])
      expect(quietSync(run(status), false, NOW)).toEqual({
        inFlight: false,
        status: null,
      })
    expect(quietSync(null, false, NOW).inFlight).toBe(false)
  })

  it("shows Syncing while a click is pending or a run is waiting or Pending", () => {
    const syncing = { inFlight: true, status: "Syncing…" }
    expect(quietSync(run("Success"), true, NOW)).toEqual(syncing)
    expect(quietSync(run(null), false, NOW)).toEqual(syncing)
    expect(quietSync(run("Pending"), false, NOW)).toEqual(syncing)
  })

  it("comes back for a stuck run", () => {
    const old = NOW - STALE_RUN_MS - 1
    expect(quietSync(run("Pending", "", old), false, NOW).inFlight).toBe(false)
  })
})
