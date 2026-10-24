import type { GitHubStarsClient } from "./github.js"
import {
  GITHUB_PAGE_SIZE,
  MAX_STAR_PAGES,
  type GitHubStarredRepository,
} from "./github.js"
import { repositoryToChange } from "./repositories.js"

export const STARS_SYNC_STATE_VERSION = 3
export const MAX_STARRED_REPOSITORIES = GITHUB_PAGE_SIZE * MAX_STAR_PAGES
export const MAX_TRACKED_REPOSITORIES = MAX_STARRED_REPOSITORIES * 2
export const MAX_SAFE_STARS_SYNC_STATE_BYTES = 240 * 1_024

const REPOSITORY_ID_BYTES = 8
const ACTIVE = 0
const MISSING_ONCE = 1
const SEEN_ACTIVE = 2
const SEEN_MISSING = 3
const SEEN_NEW = 4

type ReadyStatus = typeof ACTIVE | typeof MISSING_ONCE
type ScanStatus =
  | ReadyStatus
  | typeof SEEN_ACTIVE
  | typeof SEEN_MISSING
  | typeof SEEN_NEW
type RepositoryStatus = ScanStatus

type StarsSyncStateBase = {
  stateVersion: typeof STARS_SYNC_STATE_VERSION
  accountId: string
  repositoryIds: string
  repositoryStatuses: string
}

export type StarsReadyState = StarsSyncStateBase & {
  phase: "ready"
}

export type StarsScanState = StarsSyncStateBase & {
  phase: "scan"
  page: number
}

export type StarsSyncState = StarsReadyState | StarsScanState

function validateAccountId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d{0,15}$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  ) {
    throw new Error("GitHub stars sync state has an invalid account ID.")
  }
  return value
}

export function starsSyncStateSize(state: unknown): number {
  return new TextEncoder().encode(JSON.stringify(state)).byteLength
}

function boundedStarsSyncState<T extends StarsSyncState>(state: T): T {
  const bytes = starsSyncStateSize(state)
  if (bytes > MAX_SAFE_STARS_SYNC_STATE_BYTES) {
    throw new Error(
      `GitHub stars continuation state exceeded the 240 KiB safety budget (${Math.ceil(
        bytes / 1_024
      )} KiB).`
    )
  }
  return state
}

function uniqueSortedRepositoryIds(
  values: ReadonlyArray<number>,
  maximum: number,
  label: string
): number[] {
  if (values.length > maximum) {
    throw new Error(`GitHub stars sync state has too many ${label}.`)
  }
  const ids = new Set<number>()
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 1 || ids.has(value)) {
      throw new Error(`GitHub stars sync state has invalid ${label}.`)
    }
    ids.add(value)
  }
  return [...ids].sort((left, right) => left - right)
}

function encodeRepositoryIds(values: ReadonlyArray<number>): string {
  const bytes = Buffer.alloc(values.length * REPOSITORY_ID_BYTES)
  values.forEach((value, index) => {
    bytes.writeBigUInt64BE(BigInt(value), index * REPOSITORY_ID_BYTES)
  })
  return bytes.toString("base64url")
}

function decodeRepositoryIds(value: unknown, maximum: number): number[] {
  if (typeof value !== "string") {
    throw new Error("GitHub stars sync state has invalid repository IDs.")
  }
  const bytes = Buffer.from(value, "base64url")
  if (
    bytes.toString("base64url") !== value ||
    bytes.length % REPOSITORY_ID_BYTES !== 0 ||
    bytes.length / REPOSITORY_ID_BYTES > maximum
  ) {
    throw new Error("GitHub stars sync state has invalid repository IDs.")
  }

  const ids: number[] = []
  let previous = 0
  for (let offset = 0; offset < bytes.length; offset += REPOSITORY_ID_BYTES) {
    const decoded = bytes.readBigUInt64BE(offset)
    if (decoded > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("GitHub stars sync state has invalid repository IDs.")
    }
    const id = Number(decoded)
    if (id < 1 || id <= previous) {
      throw new Error("GitHub stars sync state has invalid repository IDs.")
    }
    ids.push(id)
    previous = id
  }
  return ids
}

function encodeRepositoryStatuses(
  values: ReadonlyArray<RepositoryStatus>
): string {
  const bytes = Buffer.alloc(Math.ceil(values.length / 2))
  values.forEach((value, index) => {
    const offset = Math.floor(index / 2)
    if (index % 2 === 0) bytes[offset] = value
    else bytes[offset] |= value << 4
  })
  return bytes.toString("base64url")
}

