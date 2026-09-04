// Bounded state for Intercom endpoints that use starting_after cursors.
// Resource modules own their schedules and time windows; this file only
// prevents a malformed cursor cycle from running forever.

export type CursorSyncState = {
  after: string
  recentCursors: string[]
  pageCount: number
}

export type PaginationGuardState = {
  recentPageKeys: string[]
  pageCount: number
}

export const MAX_CURSOR_HISTORY = 128
export const MAX_CURSOR_PAGES = 10_000

export function lastAscendingRecordId(
  recordIds: string[],
  previousRecordId: string | undefined,
  resourceName: string
): string | undefined {
  let lastRecordId = previousRecordId
  if (lastRecordId !== undefined && !lastRecordId.trim()) {
    throw new Error(
      `Intercom ${resourceName} pagination has an invalid record-order checkpoint.`
    )
  }

  for (const recordId of recordIds) {
    if (typeof recordId !== "string" || !recordId.trim()) {
      throw new Error(
        `Intercom ${resourceName} pagination returned an invalid record id.`
      )
    }
    // Intercom models these API IDs as strings. If its service applies a
    // different collation, fail closed instead of completing a replacement
    // whose requested ordering cannot be verified.
    if (lastRecordId !== undefined && recordId <= lastRecordId) {
      throw new Error(
        `Intercom ${resourceName} did not return records in strictly ascending id order.`
      )
    }
    lastRecordId = recordId
  }

  return lastRecordId
}

export function validatedRecentCursors(value: string[] | undefined): string[] {
  if (value === undefined) return []
  if (
    !Array.isArray(value) ||
    value.length > MAX_CURSOR_HISTORY ||
    value.some((cursor) => typeof cursor !== "string" || !cursor.trim())
  ) {
    throw new Error(
      "Intercom pagination recentCursors must contain a bounded cursor history."
    )
  }
  return value
}

export function validatedPageCount(value: number | undefined): number {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0 || value >= MAX_CURSOR_PAGES) {
    throw new Error(
      "Intercom pagination pageCount is outside its safety bound."
    )
  }
  return value
}

export function advancePageGuard(
  state: { recentPageKeys?: string[]; pageCount?: number } | undefined,
  pageKey: string,
  resourceName: string
): PaginationGuardState {
  if (!pageKey.trim()) {
    throw new Error(
      `Intercom ${resourceName} pagination has an empty page key.`
    )
  }
  const recentPageKeys = validatedRecentCursors(state?.recentPageKeys)
  if (recentPageKeys.includes(pageKey)) {
    throw new Error(`Intercom ${resourceName} pagination repeated a page.`)
  }
  const pageCount = validatedPageCount(state?.pageCount) + 1
  if (pageCount >= MAX_CURSOR_PAGES) {
    throw new Error(
      `Intercom ${resourceName} pagination exceeded ${MAX_CURSOR_PAGES} pages.`
    )
  }
  return {
    recentPageKeys: [...recentPageKeys, pageKey].slice(-MAX_CURSOR_HISTORY),
    pageCount,
  }
}

export function nextCursorState(
  state:
    | { after?: string; recentCursors?: string[]; pageCount?: number }
    | undefined,
  nextCursor: string | undefined,
  resourceName: string
): CursorSyncState {
  if (!nextCursor?.trim()) {
    throw new Error(
      `Intercom ${resourceName} pagination is missing starting_after.`
    )
  }

  const seen = new Set(validatedRecentCursors(state?.recentCursors))
  if (state?.after) seen.add(state.after)
  if (seen.has(nextCursor)) {
    throw new Error(`Intercom ${resourceName} pagination repeated cursor.`)
  }

  const pageCount = validatedPageCount(state?.pageCount) + 1
  if (pageCount >= MAX_CURSOR_PAGES) {
    throw new Error(
      `Intercom ${resourceName} pagination exceeded ${MAX_CURSOR_PAGES} pages.`
    )
  }

  seen.add(nextCursor)
  return {
    after: nextCursor,
    recentCursors: [...seen].slice(-MAX_CURSOR_HISTORY),
    pageCount,
  }
}
