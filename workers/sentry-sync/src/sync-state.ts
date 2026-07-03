// Pure, serializable state helpers for the rolling replacement scan.

import { createHash } from "node:crypto"

import type { SentryScope } from "./sentry.js"

export const ISSUE_WINDOW_DAYS = 30
// Workers rejects nextState above 256 KiB. Keep explicit headroom so future
// state fields cannot turn a useful scope error into a runtime rejection.
export const MAX_SAFE_SYNC_STATE_LENGTH = 240 * 1024
export const MAX_RECENT_CURSOR_FINGERPRINTS = 32
const DAY_MS = 24 * 60 * 60 * 1_000
const textEncoder = new TextEncoder()

export type IssueSyncState = {
  start: string
  end: string
  scope: SentryScope
  cursor?: string
  seenCursors?: string[]
}

export type IssueWindow = {
  start: string
  end: string
}

/** Apply a conservative UTF-8 byte budget below the runtime's string limit. */
export function syncStateSize(state: unknown): number {
  return textEncoder.encode(JSON.stringify(state)).byteLength
}

export function syncStateFits(
  state: unknown,
  limit = MAX_SAFE_SYNC_STATE_LENGTH
): boolean {
  return syncStateSize(state) <= limit
}

/** Fail before Workers rejects an oversized continuation. */
export function boundedSyncState<T>(state: T, resource: string): T {
  const serializedLength = syncStateSize(state)
  if (serializedLength > MAX_SAFE_SYNC_STATE_LENGTH) {
    throw new Error(
      `Sentry ${resource} continuation state exceeded the 240 KiB safety budget (${Math.ceil(
        serializedLength / 1024
      )} KiB); the current refresh cannot continue safely.`
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

/** Keep recent cursor fingerprints so common loops fail without growing state. */
export function nextIssueState(
  state: IssueSyncState | undefined,
  window: IssueWindow,
  scope: SentryScope,
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

  // Persist compact fingerprints instead of provider-controlled cursor text.
  // A bounded recent history catches common cursor cycles without introducing
  // an artificial maximum page count or unbounded continuation state.
  const fingerprint = (value: string): string =>
    /^h:[A-Za-z0-9_-]{22}$/.test(value)
      ? value
      : `h:${createHash("sha256").update(value).digest("base64url").slice(0, 22)}`
  let recentCursors = (priorCursors ?? [])
    .map(fingerprint)
    .slice(-MAX_RECENT_CURSOR_FINGERPRINTS)
  if (currentCursor) {
    const currentFingerprint = fingerprint(currentCursor)
    if (!recentCursors.includes(currentFingerprint)) {
      recentCursors.push(currentFingerprint)
      recentCursors = recentCursors.slice(-MAX_RECENT_CURSOR_FINGERPRINTS)
    }
  }
  const nextFingerprint = fingerprint(cursor)
  if (recentCursors.includes(nextFingerprint)) {
    throw new Error(`Sentry ${resource} pagination repeated a cursor`)
  }
  return {
    cursor,
    seenCursors: [...recentCursors, nextFingerprint].slice(
      -MAX_RECENT_CURSOR_FINGERPRINTS
    ),
  }
}
