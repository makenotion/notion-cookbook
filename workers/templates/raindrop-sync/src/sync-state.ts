import { createHash } from "node:crypto"

import {
  MAX_PAGINATED_RECORDS,
  PAGE_SIZE,
  PAGES_PER_SYNC_EXECUTION,
} from "./raindrop.js"

export const MAX_SYNC_RECORDS = MAX_PAGINATED_RECORDS
const MAX_DATA_PAGES = MAX_SYNC_RECORDS / PAGE_SIZE
const ID_FINGERPRINT_LENGTH = 32
const PAGE_DIGEST_LENGTH = 64

export type AccountSyncState = {
  accountId: number
}

export type PaginationGuardState = {
  firstPageDigest?: string
  previousPageFingerprints?: string[]
  restartUsed?: boolean
}

export type PageSyncState = AccountSyncState & {
  page: number
  guard?: PaginationGuardState
}

export type BookmarkPhase = "active" | "trash"

export type BookmarkSyncState = PageSyncState & {
  phase: BookmarkPhase
}

type SyncPageResult<T, State> = {
  changes: T[]
  hasMore: boolean
  nextState: State
}

type EvaluatedPageBatch = {
  complete: boolean
  nextPage: number
  guard: PaginationGuardState
  restart: boolean
}

function assertAccountId(accountId: number, resourceName: string): void {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new Error(
      `Raindrop.io ${resourceName} sync received an invalid account ID.`
    )
  }
}

function validateAccountState(
  state: AccountSyncState,
  accountId: number,
  resourceName: string
): void {
  if (!Number.isSafeInteger(state.accountId) || state.accountId <= 0) {
    throw new Error(
      `Raindrop.io ${resourceName} sync state has an invalid account ID.`
    )
  }
  if (state.accountId !== accountId) {
    throw new Error(
      `Raindrop.io account changed for ${resourceName}; restore the original token or deploy a separate Worker for the other account.`
    )
  }
}

function validateGuard(
  guard: PaginationGuardState | undefined,
  resourceName: string
): void {
  if (!guard) return
  if (typeof guard !== "object" || Array.isArray(guard)) {
    throw new Error(
      `Raindrop.io ${resourceName} sync state has an invalid pagination guard.`
    )
  }
  if (
    guard.firstPageDigest !== undefined &&
    !new RegExp(`^[a-f0-9]{${PAGE_DIGEST_LENGTH}}$`).test(guard.firstPageDigest)
  ) {
    throw new Error(
      `Raindrop.io ${resourceName} sync state has an invalid first-page digest.`
    )
  }
  if (guard.previousPageFingerprints !== undefined) {
    if (
      !Array.isArray(guard.previousPageFingerprints) ||
      guard.previousPageFingerprints.length > PAGE_SIZE ||
      guard.previousPageFingerprints.some(
        (fingerprint) =>
          typeof fingerprint !== "string" ||
          !new RegExp(`^[a-f0-9]{${ID_FINGERPRINT_LENGTH}}$`).test(fingerprint)
      )
    ) {
      throw new Error(
        `Raindrop.io ${resourceName} sync state has invalid page fingerprints.`
      )
    }
  }
  if (
    guard.restartUsed !== undefined &&
    typeof guard.restartUsed !== "boolean"
  ) {
    throw new Error(
      `Raindrop.io ${resourceName} sync state has an invalid restart flag.`
    )
  }
}

function validatePageState(
  state: PageSyncState,
  accountId: number,
  resourceName: string
): void {
  validateAccountState(state, accountId, resourceName)
  if (
    !Number.isSafeInteger(state.page) ||
    state.page < 0 ||
    state.page > MAX_DATA_PAGES
  ) {
    throw new Error(
      `Raindrop.io ${resourceName} sync state has an invalid page.`
    )
  }
  validateGuard(state.guard, resourceName)
}

export function accountState(
  state: AccountSyncState | undefined,
  accountId: number,
  resourceName: string
): AccountSyncState {
  assertAccountId(accountId, resourceName)
  if (state) validateAccountState(state, accountId, resourceName)
  return { accountId }
}

export function currentPage(
  state: PageSyncState | undefined,
  accountId: number,
  resourceName: string
): number {
  assertAccountId(accountId, resourceName)
  if (!state) return 0
  validatePageState(state, accountId, resourceName)
  return state.page
}

export function currentBookmarkPosition(
  state: BookmarkSyncState | undefined,
  accountId: number
): { phase: BookmarkPhase; page: number } {
  if (!state) {
    assertAccountId(accountId, "bookmarks")
    return { phase: "active", page: 0 }
  }
  validatePageState(state, accountId, "bookmarks")
  if (state.phase !== "active" && state.phase !== "trash") {
    throw new Error("Raindrop.io bookmarks sync state has an invalid phase.")
  }
  return { phase: state.phase, page: state.page }
}

function validatePage(
  page: number,
  itemCount: number,
  resourceName: string
): void {
  if (itemCount > PAGE_SIZE) {
    throw new Error(
      `Raindrop.io ${resourceName} response exceeds the documented page size.`
    )
  }
  if (page === MAX_DATA_PAGES && itemCount > 0) {
    throw new Error(
      `Raindrop.io ${resourceName} exceeds ${MAX_SYNC_RECORDS} records; narrow or partition this reference sync before retrying.`
    )
  }
}

function fingerprintId(id: string): string {
  return createHash("sha256")
    .update(id)
    .digest("hex")
    .slice(0, ID_FINGERPRINT_LENGTH)
}

