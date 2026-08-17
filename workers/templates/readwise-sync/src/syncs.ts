import { highlightToChange } from "./highlights.js"
import type {
  ReaderDocument,
  ReadwiseClient,
  ReadwiseSource,
} from "./readwise.js"
import {
  exportSourceToChange,
  readerDocumentToChange,
  readwiseBookToChange,
} from "./sources.js"
import {
  INITIAL_UPDATED_AFTER,
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

type SourcePage = {
  changes: SourceChange[]
  nextPageCursor: string | undefined
  booksCount?: number
}

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

function booksExpectedCount(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("Readwise source sync state has an invalid Books count.")
  }
  return Number(value)
}

async function sourcePage(
  client: ReadwiseClient,
  currentPhase: SyncPhase,
  options: {
    updatedAfter: string
    updatedBefore: string
    pageCursor?: string
    initialBackfill: boolean
  }
): Promise<SourcePage> {
  if (currentPhase === "books") {
    const pageNumber = options.pageCursor
      ? Number(options.pageCursor)
      : undefined
    if (
      pageNumber !== undefined &&
      (!Number.isSafeInteger(pageNumber) || pageNumber < 1)
    ) {
      throw new Error("Readwise source sync state has an invalid book page.")
    }
    const page = await client.listReadwiseBooks({
      updatedAfter: options.updatedAfter,
      updatedBefore: options.updatedBefore,
      ...(pageNumber !== undefined ? { page: pageNumber } : {}),
    })
    return {
      changes: uniqueChanges(
        page.books.map(readwiseBookToChange).filter(defined),
        "book page"
      ),
      nextPageCursor:
        page.nextPage !== undefined ? String(page.nextPage) : undefined,
      booksCount: page.count,
    }
  }

  if (currentPhase === "reader") {
    const page = await client.listReaderDocuments({
      updatedAfter: options.updatedAfter,
      ...(options.pageCursor ? { pageCursor: options.pageCursor } : {}),
    })
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
    updatedAfter: options.updatedAfter,
    ...(options.pageCursor ? { pageCursor: options.pageCursor } : {}),
    // Historical tombstones would create blank archive rows for records this
    // deployment never imported. Start requesting them after the backfill.
    includeDeleted: !options.initialBackfill,
  })
  return {
    changes: uniqueChanges(
      page.sources
        .map((source: ReadwiseSource) => exportSourceToChange(source))
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
  const window = incrementalWindow(state, client.credentialFingerprint(), now)
  const currentPhase = phase(state?.phase)
  const expectedBooksCount = booksExpectedCount(state?.booksExpectedCount)
  if (currentPhase !== "books" && expectedBooksCount !== undefined) {
    throw new Error(
      "Readwise source sync state retained a Books count in another phase."
    )
  }
  if (
    currentPhase === "books" &&
    (window.pageCursor !== undefined) !== (expectedBooksCount !== undefined)
  ) {
    throw new Error(
      "Readwise source sync state has incomplete Books pagination."
    )
  }

  const restart = (restartCount: number) => ({
    changes: [] as SourceChange[],
    hasMore: true as const,
    nextState: boundedSyncState(
      {
        credentialFingerprint: window.credentialFingerprint,
        updatedAfter: window.updatedAfter,
        checkpoint: window.checkpoint,
        phase: currentPhase,
        paginationRestartCount: restartCount,
      } satisfies SourcesIncrementalSyncState,
      "incremental sources"
    ),
  })

  let page: SourcePage
  try {
    page = await sourcePage(client, currentPhase, {
      updatedAfter: window.updatedAfter,
      updatedBefore: window.checkpoint,
      initialBackfill: window.updatedAfter === INITIAL_UPDATED_AFTER,
      ...(window.pageCursor ? { pageCursor: window.pageCursor } : {}),
    })
  } catch (error) {
    if (!(error instanceof PaginationInstabilityError)) throw error
    return restart(
      nextPaginationRestartCount(
        state?.paginationRestartCount,
        `${currentPhase} sources`
      )
    )
  }

  // Books uses offset pagination. Pinning the documented raw count catches a
  // live-data shift that could otherwise move an unseen record onto an
  // already-read page and permanently advance past its metadata update.
  if (
    currentPhase === "books" &&
    expectedBooksCount !== undefined &&
    page.booksCount !== expectedBooksCount
  ) {
    return restart(
      nextPaginationRestartCount(state?.paginationRestartCount, "Books sources")
    )
  }

  if (page.nextPageCursor) {
    const progress = cursorProgress(
      state,
      page.nextPageCursor,
      `${currentPhase} sources`
    )
    if (progress.kind === "restart") {
      return restart(progress.restartCount)
    }

    return {
      changes: page.changes,
      hasMore: true,
      nextState: boundedSyncState(
        {
          credentialFingerprint: window.credentialFingerprint,
          updatedAfter: window.updatedAfter,
          checkpoint: window.checkpoint,
          phase: currentPhase,
          ...(currentPhase === "books"
            ? { booksExpectedCount: page.booksCount }
            : {}),
          ...(progress.restartCount > 0
            ? { paginationRestartCount: progress.restartCount }
            : {}),
          ...progress.cursor,
        } satisfies SourcesIncrementalSyncState,
        "incremental sources"
      ),
    }
  }

  if (currentPhase === "books" || currentPhase === "readwise") {
    return {
      changes: page.changes,
      hasMore: true,
      nextState: boundedSyncState(
        {
          credentialFingerprint: window.credentialFingerprint,
          updatedAfter: window.updatedAfter,
          checkpoint: window.checkpoint,
          phase: currentPhase === "books" ? "readwise" : "reader",
        } satisfies SourcesIncrementalSyncState,
        "incremental sources"
      ),
    }
  }

  return {
    changes: page.changes,
    hasMore: false,
    nextState: boundedSyncState(
      completedIncrementalState(
        window.checkpoint,
        window.credentialFingerprint
      ),
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
  const window = incrementalWindow(state, client.credentialFingerprint(), now)
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
            credentialFingerprint: window.credentialFingerprint,
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
          credentialFingerprint: window.credentialFingerprint,
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
      completedIncrementalState(
        window.checkpoint,
        window.credentialFingerprint
      ),
      "incremental highlights"
    ),
  }
}
