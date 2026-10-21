// Pure, serializable sync-state helpers. Keeping this transition separate
// makes the safety properties of a multi-page replacement sweep
// straightforward to test.
//
// All three Stripe syncs run in "replace" mode on a fixed schedule, so unlike
// linear-sync there is no incremental watermark state to track here — only
// the cursor-pagination loop protection.

export type CursorSyncState = {
  after: string
  seenCursors: string[]
}

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
    throw new Error(`Stripe ${resourceName} pagination is missing next cursor`)
  }

  const seenCursors = new Set(state?.seenCursors ?? [])
  if (state?.after) seenCursors.add(state.after)
  if (seenCursors.has(nextCursor)) {
    throw new Error(`Stripe ${resourceName} pagination repeated cursor`)
  }

  return {
    after: nextCursor,
    seenCursors: [...seenCursors, nextCursor],
  }
}