function decodeRepositoryStatuses(
  value: unknown,
  count: number,
  phase: StarsSyncState["phase"]
): RepositoryStatus[] {
  if (typeof value !== "string") {
    throw new Error("GitHub stars sync state has invalid repository statuses.")
  }
  const bytes = Buffer.from(value, "base64url")
  if (
    bytes.toString("base64url") !== value ||
    bytes.length !== Math.ceil(count / 2) ||
    (count % 2 === 1 && bytes.at(-1)! >> 4 !== 0)
  ) {
    throw new Error("GitHub stars sync state has invalid repository statuses.")
  }

  const statuses: RepositoryStatus[] = []
  for (let index = 0; index < count; index += 1) {
    const byte = bytes[Math.floor(index / 2)]
    const status = (index % 2 === 0 ? byte & 0x0f : byte >> 4) as ScanStatus
    if (
      status < ACTIVE ||
      status > SEEN_NEW ||
      (phase === "ready" && status !== ACTIVE && status !== MISSING_ONCE)
    ) {
      throw new Error(
        "GitHub stars sync state has invalid repository statuses."
      )
    }
    statuses.push(status)
  }
  return statuses
}

type RepositoryEntries = Map<number, RepositoryStatus>

function decodeEntries(state: StarsSyncState): RepositoryEntries {
  const ids = decodeRepositoryIds(state.repositoryIds, MAX_TRACKED_REPOSITORIES)
  const statuses = decodeRepositoryStatuses(
    state.repositoryStatuses,
    ids.length,
    state.phase
  )
  return new Map(ids.map((id, index) => [id, statuses[index]]))
}

function encodeEntries(entries: RepositoryEntries) {
  const sorted = [...entries].sort(([left], [right]) => left - right)
  return {
    repositoryIds: encodeRepositoryIds(sorted.map(([id]) => id)),
    repositoryStatuses: encodeRepositoryStatuses(
      sorted.map(([, status]) => status)
    ),
  }
}

function statusCount(
  entries: RepositoryEntries,
  statuses: ReadonlySet<RepositoryStatus>
): number {
  let count = 0
  for (const status of entries.values()) {
    if (statuses.has(status)) count += 1
  }
  return count
}

export function validateStarsSyncState(
  state: StarsSyncState | undefined
): StarsSyncState | undefined {
  if (!state) return undefined
  if (starsSyncStateSize(state) > MAX_SAFE_STARS_SYNC_STATE_BYTES) {
    throw new Error("GitHub stars sync state exceeds its safe size budget.")
  }
  if (state.stateVersion !== STARS_SYNC_STATE_VERSION) {
    throw new Error(
      "GitHub stars sync state is incompatible; deploy a matching Worker or reset state and review stale rows manually."
    )
  }
  if (state.phase !== "ready" && state.phase !== "scan") {
    throw new Error("GitHub stars sync state has an invalid phase.")
  }

  const accountId = validateAccountId(state.accountId)
  const entries = decodeEntries(state)
  if (entries.size > MAX_TRACKED_REPOSITORIES) {
    throw new Error("GitHub stars sync state tracks too many repositories.")
  }

  if (state.phase === "scan") {
    if (
      !Number.isSafeInteger(state.page) ||
      state.page < 2 ||
      state.page > MAX_STAR_PAGES
    ) {
      throw new Error("GitHub stars sync state has an invalid page.")
    }
    const seen = statusCount(
      entries,
      new Set([SEEN_ACTIVE, SEEN_MISSING, SEEN_NEW])
    )
    if (
      seen > MAX_STARRED_REPOSITORIES ||
      seen > (state.page - 1) * GITHUB_PAGE_SIZE
    ) {
      throw new Error(
        "GitHub stars sync state has too many seen repositories for its page."
      )
    }
  }

  return { ...state, accountId }
}

export function pageFromState(state: StarsSyncState | undefined): number {
  const validated = validateStarsSyncState(state)
  return validated?.phase === "scan" ? validated.page : 1
}

export function createReadyState(
  accountId: string,
  activeRepositoryIds: ReadonlyArray<number>,
  missingOnceRepositoryIds: ReadonlyArray<number>
): StarsReadyState {
  const active = uniqueSortedRepositoryIds(
    activeRepositoryIds,
    MAX_TRACKED_REPOSITORIES,
    "active repository IDs"
  )
  const missing = uniqueSortedRepositoryIds(
    missingOnceRepositoryIds,
    MAX_TRACKED_REPOSITORIES,
    "missing repository IDs"
  )
  if (active.length + missing.length > MAX_TRACKED_REPOSITORIES) {
    throw new Error("GitHub stars sync state tracks too many repositories.")
  }
  const entries: RepositoryEntries = new Map(
    active.map((id) => [id, ACTIVE] as const)
  )
  for (const id of missing) {
    if (entries.has(id)) {
      throw new Error(
        "GitHub stars sync state cannot mark one repository active and missing."
      )
    }
    entries.set(id, MISSING_ONCE)
  }
  const state = boundedStarsSyncState({
    stateVersion: STARS_SYNC_STATE_VERSION,
    phase: "ready",
    accountId: validateAccountId(accountId),
    ...encodeEntries(entries),
  })
  validateStarsSyncState(state)
  return state
}

function scanEntries(state: StarsSyncState | undefined): RepositoryEntries {
  if (!state) return new Map()
  const entries = decodeEntries(state)
  if (state.phase === "scan") return entries
  return new Map(
    [...entries].map(([id, status]) => [id, status as ReadyStatus])
  )
}

