import { PAGE_SIZE } from "./raindrop.js"

export const MAX_SYNC_RECORDS = 10_000
const MAX_DATA_PAGES = MAX_SYNC_RECORDS / PAGE_SIZE

export type AccountSyncState = {
  accountId: number
}

export type PageSyncState = AccountSyncState & {
  page: number
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

export function pageResult<T>(
  state: PageSyncState | undefined,
  accountId: number,
  items: unknown[],
  changes: T[],
  resourceName: string
): SyncPageResult<T, PageSyncState> {
  const page = currentPage(state, accountId, resourceName)
  validatePage(page, items.length, resourceName)

  const hasMore = items.length === PAGE_SIZE
  return {
    changes,
    hasMore,
    ...(hasMore
      ? {
          nextState: {
            accountId,
            page: page + 1,
          },
        }
      : { nextState: { accountId, page: 0 } }),
  }
}

export function bookmarkPageResult<T>(
  state: BookmarkSyncState | undefined,
  accountId: number,
  phase: BookmarkPhase,
  items: unknown[],
  changes: T[]
): SyncPageResult<T, BookmarkSyncState> {
  const position = currentBookmarkPosition(state, accountId)
  if (position.phase !== phase) {
    throw new Error("Raindrop.io bookmarks sync phase changed unexpectedly.")
  }
  validatePage(position.page, items.length, `${phase} bookmarks`)

  if (items.length === PAGE_SIZE) {
    return {
      changes,
      hasMore: true,
      nextState: {
        accountId,
        phase,
        page: position.page + 1,
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
