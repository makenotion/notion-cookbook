// Pure, serializable state helpers for the rolling replacement scan.

import type { SentryIssueScope } from "./sentry.js"

export const ISSUE_WINDOW_DAYS = 30
// Workers rejects nextState above 256 KiB. Keep explicit headroom so future
// state fields cannot turn a useful scope error into a runtime rejection.
export const MAX_SAFE_SYNC_STATE_LENGTH = 240 * 1024
const DAY_MS = 24 * 60 * 60 * 1_000

export type IssueSyncState = {
  start: string
  end: string
  scope: SentryIssueScope
  cursor?: string
  seenCursors?: string[]
}

export type IssueWindow = {
  start: string
  end: string
}

/** Fail with scope guidance before Workers rejects an oversized continuation. */
export function boundedSyncState<T>(state: T, resource: string): T {
  const serializedLength = JSON.stringify(state).length
  if (serializedLength > MAX_SAFE_SYNC_STATE_LENGTH) {
    throw new Error(
      `Sentry ${resource} continuation state exceeded the 240 KiB safety budget (${Math.ceil(
        serializedLength / 1024
      )} KiB); narrow SENTRY_PROJECTS so the refresh can continue safely.`
    )
  }
  return state
}

function validTimestamp(value: string | undefined): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
}

/** Pin the rolling window until every page in the full refresh has finished. */
export function issueWindow(
  state: IssueSyncState | undefined,
  now = Date.now()
): IssueWindow {
  if (state) {
    if (!validTimestamp(state.start) || !validTimestamp(state.end)) {
      throw new Error("Sentry issue sync state has an invalid time window")
    }
    if (Date.parse(state.start) >= Date.parse(state.end)) {
      throw new Error("Sentry issue sync state must start before it ends")
    }
    return { start: state.start, end: state.end }
  }

  if (!Number.isFinite(now) || now < 0) {
    throw new Error("Cannot create a Sentry issue window from an invalid time")
  }

  return {
    start: new Date(
      Math.max(0, now - ISSUE_WINDOW_DAYS * DAY_MS)
    ).toISOString(),
    end: new Date(now).toISOString(),
  }
}

/**
 * Persist every cursor in the current traversal so A → B → A fails closed
 * instead of leaving a replacement run alive forever.
 */
export function nextIssueState(
  state: IssueSyncState | undefined,
  window: IssueWindow,
  scope: SentryIssueScope,
  nextCursor: string | undefined
): IssueSyncState {
  const traversal = nextCursorTraversal(
    state?.cursor,
    state?.seenCursors,
    nextCursor,
    "issue"
  )

  return {
    ...window,
    scope,
    ...traversal,
  }
}

export function nextCursorTraversal(
  currentCursor: string | undefined,
  priorCursors: string[] | undefined,
  nextCursor: string | undefined,
  resource: string
): { cursor: string; seenCursors: string[] } {
  const cursor = nextCursor?.trim()
  if (!cursor) {
    throw new Error(`Sentry ${resource} pagination is missing its next cursor`)
  }

  const seenCursors = new Set(priorCursors ?? [])
  if (currentCursor) seenCursors.add(currentCursor)
  if (seenCursors.has(cursor)) {
    throw new Error(`Sentry ${resource} pagination repeated a cursor`)
  }
  seenCursors.add(cursor)
  return { cursor, seenCursors: [...seenCursors] }
}