function scanChanges(repositories: ReadonlyArray<GitHubStarredRepository>) {
  return repositories.map(repositoryToChange)
}

function markPageSeen(
  entries: RepositoryEntries,
  repositories: ReadonlyArray<GitHubStarredRepository>
): number | undefined {
  if (repositories.length > GITHUB_PAGE_SIZE) {
    throw new Error(
      `GitHub returned more than ${GITHUB_PAGE_SIZE} stars on one page.`
    )
  }
  let duplicateId: number | undefined
  for (const star of repositories) {
    const id = star.repo.id
    const current = entries.get(id)
    if (
      current === SEEN_ACTIVE ||
      current === SEEN_MISSING ||
      current === SEEN_NEW
    ) {
      duplicateId ??= id
      continue
    }
    if (current === ACTIVE) entries.set(id, SEEN_ACTIVE)
    else if (current === MISSING_ONCE) entries.set(id, SEEN_MISSING)
    else entries.set(id, SEEN_NEW)
  }
  if (
    statusCount(entries, new Set([SEEN_ACTIVE, SEEN_MISSING, SEEN_NEW])) >
    MAX_STARRED_REPOSITORIES
  ) {
    throw new Error(
      `GitHub stars sync exceeded ${MAX_STARRED_REPOSITORIES} repositories.`
    )
  }
  return duplicateId
}

function readyAfterAbortedScan(
  accountId: string,
  entries: RepositoryEntries
): StarsReadyState {
  const active: number[] = []
  const missing: number[] = []
  const newlySeen: number[] = []
  const seen: number[] = []
  for (const [id, status] of entries) {
    if (status === MISSING_ONCE) missing.push(id)
    else if (status === SEEN_MISSING) {
      active.push(id)
      seen.push(id)
    } else if (status === SEEN_NEW) {
      newlySeen.push(id)
      seen.push(id)
    } else if (status === SEEN_ACTIVE) {
      active.push(id)
      seen.push(id)
    } else active.push(id)
  }

  if (
    active.length + missing.length + newlySeen.length <=
    MAX_TRACKED_REPOSITORIES
  ) {
    active.push(...newlySeen)
  } else if (active.length + missing.length > MAX_TRACKED_REPOSITORIES) {
    return createReadyState(accountId, seen, [])
  }
  return createReadyState(accountId, active, missing)
}

function completedScan(
  accountId: string,
  entries: RepositoryEntries,
  changes: ReturnType<typeof repositoryToChange>[]
) {
  const active: number[] = []
  const missing: number[] = []
  const deletes: Array<{ type: "delete"; key: string }> = []

  for (const [id, status] of entries) {
    if (status === ACTIVE) missing.push(id)
    else if (status === MISSING_ONCE) {
      deletes.push({ type: "delete", key: String(id) })
    } else {
      active.push(id)
    }
  }

  return {
    changes: [...changes, ...deletes],
    hasMore: false as const,
    nextState: createReadyState(accountId, active, missing),
  }
}

export async function runStarsSyncPage(
  client: GitHubStarsClient,
  untrustedState: StarsSyncState | undefined
) {
  const state = validateStarsSyncState(untrustedState)
  const page = state?.phase === "scan" ? state.page : 1
  const result = await client.fetchPage(page)
  const authenticatedUserId = validateAccountId(result.authenticatedUserId)
  if (
    result.nextPage !== undefined &&
    (!Number.isSafeInteger(result.nextPage) ||
      result.nextPage !== page + 1 ||
      result.nextPage > MAX_STAR_PAGES)
  ) {
    throw new Error("GitHub stars client returned an invalid next page.")
  }
  if (state && state.accountId !== authenticatedUserId) {
    throw new Error(
      "The authenticated GitHub account changed during the inventory scan."
    )
  }

  const accountId = state?.accountId ?? authenticatedUserId
  const entries = scanEntries(state)
  const duplicateId = markPageSeen(entries, result.repositories)
  if (
    duplicateId !== undefined ||
    entries.size > MAX_TRACKED_REPOSITORIES ||
    (result.nextPage && result.repositories.length === 0)
  ) {
    // Offset pagination can repeat a repository when stars change mid-scan.
    // End this non-destructive inventory without advancing absence evidence;
    // the next scheduled run starts from page one automatically.
    return {
      changes: [],
      hasMore: false as const,
      nextState: readyAfterAbortedScan(accountId, entries),
    }
  }

  const changes = scanChanges(result.repositories)
  if (result.nextPage !== undefined) {
    const nextState = boundedStarsSyncState({
      stateVersion: STARS_SYNC_STATE_VERSION,
      phase: "scan",
      accountId,
      page: result.nextPage,
      ...encodeEntries(entries),
    } satisfies StarsScanState)
    validateStarsSyncState(nextState)
    return { changes, hasMore: true as const, nextState }
  }

  return completedScan(accountId, entries, changes)
}
