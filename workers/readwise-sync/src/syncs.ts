import { highlightToChange } from "./highlights.js"
import type {
  ReaderDocument,
  ReadwiseClient,
  ReadwiseSource,
} from "./readwise.js"
import { exportSourceToChange, readerDocumentToChange } from "./sources.js"
import {
  INITIAL_UPDATED_AFTER,
  SYNC_STATE_VERSION,
  PaginationInstabilityError,
  boundedSyncState,
  completedIncrementalState,
  incrementalWindow,
  nextCursorState,
  nextPaginationRestartCount,
  paginationRestartCount,
  phase,
  type CursorGuardState,
  type IncrementalSyncState,
  type SourcesIncrementalSyncState,
  type SyncPhase,
} from "./state.js"

type SourceChange = NonNullable<ReturnType<typeof exportSourceToChange>>
type HighlightChange = ReturnType<typeof highlightToChange>

function defined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function uniqueChanges<T extends { key: string }>(
  changes: T[],
  label: string
): T[] {
  const keys = new Set<string>()
  for (const change of changes) {
    if (keys.has(change.key)) {
      throw new Error(`Readwise ${label} returned duplicate key ${change.key}.`)
    }
    keys.add(change.key)
  }
  return changes
}

type CursorProgress =
  | {
      kind: "continue"
      cursor: Required<CursorGuardState>
      restartCount: number
    }
  | { kind: "restart"; restartCount: number }

function cursorProgress(
  state: IncrementalSyncState | undefined,
  nextPageCursor: string,
  resource: string
): CursorProgress {
  try {
    return {
      kind: "continue",
      cursor: nextCursorState(state, nextPageCursor, resource),
      restartCount: paginationRestartCount(state?.paginationRestartCount),
    }
  } catch (error) {
    if (!(error instanceof PaginationInstabilityError)) throw error
    return {
      kind: "restart",
      restartCount: nextPaginationRestartCount(
        state?.paginationRestartCount,
        resource
      ),
    }
  }
}

async function sourcePage(
  client: ReadwiseClient,
  currentPhase: SyncPhase,
  options: {
    updatedAfter: string
    pageCursor?: string
    initialBackfill: boolean
  }
): Promise<{ changes: SourceChange[]; nextPageCursor: string | undefined }> {
  if (currentPhase === "reader") {
    const page = await client.listReaderDocuments(options)
    return {
      changes: uniqueChanges(
        page.documents
          .map((document: ReaderDocument) => readerDocumentToChange(document))
          .filter(defined),
        "Reader document page"
      ),
      nextPageCursor: page.nextPageCursor,
    }
  }

  const page = await client.exportHighlights({
    ...options,
    // Historical tombstones would create blank archive rows for records this
    // deployment never imported. Start requesting them after the backfill.
    includeDeleted: !options.initialBackfill,
  })
  return {
    changes: uniqueChanges(
      page.sources
        .map((source: ReadwiseSource) =>
          exportSourceToChange(source, {
            initialBackfill: options.initialBackfill,
          })
        )
        .filter(defined),
      "source export page"
    ),
    nextPageCursor: page.nextPageCursor,
  }
}

export async function runSourcesIncrementalPage(
  client: ReadwiseClient,
  state: SourcesIncrementalSyncState | undefined,
  now = Date.now()
) {
  const window = incrementalWindow(state, now)
  const currentPhase = phase(state?.phase)
  const page = await sourcePage(client, currentPhase, {
    updatedAfter: window.updatedAfter,
    initialBackfill: window.updatedAfter === INITIAL_UPDATED_AFTER,
    ...(window.pageCursor ? { pageCursor: window.pageCursor } : {}),
  })

  if (page.nextPageCursor) {
    const progress = cursorProgress(
      state,
      page.nextPageCursor,
      `${currentPhase} sources`
    )
    if (progress.kind === "restart") {
      return {
        changes: [] as SourceChange[],
        hasMore: true,
        nextState: boundedSyncState(
          {
            stateVersion: SYNC_STATE_VERSION,
            updatedAfter: window.updatedAfter,
            checkpoint: window.checkpoint,
            phase: currentPhase,
            paginationRestartCount: progress.restartCount,
          } satisfies SourcesIncrementalSyncState,
          "incremental sources"
        ),
      }
    }

    return {
      changes: page.changes,
      hasMore: true,
      nextState: boundedSyncState(
        {
          stateVersion: SYNC_STATE_VERSION,
          updatedAfter: window.updatedAfter,
          checkpoint: window.checkpoint,
          phase: currentPhase,
          ...(progress.restartCount > 0
            ? { paginationRestartCount: progress.restartCount }
            : {}),
          ...progress.cursor,
        } satisfies SourcesIncrementalSyncState,
        "incremental sources"
      ),
    }
  }

  if (currentPhase === "readwise") {
    return {
      changes: page.changes,
      hasMore: true,
      nextState: boundedSyncState(
        {
          stateVersion: SYNC_STATE_VERSION,
          updatedAfter: window.updatedAfter,
          checkpoint: window.checkpoint,
          phase: "reader",
        } satisfies SourcesIncrementalSyncState,
        "incremental sources"
      ),
    }
  }

  return {
    changes: page.changes,
    hasMore: false,
    nextState: boundedSyncState(
      completedIncrementalState(window.checkpoint),
      "incremental sources"
    ),
  }
}

function highlightChanges(sources: ReadwiseSource[]): HighlightChange[] {
  return uniqueChanges(
    sources.flatMap((source) =>
      source.highlights.map((highlight) => highlightToChange(source, highlight))
    ),
    "highlight export page"
  )
}

export async function runHighlightsIncrementalPage(
  client: ReadwiseClient,
  state: IncrementalSyncState | undefined,
  now = Date.now()
) {
  const window = incrementalWindow(state, now)
  const page = await client.exportHighlights({
    updatedAfter: window.updatedAfter,
    ...(window.pageCursor ? { pageCursor: window.pageCursor } : {}),
    includeDeleted: window.updatedAfter !== INITIAL_UPDATED_AFTER,
  })
  const changes = highlightChanges(page.sources)

  if (page.nextPageCursor) {
    const progress = cursorProgress(state, page.nextPageCursor, "highlights")
    if (progress.kind === "restart") {
      return {
        changes: [] as HighlightChange[],
        hasMore: true,
        nextState: boundedSyncState(
          {
            stateVersion: SYNC_STATE_VERSION,
            updatedAfter: window.updatedAfter,
            checkpoint: window.checkpoint,
            paginationRestartCount: progress.restartCount,
          } satisfies IncrementalSyncState,
          "incremental highlights"
        ),
      }
    }

    return {
      changes,
      hasMore: true,
      nextState: boundedSyncState(
        {
          stateVersion: SYNC_STATE_VERSION,
          updatedAfter: window.updatedAfter,
          checkpoint: window.checkpoint,
          ...(progress.restartCount > 0
            ? { paginationRestartCount: progress.restartCount }
            : {}),
          ...progress.cursor,
        } satisfies IncrementalSyncState,
        "incremental highlights"
      ),
    }
  }

  return {
    changes,
    hasMore: false,
    nextState: boundedSyncState(
      completedIncrementalState(window.checkpoint),
      "incremental highlights"
    ),
  }
}
