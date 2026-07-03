import { highlightToChange } from "./highlights.js"
import type { ReadwiseClient } from "./readwise.js"
import { exportSourceToChange, readerDocumentToChange } from "./sources.js"
import {
  SYNC_STATE_VERSION,
  completedIncrementalState,
  incrementalWindow,
  nextCursorState,
  phase,
  reconciliationCursor,
  type IncrementalSyncState,
  type ReconciliationSyncState,
  type SourcesIncrementalSyncState,
  type SourcesReconciliationSyncState,
  type SyncPhase,
} from "./state.js"

type SourceChange =
  | NonNullable<ReturnType<typeof readerDocumentToChange>>
  | NonNullable<ReturnType<typeof exportSourceToChange>>

type SourcesIncrementalPageResult = {
  changes: SourceChange[]
  hasMore: boolean
  nextState: SourcesIncrementalSyncState
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

async function sourcePage(
  client: ReadwiseClient,
  currentPhase: SyncPhase,
  options: {
    updatedAfter?: string
    pageCursor?: string
    includeDeleted: boolean
  }
): Promise<{ changes: SourceChange[]; nextPageCursor: string | undefined }> {
  if (currentPhase === "reader") {
    const page = await client.listReaderDocuments({
      ...(options.updatedAfter ? { updatedAfter: options.updatedAfter } : {}),
      ...(options.pageCursor ? { pageCursor: options.pageCursor } : {}),
    })
    return {
      changes: uniqueChanges(
        page.documents
          .map(readerDocumentToChange)
          .filter((change): change is NonNullable<typeof change> =>
            Boolean(change)
          ),
        "Reader document page"
      ),
      nextPageCursor: page.nextPageCursor,
    }
  }

  const page = await client.exportHighlights({
    ...(options.updatedAfter ? { updatedAfter: options.updatedAfter } : {}),
    ...(options.pageCursor ? { pageCursor: options.pageCursor } : {}),
    includeDeleted: options.includeDeleted,
  })
  return {
    changes: uniqueChanges(
      page.sources
        .map(exportSourceToChange)
        .filter((change): change is NonNullable<typeof change> =>
          Boolean(change)
        ),
      "source export page"
    ),
    nextPageCursor: page.nextPageCursor,
  }
}

export async function runSourcesIncrementalPage(
  client: ReadwiseClient,
  state: SourcesIncrementalSyncState | undefined,
  now = Date.now()
): Promise<SourcesIncrementalPageResult> {
  const window = incrementalWindow(state, now)
  const currentPhase = phase(state?.phase)
  const page = await sourcePage(client, currentPhase, {
    updatedAfter: window.updatedAfter,
    pageCursor: window.pageCursor,
    includeDeleted: true,
  })

  if (page.nextPageCursor) {
    return {
      changes: page.changes,
      hasMore: true,
      nextState: {
        stateVersion: SYNC_STATE_VERSION,
        updatedAfter: window.updatedAfter,
        checkpoint: window.checkpoint,
        phase: currentPhase,
        ...nextCursorState(
          state,
          page.nextPageCursor,
          `${currentPhase} sources`
        ),
      } satisfies SourcesIncrementalSyncState,
    }
  }

  if (currentPhase === "readwise") {
    return {
      changes: page.changes,
      hasMore: true,
      nextState: {
        stateVersion: SYNC_STATE_VERSION,
        updatedAfter: window.updatedAfter,
        checkpoint: window.checkpoint,
        phase: "reader",
      } satisfies SourcesIncrementalSyncState,
    }
  }

  return {
    changes: page.changes,
    hasMore: false,
    nextState: completedIncrementalState(window.checkpoint),
  }
}

export async function runSourcesReconciliationPage(
  client: ReadwiseClient,
  state: SourcesReconciliationSyncState | undefined
) {
  const currentPhase = phase(state?.phase)
  const pageCursor = reconciliationCursor(state)
  const page = await sourcePage(client, currentPhase, {
    ...(pageCursor ? { pageCursor } : {}),
    includeDeleted: false,
  })

  if (page.nextPageCursor) {
    return {
      changes: page.changes,
      hasMore: true,
      nextState: {
        stateVersion: SYNC_STATE_VERSION,
        phase: currentPhase,
        ...nextCursorState(
          state,
          page.nextPageCursor,
          `${currentPhase} sources`
        ),
      } satisfies SourcesReconciliationSyncState,
    }
  }

  if (currentPhase === "readwise") {
    return {
      changes: page.changes,
      hasMore: true,
      nextState: {
        stateVersion: SYNC_STATE_VERSION,
        phase: "reader",
      } satisfies SourcesReconciliationSyncState,
    }
  }

  return { changes: page.changes, hasMore: false }
}

function highlightChanges(
  sources: Awaited<ReturnType<ReadwiseClient["exportHighlights"]>>["sources"]
) {
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
    includeDeleted: true,
  })
  const changes = highlightChanges(page.sources)

  if (page.nextPageCursor) {
    return {
      changes,
      hasMore: true,
      nextState: {
        stateVersion: SYNC_STATE_VERSION,
        updatedAfter: window.updatedAfter,
        checkpoint: window.checkpoint,
        ...nextCursorState(state, page.nextPageCursor, "highlights"),
      } satisfies IncrementalSyncState,
    }
  }

  return {
    changes,
    hasMore: false,
    nextState: completedIncrementalState(window.checkpoint),
  }
}

export async function runHighlightsReconciliationPage(
  client: ReadwiseClient,
  state: ReconciliationSyncState | undefined
) {
  const pageCursor = reconciliationCursor(state)
  const page = await client.exportHighlights({
    ...(pageCursor ? { pageCursor } : {}),
    includeDeleted: false,
  })
  const changes = highlightChanges(page.sources)

  if (page.nextPageCursor) {
    return {
      changes,
      hasMore: true,
      nextState: {
        stateVersion: SYNC_STATE_VERSION,
        ...nextCursorState(state, page.nextPageCursor, "highlights"),
      } satisfies ReconciliationSyncState,
    }
  }

  return { changes, hasMore: false }
}
