// Pure, serializable sync-state helpers. Keeping these transitions separate
// makes the safety properties of a multi-page sync straightforward to test.

export type CursorSyncState = {
  after: string
  seenCursors: string[]
}

export type IssueIncrementalSyncState = {
  since: string
  until?: string
  after?: string
  seenCursors?: string[]
}

export const INITIAL_ISSUE_WATERMARK = new Date(0).toISOString()
export const CONSISTENCY_BUFFER_MS = 15_000
export const WATERMARK_OVERLAP_MS = 60_000

/**
 * Record every cursor in persisted state so a longer cycle such as A -> B -> A
 * fails instead of keeping a replacement run alive forever.
 */
export function nextCursorState(
  state: { after?: string; seenCursors?: string[] } | undefined,
  nextCursor: string | undefined,
  resourceName: string
): CursorSyncState {
  if (!nextCursor) {
    throw new Error(`Linear ${resourceName} pagination is missing next cursor`)
  }

  const seenCursors = new Set(state?.seenCursors ?? [])
  if (state?.after) seenCursors.add(state.after)
  if (seenCursors.has(nextCursor)) {
    throw new Error(`Linear ${resourceName} pagination repeated cursor`)
  }

  return {
    after: nextCursor,
    seenCursors: [...seenCursors, nextCursor],
  }
}

/** Pin an incremental window until every cursor page has completed. */
export function issueIncrementalWindow(
  state: IssueIncrementalSyncState | undefined,
  now = Date.now()
): { since: string; until: string } {
  return {
    since: state?.since ?? INITIAL_ISSUE_WATERMARK,
    until:
      state?.until ??
      new Date(Math.max(0, now - CONSISTENCY_BUFFER_MS)).toISOString(),
  }
}

/** Advance the watermark with overlap after the final page succeeds. */
export function nextIssueWatermark(until: string): string {
  const parsedUntil = Date.parse(until)
  if (!Number.isFinite(parsedUntil)) {
    throw new Error("Linear issues incremental window has an invalid end time")
  }

  return new Date(Math.max(0, parsedUntil - WATERMARK_OVERLAP_MS)).toISOString()
}
