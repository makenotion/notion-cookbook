import { describe, expect, it } from "vitest"

import {
  SYNC_REQUEST_TIMEOUT_MS,
  idleSync,
  initialQuery,
  reduceQuery,
  reduceSync,
  type QueryEvent,
  type QueryState,
} from "../blocks/main_ui/live.js"

const run = (events: QueryEvent<string>[], from = initialQuery<string>()) =>
  events.reduce<QueryState<string>>(reduceQuery, from)
const snap = (items: string[], isLoading = false) => ({
  type: "snapshot" as const,
  snapshot: { items, isLoading },
})

describe("reduceQuery", () => {
  it("ignores the SDK's empty placeholder before the first result", () => {
    const state = run([snap([])])
    expect(state.loaded).toBe(false)
    expect(run([snap([]), snap([], true)]).loaded).toBe(false)
  })

  it("is loaded after the query was seen loading, even with no rows", () => {
    const state = run([snap([]), snap([], true), snap([])])
    expect(state).toMatchObject({ loaded: true, items: [] })
  })

  it("is loaded at once by a snapshot with rows", () => {
    expect(run([snap(["a"])])).toMatchObject({ loaded: true, items: ["a"] })
  })

  it("keeps the previous rows while a changed query reloads", () => {
    const settled = run([snap([], true), snap(["a", "b"])])
    const reloading = run(
      [{ type: "resubscribe" }, snap([]), snap([], true)],
      settled
    )
    expect(reloading).toMatchObject({ loaded: true, items: ["a", "b"] })
    expect(run([snap(["c"])], reloading).items).toEqual(["c"])
  })

  it("settles on an error and keeps the rows", () => {
    const settled = run([snap(["a"])])
    const failed = reduceQuery(settled, {
      type: "snapshot",
      snapshot: { items: [], isLoading: false, error: { message: "nope" } },
    })
    expect(failed).toMatchObject({ loaded: true, hasData: true, items: ["a"] })
    expect(failed.error?.message).toBe("nope")
  })

  it("marks a first-time error as loaded but without data", () => {
    const failed = reduceQuery(initialQuery<string>(), {
      type: "snapshot",
      snapshot: { items: [], isLoading: false, error: { message: "429" } },
    })
    expect(failed).toMatchObject({ loaded: true, hasData: false, items: [] })
  })

  it("settles on timeout only if the query never showed as loading", () => {
    const timeout = {
      type: "timeout" as const,
      snapshot: { items: [], isLoading: false },
    }
    expect(run([snap([]), timeout]).loaded).toBe(true)
    expect(run([snap([], true), timeout]).loaded).toBe(false)
  })
})

describe("reduceSync", () => {
  const click = (now: number, latestRunId: string | null) => ({
    type: "click" as const,
    now,
    latestRunId,
  })

  it("ignores a second click while pending", () => {
    const pending = reduceSync(idleSync, click(0, "old"))
    expect(pending.status).toBe("pending")
    expect(reduceSync(pending, click(10, "old"))).toBe(pending)
  })

  it("stays pending while the old failed run is still the newest", () => {
    const pending = reduceSync(idleSync, click(0, "failed-run"))
    expect(reduceSync(pending, { type: "latest", runId: "failed-run" })).toBe(
      pending
    )
    expect(reduceSync(pending, { type: "latest", runId: null })).toBe(pending)
  })

  it("ends when a new run row appears", () => {
    const pending = reduceSync(idleSync, click(0, "failed-run"))
    expect(reduceSync(pending, { type: "latest", runId: "new-run" })).toEqual(
      idleSync
    )
    const first = reduceSync(idleSync, click(0, null))
    expect(reduceSync(first, { type: "latest", runId: "new-run" })).toEqual(
      idleSync
    )
  })

  it("ends on error, keeping the message, or after the timeout", () => {
    const pending = reduceSync(idleSync, click(0, null))
    expect(reduceSync(pending, { type: "failed", message: "denied" })).toEqual({
      status: "idle",
      error: "denied",
    })
    expect(
      reduceSync(pending, { type: "tick", now: SYNC_REQUEST_TIMEOUT_MS - 1 })
    ).toBe(pending)
    expect(
      reduceSync(pending, { type: "tick", now: SYNC_REQUEST_TIMEOUT_MS })
    ).toEqual(idleSync)
  })
})
