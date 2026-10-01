// Pure state machines behind the block's hooks, kept here so they can be
// tested without a host.

// ---- Data source queries ---------------------------------------------------

/**
 * The parts of a data source snapshot the block relies on. `useDataSource`
 * returns an empty, not-loading result before its first snapshot and after
 * every change of options, so that alone cannot tell "no rows" apart from
 * "not asked yet".
 */
export type Snapshot<T> = {
  items: readonly T[]
  isLoading: boolean
  error?: { message: string }
}

export type QueryState<T> = {
  /** "init" until this subscription's query has been seen in flight. */
  phase: "init" | "loading" | "settled"
  /** The last settled rows, kept across resubscribes. */
  items: readonly T[]
  error?: { message: string }
  /** Whether any subscription has settled, with rows or an error. */
  loaded: boolean
  /** Whether `items` came from a successful result (not just an error). */
  hasData: boolean
}

export type QueryEvent<T> =
  | { type: "snapshot"; snapshot: Snapshot<T> }
  | { type: "resubscribe" }
  /**
   * Fired a while after subscribing. If the query was never seen in flight,
   * the latest snapshot is taken as the result rather than waiting forever.
   */
  | { type: "timeout"; snapshot: Snapshot<T> }

export function initialQuery<T>(): QueryState<T> {
  return { phase: "init", items: [], loaded: false, hasData: false }
}

/**
 * Track one live query. Rows are replaced only by a settled result: a
 * not-loading snapshot after the query was seen loading, or one that has
 * rows. An empty, not-loading snapshot before that is the SDK's placeholder
 * and is ignored. A resubscribe (new options) keeps the previous rows until
 * the new query settles, so changing a filter does not flash empty states.
 */
export function reduceQuery<T>(
  state: QueryState<T>,
  event: QueryEvent<T>
): QueryState<T> {
  switch (event.type) {
    case "resubscribe":
      return { ...state, phase: "init" }
    case "timeout":
      if (state.phase !== "init") return state
      return settle(state, event.snapshot)
    case "snapshot": {
      const { snapshot } = event
      if (snapshot.error)
        return {
          ...state,
          phase: "settled",
          error: snapshot.error,
          loaded: true,
        }
      if (snapshot.isLoading) return { ...state, phase: "loading" }
      if (state.phase === "init" && snapshot.items.length === 0) return state
      return settle(state, snapshot)
    }
  }
}

function settle<T>(state: QueryState<T>, snapshot: Snapshot<T>): QueryState<T> {
  if (snapshot.error)
    return { ...state, phase: "settled", error: snapshot.error, loaded: true }
  return {
    phase: "settled",
    items: snapshot.items,
    loaded: true,
    hasData: true,
  }
}

// ---- Sync calendar requests -----------------------------------------------

/** A request is released after this long even if no new run row shows up. */
export const SYNC_REQUEST_TIMEOUT_MS = 60_000

export type SyncRequest =
  | { status: "idle"; error: string | null }
  | { status: "pending"; sinceMs: number; baselineRunId: string | null }

export type SyncEvent =
  /** The viewer pressed Sync; `latestRunId` is the newest run row then. */
  | { type: "click"; now: number; latestRunId: string | null }
  /** The newest run row changed. */
  | { type: "latest"; runId: string | null }
  | { type: "failed"; message: string }
  | { type: "tick"; now: number }

export const idleSync: SyncRequest = { status: "idle", error: null }

/**
 * Guards the Sync button. A click while a request is pending changes
 * nothing (and the caller must not create a row). The request ends when a
 * run row appears that was not the newest at click time, when creating the
 * row fails, or after SYNC_REQUEST_TIMEOUT_MS. An older row, such as the
 * failed run being retried, never ends it.
 */
export function reduceSync(state: SyncRequest, event: SyncEvent): SyncRequest {
  switch (event.type) {
    case "click":
      if (state.status === "pending") return state
      return {
        status: "pending",
        sinceMs: event.now,
        baselineRunId: event.latestRunId,
      }
    case "latest":
      if (
        state.status === "pending" &&
        event.runId !== null &&
        event.runId !== state.baselineRunId
      )
        return idleSync
      return state
    case "failed":
      return { status: "idle", error: event.message }
    case "tick":
      if (
        state.status === "pending" &&
        event.now - state.sinceMs >= SYNC_REQUEST_TIMEOUT_MS
      )
        return idleSync
      return state
  }
}