function pageFingerprints(ids: string[], resourceName: string): string[] {
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Raindrop.io returned a duplicate ${resourceName} ID.`)
  }
  return ids.map(fingerprintId)
}

function membershipDigest(fingerprints: string[]): string {
  return createHash("sha256")
    .update([...fingerprints].sort().join(""))
    .digest("hex")
}

function hasOverlap(left: string[], right: string[]): boolean {
  const leftSet = new Set(left)
  return right.some((fingerprint) => leftSet.has(fingerprint))
}

function validatePageBatch(
  startPage: number,
  pageIds: string[][],
  changeCount: number,
  resourceName: string
): void {
  if (pageIds.length === 0 || pageIds.length > PAGES_PER_SYNC_EXECUTION) {
    throw new Error(
      `Raindrop.io ${resourceName} sync received an invalid page batch.`
    )
  }
  pageIds.forEach((ids, index) => {
    validatePage(startPage + index, ids.length, resourceName)
    if (index < pageIds.length - 1 && ids.length !== PAGE_SIZE) {
      throw new Error(
        `Raindrop.io ${resourceName} sync received data after a terminal page.`
      )
    }
  })
  const lastPage = pageIds.at(-1)!
  if (
    lastPage.length === PAGE_SIZE &&
    pageIds.length < PAGES_PER_SYNC_EXECUTION
  ) {
    throw new Error(
      `Raindrop.io ${resourceName} sync ended a full page batch early.`
    )
  }
  if (pageIds.reduce((total, ids) => total + ids.length, 0) !== changeCount) {
    throw new Error(
      `Raindrop.io ${resourceName} sync produced an unexpected number of changes.`
    )
  }
}

function evaluatePageBatch(
  state: PageSyncState | undefined,
  accountId: number,
  pageIds: string[][],
  changeCount: number,
  resourceName: string,
  terminalFirstPageIds?: string[]
): EvaluatedPageBatch {
  const page = currentPage(state, accountId, resourceName)
  validatePageBatch(page, pageIds, changeCount, resourceName)

  const pageFingerprintLists = pageIds.map((ids) =>
    pageFingerprints(ids, resourceName)
  )
  const firstPageDigest =
    state?.guard?.firstPageDigest ??
    (page === 0 ? membershipDigest(pageFingerprintLists[0]) : undefined)
  let driftDetected = false
  let previous = state?.guard?.previousPageFingerprints
  for (const fingerprints of pageFingerprintLists) {
    if (previous && hasOverlap(previous, fingerprints)) {
      driftDetected = true
    }
    previous = fingerprints
  }

  const complete = pageIds.at(-1)!.length < PAGE_SIZE
  if (complete && terminalFirstPageIds !== undefined && firstPageDigest) {
    const terminalDigest = membershipDigest(
      pageFingerprints(terminalFirstPageIds, resourceName)
    )
    driftDetected ||= terminalDigest !== firstPageDigest
  }

  const restartUsed = state?.guard?.restartUsed === true
  if (driftDetected && !restartUsed) {
    return {
      complete: false,
      nextPage: 0,
      guard: { restartUsed: true },
      restart: true,
    }
  }

  return {
    complete,
    nextPage: page + pageIds.length,
    guard: {
      ...(firstPageDigest ? { firstPageDigest } : {}),
      previousPageFingerprints: previous,
      ...(restartUsed ? { restartUsed: true } : {}),
    },
    restart: false,
  }
}

export function pageResult<T>(
  state: PageSyncState | undefined,
  accountId: number,
  pageIds: string[][],
  changes: T[],
  resourceName: string,
  terminalFirstPageIds?: string[]
): SyncPageResult<T, PageSyncState> {
  const result = evaluatePageBatch(
    state,
    accountId,
    pageIds,
    changes.length,
    resourceName,
    terminalFirstPageIds
  )
  if (result.restart) {
    return {
      changes: [],
      hasMore: true,
      nextState: { accountId, page: 0, guard: result.guard },
    }
  }
  if (result.complete) {
    return {
      changes,
      hasMore: false,
      nextState: { accountId, page: 0 },
    }
  }
  return {
    changes,
    hasMore: true,
    nextState: {
      accountId,
      page: result.nextPage,
      guard: result.guard,
    },
  }
}

export function bookmarkPageResult<T>(
  state: BookmarkSyncState | undefined,
  accountId: number,
  phase: BookmarkPhase,
  pageIds: string[][],
  changes: T[],
  terminalFirstPageIds?: string[]
): SyncPageResult<T, BookmarkSyncState> {
  const position = currentBookmarkPosition(state, accountId)
  if (position.phase !== phase) {
    throw new Error("Raindrop.io bookmarks sync phase changed unexpectedly.")
  }
  const result = evaluatePageBatch(
    state,
    accountId,
    pageIds,
    changes.length,
    `${phase} bookmarks`,
    terminalFirstPageIds
  )
  if (result.restart) {
    return {
      changes: [],
      hasMore: true,
      nextState: {
        accountId,
        phase,
        page: 0,
        guard: result.guard,
      },
    }
  }
  if (!result.complete) {
    return {
      changes,
      hasMore: true,
      nextState: {
        accountId,
        phase,
        page: result.nextPage,
        guard: result.guard,
      },
    }
  }
  if (phase === "active") {
    return {
      changes,
      hasMore: true,
      nextState: {
        accountId,
        phase: "trash",
        page: 0,
      },
    }
  }
  return {
    changes,
    hasMore: false,
    nextState: { accountId, phase: "active", page: 0 },
  }
}
