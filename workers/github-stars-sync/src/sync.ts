import { createHash } from "node:crypto"

import type { GitHubStarsClient } from "./github.js"
import {
  GITHUB_PAGE_SIZE,
  MAX_STAR_PAGES,
  type GitHubStarredRepository,
} from "./github.js"
import { repositoryToChange } from "./repositories.js"

export const STARS_SYNC_STATE_VERSION = 2
export const MAX_STARRED_REPOSITORIES = GITHUB_PAGE_SIZE * MAX_STAR_PAGES

type StarsSyncStateBase = {
  stateVersion: typeof STARS_SYNC_STATE_VERSION
  accountId: string
  page: number
  seenRepositoryIds: number[]
}

export type StarsBaselineState = StarsSyncStateBase & {
  phase: "baseline"
}

export type StarsConfirmationState = StarsSyncStateBase & {
  phase: "confirmation"
  expectedCount: number
  expectedDigest: string
}

export type StarsSyncState = StarsBaselineState | StarsConfirmationState

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

function validateRepositoryIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > MAX_STARRED_REPOSITORIES) {
    throw new Error("GitHub stars sync state has invalid repository IDs.")
  }
  const ids = new Set<number>()
  for (const candidate of value) {
    if (
      !Number.isSafeInteger(candidate) ||
      candidate < 1 ||
      ids.has(candidate)
    ) {
      throw new Error("GitHub stars sync state has invalid repository IDs.")
    }
    ids.add(candidate)
  }
  return [...ids]
}

export function validateStarsSyncState(
  state: StarsSyncState | undefined
): StarsSyncState | undefined {
  if (!state) return undefined
  if (state.stateVersion !== STARS_SYNC_STATE_VERSION) {
    throw new Error(
      "GitHub stars sync state is incompatible; reset the sync state before retrying."
    )
  }
  if (
    !Number.isSafeInteger(state.page) ||
    state.page < 1 ||
    state.page > MAX_STAR_PAGES
  ) {
    throw new Error("GitHub stars sync state has an invalid page.")
  }
  if (state.phase !== "baseline" && state.phase !== "confirmation") {
    throw new Error("GitHub stars sync state has an invalid phase.")
  }

  const validated = {
    ...state,
    accountId: validateAccountId(state.accountId),
    seenRepositoryIds: validateRepositoryIds(state.seenRepositoryIds),
  }
  if (
    validated.seenRepositoryIds.length >
    (validated.page - 1) * GITHUB_PAGE_SIZE
  ) {
    throw new Error(
      "GitHub stars sync state has too many repository IDs for its page."
    )
  }
  if (validated.phase === "confirmation") {
    if (
      !Number.isSafeInteger(validated.expectedCount) ||
      validated.expectedCount < 0 ||
      validated.expectedCount > MAX_STARRED_REPOSITORIES ||
      !/^[a-f0-9]{64}$/.test(validated.expectedDigest)
    ) {
      throw new Error(
        "GitHub stars sync state has an invalid confirmation snapshot."
      )
    }
    if (validated.seenRepositoryIds.length > validated.expectedCount) {
      throw new Error(
        "GitHub stars sync confirmation already exceeds its baseline membership."
      )
    }
  }
  return validated
}

export function pageFromState(state: StarsSyncState | undefined): number {
  return validateStarsSyncState(state)?.page ?? 1
}

export function membershipDigest(repositoryIds: ReadonlyArray<number>): string {
  return createHash("sha256")
    .update([...repositoryIds].sort((a, b) => a - b).join(","))
    .digest("hex")
}

function appendRepositoryIds(
  previousIds: ReadonlyArray<number>,
  repositories: ReadonlyArray<GitHubStarredRepository>
): number[] {
  if (repositories.length > GITHUB_PAGE_SIZE) {
    throw new Error(
      `GitHub returned more than ${GITHUB_PAGE_SIZE} stars on one page.`
    )
  }
  const ids = new Set(previousIds)
  for (const star of repositories) {
    if (ids.has(star.repo.id)) {
      throw new Error(
        `GitHub pagination returned repository ID ${star.repo.id} more than once.`
      )
    }
    ids.add(star.repo.id)
  }
  if (ids.size > MAX_STARRED_REPOSITORIES) {
    throw new Error(
      `GitHub stars sync exceeded ${MAX_STARRED_REPOSITORIES} repositories.`
    )
  }
  return [...ids]
}

export async function runStarsSyncPage(
  client: GitHubStarsClient,
  untrustedState: StarsSyncState | undefined
) {
  const state = validateStarsSyncState(untrustedState)
  const page = state?.page ?? 1
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
      "The authenticated GitHub account changed during the replacement cycle."
    )
  }

  const accountId = state?.accountId ?? authenticatedUserId
  const seenRepositoryIds = appendRepositoryIds(
    state?.seenRepositoryIds ?? [],
    result.repositories
  )
  const isConfirmation = state?.phase === "confirmation"
  if (isConfirmation && seenRepositoryIds.length > state.expectedCount) {
    throw new Error(
      "GitHub stars changed during pagination; the replacement was not completed."
    )
  }

  // The baseline pass already emitted every upsert. The second traversal only
  // proves that its membership is stable enough for replace-mode deletion.
  const changes = isConfirmation
    ? []
    : result.repositories.map(repositoryToChange)

  if (result.nextPage !== undefined) {
    const common = {
      stateVersion: STARS_SYNC_STATE_VERSION,
      accountId,
      page: result.nextPage,
      seenRepositoryIds,
    } as const
    const nextState: StarsSyncState = isConfirmation
      ? {
          ...common,
          phase: "confirmation",
          expectedCount: state.expectedCount,
          expectedDigest: state.expectedDigest,
        }
      : { ...common, phase: "baseline" }
    return { changes, hasMore: true as const, nextState }
  }

  const observedDigest = membershipDigest(seenRepositoryIds)
  if (!isConfirmation) {
    return {
      changes,
      hasMore: true as const,
      nextState: {
        stateVersion: STARS_SYNC_STATE_VERSION,
        phase: "confirmation",
        accountId,
        page: 1,
        seenRepositoryIds: [],
        expectedCount: seenRepositoryIds.length,
        expectedDigest: observedDigest,
      } satisfies StarsConfirmationState,
    }
  }

  if (
    seenRepositoryIds.length !== state.expectedCount ||
    observedDigest !== state.expectedDigest
  ) {
    throw new Error(
      "GitHub stars changed during pagination; the replacement was not completed."
    )
  }

  return { changes, hasMore: false as const }
}
