import { highlightToChange } from "./highlights.js"
import type {
  ReaderDocument,
  ReadwiseClient,
  ReadwiseSource,
} from "./readwise.js"
import {
  exportSourceKey,
  exportSourceToChange,
  exportSourceToReconciliationChange,
  readerDocumentToChange,
  readerExternalId,
} from "./sources.js"
import {
  INITIAL_UPDATED_AFTER,
  MAX_REPLACEMENT_CURSOR_PAGES,
  SYNC_STATE_VERSION,
  ReplacementInstabilityError,
  advanceGuardedInventory,
  advanceMatchingInventory,
  assertInventoryCanContinue,
  boundCredentialFingerprint,
  boundedSyncState,
  completeInventory,
  completedIncrementalState,
  hasIdentity,
  incrementalWindow,
  inventoriesMatch,
  inventorySnapshot,
  incrementalRestartCount,
  nextCursorState,
  nextIncrementalRestartCount,
  nextReconciliationRestartCount,
  phase,
  reconciliationCursor,
  reconciliationPass,
  reconciliationRestartCount,
  sourcesReconciliationPhase,
  validateSourcesReconciliationState,
  type ActiveInventory,
  type IdentityGuardState,
  type IncrementalSyncState,
  type InventoryIdentity,
  type InventorySnapshot,
  type ReconciliationPass,
  type ReconciliationSyncState,
  type SourcesIncrementalSyncState,
  type SourcesReconciliationPhase,
  type SourcesReconciliationSyncState,
  type SyncPhase,
} from "./state.js"

type SourceChange =
  | NonNullable<ReturnType<typeof readerDocumentToChange>>
  | NonNullable<ReturnType<typeof exportSourceToChange>>
  | ReturnType<typeof exportSourceToReconciliationChange>

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

