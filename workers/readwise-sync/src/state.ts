// State is intentionally plain JSON. An updatedAfter boundary is pinned for a
// complete pageCursor traversal and advances only after the last page succeeds.

export const SYNC_STATE_VERSION = 1
export const INITIAL_UPDATED_AFTER = new Date(0).toISOString()
export const CONSISTENCY_BUFFER_MS = 60_000
export const WATERMARK_OVERLAP_MS = 5 * 60_000
export const MAX_CURSOR_HISTORY = 128
export const MAX_CURSOR_PAGES = 10_000
export const MAX_CURSOR_LENGTH = 4_096

export type SyncPhase = "reader" | "readwise"

export type CursorGuardState = {
  pageCursor?: string
  recentCursors?: string[]
  pageCount?: number
}

export type IncrementalSyncState = CursorGuardState & {
  stateVersion: typeof SYNC_STATE_VERSION
  updatedAfter: string
  checkpoint?: string
}

export type SourcesIncrementalSyncState = IncrementalSyncState & {
  phase?: SyncPhase
}

export type ReconciliationSyncState = CursorGuardState & {
  stateVersion: typeof SYNC_STATE_VERSION
}

export type SourcesReconciliationSyncState = ReconciliationSyncState & {
  phase?: SyncPhase
}

function isoDateTime(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Readwise sync state has an invalid ${label}.`)
  }
  return value
}

function validVersion(state: { stateVersion?: unknown } | undefined) {
  if (state && state.stateVersion !== SYNC_STATE_VERSION) {
    throw new Error(
      "Readwise sync state is incompatible; reset the sync state before retrying."
    )
  }
}

function validPageCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_CURSOR_LENGTH
  ) {
    throw new Error("Readwise sync state has an invalid pageCursor.")
  }
  return value
}

function validCursorHistory(value: unknown): string[] {
  if (value === undefined) return []
  if (
    !Array.isArray(value) ||
    value.length > MAX_CURSOR_HISTORY ||
    value.some(
      (cursor) =>
        typeof cursor !== "string" ||
        !cursor.trim() ||
        cursor.length > MAX_CURSOR_LENGTH
    )
  ) {
    throw new Error("Readwise sync state has an invalid cursor history.")
  }
  return value as string[]
}

function validPageCount(value: unknown): number {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Readwise sync state has an invalid page count.")
  }
  if ((value as number) >= MAX_CURSOR_PAGES) {
    throw new Error(
      `Readwise pagination exceeded ${MAX_CURSOR_PAGES} pages in one phase.`
    )
  }
  return value as number
}

export function incrementalWindow(
  state: IncrementalSyncState | undefined,
  now = Date.now()
): { updatedAfter: string; checkpoint: string; pageCursor?: string } {
  validVersion(state)
  if (!Number.isFinite(now) || now < 0) {
    throw new Error("Readwise sync clock is invalid.")
  }

  const updatedAfter = state
    ? isoDateTime(state.updatedAfter, "updatedAfter")
    : INITIAL_UPDATED_AFTER
  const checkpoint = state?.checkpoint
    ? isoDateTime(state.checkpoint, "checkpoint")
    : new Date(Math.max(0, now - CONSISTENCY_BUFFER_MS)).toISOString()
  const pageCursor = validPageCursor(state?.pageCursor)

  if (state?.checkpoint === undefined && pageCursor !== undefined) {
    throw new Error(
      "Readwise sync state cannot resume pageCursor without a pinned checkpoint."
    )
  }
  if (Date.parse(updatedAfter) > Date.parse(checkpoint)) {
    throw new Error("Readwise sync state advances beyond its checkpoint.")
  }
  validCursorHistory(state?.recentCursors)
  validPageCount(state?.pageCount)

  return { updatedAfter, checkpoint, ...(pageCursor ? { pageCursor } : {}) }
}

export function nextCursorState(
  state: CursorGuardState | undefined,
  nextPageCursor: string | undefined,
  resourceName: string
): Required<CursorGuardState> {
  const cursor = validPageCursor(nextPageCursor)
  if (!cursor) {
    throw new Error(
      `Readwise ${resourceName} pagination is missing nextPageCursor.`
    )
  }

  const current = validPageCursor(state?.pageCursor)
  const recent = new Set(validCursorHistory(state?.recentCursors))
  if (current) recent.add(current)
  if (recent.has(cursor)) {
    throw new Error(`Readwise ${resourceName} pagination repeated a cursor.`)
  }

  const pageCount = validPageCount(state?.pageCount) + 1
  if (pageCount >= MAX_CURSOR_PAGES) {
    throw new Error(
      `Readwise ${resourceName} pagination exceeded ${MAX_CURSOR_PAGES} pages.`
    )
  }
  recent.add(cursor)

  return {
    pageCursor: cursor,
    recentCursors: [...recent].slice(-MAX_CURSOR_HISTORY),
    pageCount,
  }
}

export function completedIncrementalState(
  checkpoint: string
): IncrementalSyncState {
  const parsed = Date.parse(isoDateTime(checkpoint, "checkpoint"))
  return {
    stateVersion: SYNC_STATE_VERSION,
    updatedAfter: new Date(
      Math.max(0, parsed - WATERMARK_OVERLAP_MS)
    ).toISOString(),
  }
}

export function phase(value: unknown): SyncPhase {
  // Export runs first so the richer Reader document upsert wins last when
  // both APIs address the same reader:<id> Source row.
  if (value === undefined) return "readwise"
  if (value !== "reader" && value !== "readwise") {
    throw new Error("Readwise source sync state has an invalid phase.")
  }
  return value
}

export function reconciliationCursor(
  state: ReconciliationSyncState | undefined
): string | undefined {
  validVersion(state)
  validCursorHistory(state?.recentCursors)
  validPageCount(state?.pageCount)
  return validPageCursor(state?.pageCursor)
}