async function sourceIncrementalPage(
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
          .map((document) => readerDocumentToChange(document))
          .filter((change): change is NonNullable<typeof change> =>
            Boolean(change)
          ),
        "Reader document page"
      ),
      nextPageCursor: page.nextPageCursor,
    }
  }

  const page = await client.exportHighlights({
    ...options,
    includeDeleted: true,
  })
  return {
    changes: uniqueChanges(
      page.sources
        .map((source) =>
          exportSourceToChange(source, {
            initialBackfill: options.initialBackfill,
          })
        )
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
  const window = incrementalWindow(state, client.credentialFingerprint(), now)
  const currentPhase = phase(state?.phase)
  const page = await sourceIncrementalPage(client, currentPhase, {
    updatedAfter: window.updatedAfter,
    initialBackfill: window.updatedAfter === INITIAL_UPDATED_AFTER,
    ...(window.pageCursor ? { pageCursor: window.pageCursor } : {}),
  })

  if (page.nextPageCursor) {
    let cursorState
    try {
      cursorState = nextCursorState(
        state,
        page.nextPageCursor,
        `${currentPhase} sources`
      )
    } catch (error) {
      if (!(error instanceof ReplacementInstabilityError)) throw error
      const paginationRestartCount = nextIncrementalRestartCount(
        state?.paginationRestartCount,
        `${currentPhase} sources`
      )
      return {
        changes: [],
        hasMore: true,
        nextState: boundedSyncState(
          {
            stateVersion: SYNC_STATE_VERSION,
            credentialFingerprint: window.credentialFingerprint,
            updatedAfter: window.updatedAfter,
            checkpoint: window.checkpoint,
            phase: currentPhase,
            paginationRestartCount,
          } satisfies SourcesIncrementalSyncState,
          "incremental sources"
        ),
      }
    }
    const paginationRestartCount = incrementalRestartCount(
      state?.paginationRestartCount
    )
    const nextState = boundedSyncState(
      {
        stateVersion: SYNC_STATE_VERSION,
        credentialFingerprint: window.credentialFingerprint,
        updatedAfter: window.updatedAfter,
        checkpoint: window.checkpoint,
        phase: currentPhase,
        ...(paginationRestartCount > 0 ? { paginationRestartCount } : {}),
        ...cursorState,
      } satisfies SourcesIncrementalSyncState,
      "incremental sources"
    )
    return { changes: page.changes, hasMore: true, nextState }
  }

  if (currentPhase === "readwise") {
    const nextState = boundedSyncState(
      {
        stateVersion: SYNC_STATE_VERSION,
        credentialFingerprint: window.credentialFingerprint,
        updatedAfter: window.updatedAfter,
        checkpoint: window.checkpoint,
        phase: "reader",
      } satisfies SourcesIncrementalSyncState,
      "incremental sources"
    )
    return { changes: page.changes, hasMore: true, nextState }
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

function readerInventories(documents: ReaderDocument[]): {
  raw: InventoryIdentity[]
  output: InventoryIdentity[]
  guard: InventoryIdentity[]
  guardConflicts: InventoryIdentity[][]
} {
  const raw = documents.map((document) => ({
    namespace: "reader-document",
    value: document.id,
  }))
  const output = documents
    .filter((document) => document.parent_id === null)
    .map((document) => ({
      namespace: "reader-source-key",
      value: `reader:${document.id}`,
    }))
  const guard = documents.map((document) =>
    document.parent_id === null
      ? { namespace: "reader-source-key", value: `reader:${document.id}` }
      : { namespace: "reader-child-document", value: document.id }
  )
  const guardConflicts = documents.map((document) => [
    document.parent_id === null
      ? { namespace: "reader-child-document", value: document.id }
      : { namespace: "reader-source-key", value: `reader:${document.id}` },
  ])
  return { raw, output, guard, guardConflicts }
}

function sourceStateBase(
  credentialFingerprint: string,
  pass: ReconciliationPass,
  restartCount: number,
  baselineReadwise: InventorySnapshot | undefined,
  baselineReader: InventorySnapshot | undefined
) {
  return {
    stateVersion: SYNC_STATE_VERSION,
    credentialFingerprint,
    pass,
    restartCount,
    ...(baselineReadwise ? { baselineReadwise } : {}),
    ...(baselineReader ? { baselineReader } : {}),
  } as const
}

function sourceContinuationState(options: {
  state: SourcesReconciliationSyncState | undefined
  credentialFingerprint: string
  pass: ReconciliationPass
  restartCount: number
  phase: SourcesReconciliationPhase
  baselineReadwise?: InventorySnapshot
  baselineReader?: InventorySnapshot
  collectedReader?: InventorySnapshot
  completedReadwise?: InventorySnapshot
  active: ActiveInventory
  guard: IdentityGuardState
  nextPageCursor: string
}) {
  return boundedSyncState(
    {
      ...sourceStateBase(
        options.credentialFingerprint,
        options.pass,
        options.restartCount,
        options.baselineReadwise,
        options.baselineReader
      ),
      phase: options.phase,
      ...(options.collectedReader
        ? { collectedReader: options.collectedReader }
        : {}),
      ...(options.completedReadwise
        ? { completedReadwise: options.completedReadwise }
        : {}),
      active: options.active,
      ...options.guard,
      ...nextCursorState(
        options.state,
        options.nextPageCursor,
        `${options.phase} source reconciliation`,
        MAX_REPLACEMENT_CURSOR_PAGES
      ),
    } satisfies SourcesReconciliationSyncState,
    "source reconciliation"
  )
}

function restartSourcesReconciliation(
  state: SourcesReconciliationSyncState | undefined,
  credentialFingerprint: string
) {
  const nextState = boundedSyncState(
    {
      stateVersion: SYNC_STATE_VERSION,
      credentialFingerprint,
      pass: "observe",
      phase: "collect-reader",
      restartCount: nextReconciliationRestartCount(
        state?.restartCount,
        "source"
      ),
    } satisfies SourcesReconciliationSyncState,
    "source reconciliation"
  )
  return { changes: [] as SourceChange[], hasMore: true, nextState }
}

export async function runSourcesReconciliationPage(
  client: ReadwiseClient,
  state: SourcesReconciliationSyncState | undefined
) {
  validateSourcesReconciliationState(state)
  const credentialFingerprint = boundCredentialFingerprint(
    state,
    client.credentialFingerprint(),
    "source reconciliation"
  )
  const pass = reconciliationPass(state?.pass)
  const restartCount = reconciliationRestartCount(state?.restartCount)
  const currentPhase = sourcesReconciliationPhase(state?.phase)
  const pageCursor = state?.pageCursor
  const baselineReadwise = inventorySnapshot(
    state?.baselineReadwise,
    "Readwise baseline inventory",
    "export"
  )
  const baselineReader = inventorySnapshot(
    state?.baselineReader,
    "Reader baseline inventory"
  )
  const collectedReader = inventorySnapshot(
    state?.collectedReader,
    "collected Reader inventory"
  )
  const completedReadwise = inventorySnapshot(
    state?.completedReadwise,
    "completed Readwise inventory",
    "export"
  )

  try {
    if (currentPhase === "collect-reader") {
      const page = await client.listReaderDocuments({
        ...(pageCursor ? { pageCursor } : {}),
      })
      const identities = readerInventories(page.documents)
      const advanced = advanceGuardedInventory(
        state?.active,
        state,
        page.count,
        identities.raw,
        identities.output,
        "Reader collection",
        {
          guardIdentities: identities.guard,
          guardConflictIdentities: identities.guardConflicts,
        }
      )
      if (page.nextPageCursor) {
        assertInventoryCanContinue(advanced.active, "Reader collection")
        return {
          changes: [] as SourceChange[],
          hasMore: true,
          nextState: sourceContinuationState({
            state,
            credentialFingerprint,
            pass,
            restartCount,
            phase: currentPhase,
            ...(baselineReadwise ? { baselineReadwise } : {}),
            ...(baselineReader ? { baselineReader } : {}),
            active: advanced.active,
            guard: advanced.guard,
            nextPageCursor: page.nextPageCursor,
          }),
        }
      }

      const completedReader = completeInventory(
        advanced.active,
        "Reader collection"
      )
      const nextState = boundedSyncState(
        {
          ...sourceStateBase(
            credentialFingerprint,
            pass,
            restartCount,
            baselineReadwise,
            baselineReader
          ),
          phase: "readwise",
          collectedReader: completedReader,
          ...advanced.guard,
        } satisfies SourcesReconciliationSyncState,
        "source reconciliation"
      )
      return { changes: [] as SourceChange[], hasMore: true, nextState }
    }

    if (currentPhase === "readwise") {
      if (!collectedReader) {
        throw new Error("Readwise source reconciliation lost Reader inventory.")
      }
      const page = await client.exportHighlights({
        ...(pageCursor ? { pageCursor } : {}),
        includeDeleted: false,
      })
      if (
        page.sources.some(
          (source) =>
            source.is_deleted ||
            source.highlights.some((highlight) => highlight.is_deleted)
        )
      ) {
        throw new Error(
          "Readwise source reconciliation unexpectedly returned deleted records."
        )
      }
      const changes = page.sources.map((source) => {
        const readerId = readerExternalId(source)
        const readerPresent = Boolean(
          readerId &&
            hasIdentity(state, {
              namespace: "reader-source-key",
              value: exportSourceKey(source),
            })
        )
        return exportSourceToReconciliationChange(source, readerPresent)
      })
      const raw = page.sources.map((source) => ({
        namespace: "readwise-source",
        value: source.user_book_id,
      }))
      const output = changes.map((change) => ({
        namespace: "readwise-source-key",
        value: change.key,
      }))
      const providerItems = page.sources.flatMap((source) =>
        source.highlights.map((highlight) => ({
          namespace: "readwise-export-highlight",
          value: highlight.id,
        }))
      )
      const advanced = advanceGuardedInventory(
        state?.active,
        state,
        page.count,
        raw,
        output,
        "Readwise source Export",
        {
          countMode: "export",
          guardIdentities: [...raw, ...output, ...providerItems],
          providerItemIdentities: providerItems,
          uncoveredRawCount: page.sources.filter(
            (source) => source.highlights.length === 0
          ).length,
        }
      )
      const emittedChanges = pass === "emit" ? changes : []
      if (page.nextPageCursor) {
        assertInventoryCanContinue(
          advanced.active,
          "Readwise source Export",
          "export"
        )
        return {
          changes: emittedChanges,
          hasMore: true,
          nextState: sourceContinuationState({
            state,
            credentialFingerprint,
            pass,
            restartCount,
            phase: currentPhase,
            ...(baselineReadwise ? { baselineReadwise } : {}),
            ...(baselineReader ? { baselineReader } : {}),
            collectedReader,
            active: advanced.active,
            guard: advanced.guard,
            nextPageCursor: page.nextPageCursor,
          }),
        }
      }

      const completedExport = completeInventory(
        advanced.active,
        "Readwise source Export",
        "export"
      )
      const nextState = boundedSyncState(
        {
          ...sourceStateBase(
            credentialFingerprint,
            pass,
            restartCount,
            baselineReadwise,
            baselineReader
          ),
          phase: "reader",
          collectedReader,
          completedReadwise: completedExport,
          ...advanced.guard,
        } satisfies SourcesReconciliationSyncState,
        "source reconciliation"
      )
      return { changes: emittedChanges, hasMore: true, nextState }
    }

    if (!collectedReader || !completedReadwise) {
      throw new Error("Readwise source reconciliation lost phase inventory.")
    }
    const page = await client.listReaderDocuments({
      ...(pageCursor ? { pageCursor } : {}),
    })
    const identities = readerInventories(page.documents)
    const active = advanceMatchingInventory(
      state?.active,
      page.count,
      identities.raw,
      identities.output,
      "Reader finalization"
    )
    const changes = page.documents
      .map((document) => {
        if (document.parent_id !== null) return undefined
        const key = `reader:${document.id}`
        return readerDocumentToChange(document, {
          exportPresent: hasIdentity(state, {
            namespace: "readwise-source-key",
            value: key,
          }),
        })
      })
      .filter((change): change is NonNullable<typeof change> => Boolean(change))
    const emittedChanges = pass === "emit" ? changes : []

    if (page.nextPageCursor) {
      assertInventoryCanContinue(active, "Reader finalization")
      return {
        changes: emittedChanges,
        hasMore: true,
        nextState: sourceContinuationState({
          state,
          credentialFingerprint,
          pass,
          restartCount,
          phase: currentPhase,
          ...(baselineReadwise ? { baselineReadwise } : {}),
          ...(baselineReader ? { baselineReader } : {}),
          collectedReader,
          completedReadwise,
          active,
          guard: {
            ...(state?.identityBloom
              ? { identityBloom: state.identityBloom }
              : {}),
            ...(state?.identityCount !== undefined
              ? { identityCount: state.identityCount }
              : {}),
          },
          nextPageCursor: page.nextPageCursor,
        }),
      }
    }

    const finalizedReader = completeInventory(active, "Reader finalization")
    if (!inventoriesMatch(collectedReader, finalizedReader)) {
      throw new ReplacementInstabilityError(
        "Reader membership changed while source reconciliation was running."
      )
    }

    if (pass === "observe") {
      const nextState = boundedSyncState(
        {
          stateVersion: SYNC_STATE_VERSION,
          credentialFingerprint,
          pass: "confirm",
          phase: "collect-reader",
          restartCount,
          baselineReadwise: completedReadwise,
          baselineReader: finalizedReader,
        } satisfies SourcesReconciliationSyncState,
        "source reconciliation"
      )
      return { changes: [] as SourceChange[], hasMore: true, nextState }
    }

    if (!baselineReadwise || !baselineReader) {
      throw new Error("Readwise source replacement lost its baseline.")
    }
    const matchesBaseline =
      inventoriesMatch(baselineReadwise, completedReadwise) &&
      inventoriesMatch(baselineReader, finalizedReader)
    if (pass === "confirm" && matchesBaseline) {
      const nextState = boundedSyncState(
        {
          stateVersion: SYNC_STATE_VERSION,
          credentialFingerprint,
          pass: "emit",
          phase: "collect-reader",
          restartCount,
          baselineReadwise: completedReadwise,
          baselineReader: finalizedReader,
        } satisfies SourcesReconciliationSyncState,
        "source reconciliation"
      )
      return { changes: [] as SourceChange[], hasMore: true, nextState }
    }
    if (pass === "emit") {
      if (matchesBaseline) {
        return { changes: emittedChanges, hasMore: false }
      }
      throw new ReplacementInstabilityError(
        "Source membership changed during its verified emission traversal."
      )
    }

    const nextState = boundedSyncState(
      {
        stateVersion: SYNC_STATE_VERSION,
        credentialFingerprint,
        pass: "confirm",
        phase: "collect-reader",
        restartCount: nextReconciliationRestartCount(restartCount, "source"),
        baselineReadwise: completedReadwise,
        baselineReader: finalizedReader,
      } satisfies SourcesReconciliationSyncState,
      "source reconciliation"
    )
    return { changes: emittedChanges, hasMore: true, nextState }
  } catch (error) {
    if (error instanceof ReplacementInstabilityError) {
      return restartSourcesReconciliation(state, credentialFingerprint)
    }
    throw error
  }
}

function highlightChanges(
  sources: ReadwiseSource[],
  enforcePageUniqueness = true
) {
  const changes = sources.flatMap((source) =>
    source.highlights.map((highlight) => highlightToChange(source, highlight))
  )
  return enforcePageUniqueness
    ? uniqueChanges(changes, "highlight export page")
    : changes
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
    includeDeleted: true,
  })
  const changes = highlightChanges(page.sources)

  if (page.nextPageCursor) {
    let cursorState
    try {
      cursorState = nextCursorState(state, page.nextPageCursor, "highlights")
    } catch (error) {
      if (!(error instanceof ReplacementInstabilityError)) throw error
      const paginationRestartCount = nextIncrementalRestartCount(
        state?.paginationRestartCount,
        "highlights"
      )
      return {
        changes: [],
        hasMore: true,
        nextState: boundedSyncState(
          {
            stateVersion: SYNC_STATE_VERSION,
            credentialFingerprint: window.credentialFingerprint,
            updatedAfter: window.updatedAfter,
            checkpoint: window.checkpoint,
            paginationRestartCount,
          } satisfies IncrementalSyncState,
          "incremental highlights"
        ),
      }
    }
    const paginationRestartCount = incrementalRestartCount(
      state?.paginationRestartCount
    )
    const nextState = boundedSyncState(
      {
        stateVersion: SYNC_STATE_VERSION,
        credentialFingerprint: window.credentialFingerprint,
        updatedAfter: window.updatedAfter,
        checkpoint: window.checkpoint,
        ...(paginationRestartCount > 0 ? { paginationRestartCount } : {}),
        ...cursorState,
      } satisfies IncrementalSyncState,
      "incremental highlights"
    )
    return { changes, hasMore: true, nextState }
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

function restartHighlightsReconciliation(
  state: ReconciliationSyncState | undefined,
  credentialFingerprint: string
) {
  const nextState = boundedSyncState(
    {
      stateVersion: SYNC_STATE_VERSION,
      credentialFingerprint,
      pass: "observe",
      restartCount: nextReconciliationRestartCount(
        state?.restartCount,
        "highlight"
      ),
    } satisfies ReconciliationSyncState,
    "highlight reconciliation"
  )
  return { changes: [], hasMore: true, nextState }
}

export async function runHighlightsReconciliationPage(
  client: ReadwiseClient,
  state: ReconciliationSyncState | undefined
) {
  const pageCursor = reconciliationCursor(state)
  const credentialFingerprint = boundCredentialFingerprint(
    state,
    client.credentialFingerprint(),
    "highlight reconciliation"
  )
  const pass = reconciliationPass(state?.pass)
  const restartCount = reconciliationRestartCount(state?.restartCount)
  const baseline = inventorySnapshot(
    state?.baseline,
    "baseline inventory",
    "export"
  )

  try {
    const page = await client.exportHighlights({
      ...(pageCursor ? { pageCursor } : {}),
      includeDeleted: false,
    })
    if (
      page.sources.some(
        (source) =>
          source.is_deleted ||
          source.highlights.some((highlight) => highlight.is_deleted)
      )
    ) {
      throw new Error(
        "Readwise reconciliation unexpectedly returned deleted highlights."
      )
    }
    // The replacement identity guard covers duplicate IDs across the entire
    // traversal, including duplicates within this provider page.
    const changes = highlightChanges(page.sources, false)
    const raw = page.sources.map((source) => ({
      namespace: "highlight-export-source",
      value: source.user_book_id,
    }))
    const output = page.sources.flatMap((source) =>
      source.highlights.map((highlight) => ({
        namespace: "highlight-membership",
        value: `${highlight.id}\0${exportSourceKey(source)}`,
      }))
    )
    const duplicateIds = page.sources.flatMap((source) =>
      source.highlights.map((highlight) => ({
        namespace: "highlight-id",
        value: highlight.id,
      }))
    )
    const advanced = advanceGuardedInventory(
      state?.active,
      state,
      page.count,
      raw,
      output,
      "highlight Export",
      {
        countMode: "export",
        guardIdentities: [...raw, ...duplicateIds],
        providerItemIdentities: duplicateIds,
      }
    )
    const emittedChanges = pass === "emit" ? changes : []

    if (page.nextPageCursor) {
      assertInventoryCanContinue(advanced.active, "highlight Export", "export")
      const nextState = boundedSyncState(
        {
          stateVersion: SYNC_STATE_VERSION,
          credentialFingerprint,
          pass,
          restartCount,
          ...(baseline ? { baseline } : {}),
          active: advanced.active,
          ...advanced.guard,
          ...nextCursorState(
            state,
            page.nextPageCursor,
            "highlight reconciliation",
            MAX_REPLACEMENT_CURSOR_PAGES
          ),
        } satisfies ReconciliationSyncState,
        "highlight reconciliation"
      )
      return { changes: emittedChanges, hasMore: true, nextState }
    }

    const completed = completeInventory(
      advanced.active,
      "highlight Export",
      "export"
    )
    if (pass === "observe") {
      const nextState = boundedSyncState(
        {
          stateVersion: SYNC_STATE_VERSION,
          credentialFingerprint,
          pass: "confirm",
          restartCount,
          baseline: completed,
        } satisfies ReconciliationSyncState,
        "highlight reconciliation"
      )
      return { changes: [], hasMore: true, nextState }
    }
    if (!baseline) {
      throw new Error("Readwise highlight replacement lost its baseline.")
    }
    const matchesBaseline = inventoriesMatch(baseline, completed)
    if (pass === "confirm" && matchesBaseline) {
      const nextState = boundedSyncState(
        {
          stateVersion: SYNC_STATE_VERSION,
          credentialFingerprint,
          pass: "emit",
          restartCount,
          baseline: completed,
        } satisfies ReconciliationSyncState,
        "highlight reconciliation"
      )
      return { changes: [], hasMore: true, nextState }
    }
    if (pass === "emit") {
      if (matchesBaseline) {
        return { changes: emittedChanges, hasMore: false }
      }
      throw new ReplacementInstabilityError(
        "Highlight membership changed during its verified emission traversal."
      )
    }

    const nextState = boundedSyncState(
      {
        stateVersion: SYNC_STATE_VERSION,
        credentialFingerprint,
        pass: "confirm",
        restartCount: nextReconciliationRestartCount(restartCount, "highlight"),
        baseline: completed,
      } satisfies ReconciliationSyncState,
      "highlight reconciliation"
    )
    return { changes: emittedChanges, hasMore: true, nextState }
  } catch (error) {
    if (error instanceof ReplacementInstabilityError) {
      return restartHighlightsReconciliation(state, credentialFingerprint)
    }
    throw error
  }
}
