import type { DirectoryPerson } from "./people.js"
import { personToChange } from "./people.js"
import {
  organizationToChange,
  organizationsFromPeople,
} from "./organizations.js"
import { isoDate, isoDateTime, positiveInteger } from "./validation.js"

// Notion recommends replace-mode syncs for datasets below roughly 10,000
// rows. Fail closed above 100 x 100-record pages instead of silently turning
// this reference recipe into an unbounded enterprise-wide full scan.
export const WORKDAY_PAGE_SIZE = 100
export const MAX_SNAPSHOT_PAGES = 100
// Bump the state version for serialization changes. Bump the contract version
// whenever source selection, parsing, keys, output schemas, or paging semantics
// change in a way that makes an in-flight snapshot unsafe to resume.
export const DIRECTORY_SYNC_STATE_VERSION = 2
export const DIRECTORY_SYNC_CONTRACT_VERSION = 2
export const WORK_EMAIL_FINGERPRINT_LENGTH = 16
const WORK_EMAIL_FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{16}$/

export type DirectorySyncState = {
  stateVersion: typeof DIRECTORY_SYNC_STATE_VERSION
  sourceContractFingerprint: string
  page: number
  asOfEntryDateTime: string
  asOfEffectiveDate: string
  totalPages: number
  totalResults: number
  seenWorkEmailFingerprints?: string
}

export type WorkdayPageRequest = {
  page: number
  asOfEntryDateTime: string
  asOfEffectiveDate: string
}

export type WorkdayWorkersPage = {
  page: number
  totalPages: number
  totalResults: number
  people: DirectoryPerson[]
}

export type WorkdayDirectoryClient = {
  effectiveTimeZone: string
  sourceContractFingerprint: string
  workEmailFingerprint(email: string): string
  fetchWorkersPage(
    request: WorkdayPageRequest,
    options: { includeWorkEmail: boolean }
  ): Promise<WorkdayWorkersPage>
}

function previousWorkEmailFingerprints(
  state: DirectorySyncState | undefined
): string[] {
  if (!state) return []
  const packed = state.seenWorkEmailFingerprints
  if (
    typeof packed !== "string" ||
    packed.length % WORK_EMAIL_FINGERPRINT_LENGTH !== 0 ||
    packed.length >
      MAX_SNAPSHOT_PAGES * WORKDAY_PAGE_SIZE * WORK_EMAIL_FINGERPRINT_LENGTH
  ) {
    throw new Error(
      "Workday People sync state has invalid work-email fingerprints."
    )
  }
  const fingerprints = Array.from(
    { length: packed.length / WORK_EMAIL_FINGERPRINT_LENGTH },
    (_, index) =>
      packed.slice(
        index * WORK_EMAIL_FINGERPRINT_LENGTH,
        (index + 1) * WORK_EMAIL_FINGERPRINT_LENGTH
      )
  )
  if (
    fingerprints.some(
      (fingerprint) => !WORK_EMAIL_FINGERPRINT_PATTERN.test(fingerprint)
    ) ||
    new Set(fingerprints).size !== fingerprints.length
  ) {
    throw new Error(
      "Workday People sync state has invalid work-email fingerprints."
    )
  }
  return fingerprints
}

export function effectiveDateInTimeZone(date: Date, timeZone: string): string {
  if (Number.isNaN(date.getTime())) {
    throw new Error("Workday snapshot time is invalid.")
  }

  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date)
  } catch {
    throw new Error("WORKDAY_EFFECTIVE_TIME_ZONE must be a valid IANA zone.")
  }

  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value
  const year = part("year")
  const month = part("month")
  const day = part("day")
  if (!year || !month || !day) {
    throw new Error("Could not calculate the Workday effective date.")
  }
  return `${year}-${month}-${day}`
}

export function snapshotRequest(
  state: DirectorySyncState | undefined,
  client: Pick<
    WorkdayDirectoryClient,
    "effectiveTimeZone" | "sourceContractFingerprint"
  >,
  now: () => Date = () => new Date()
): WorkdayPageRequest {
  if (!state) {
    const startedAt = now()
    if (Number.isNaN(startedAt.getTime())) {
      throw new Error("Workday snapshot time is invalid.")
    }
    return {
      page: 1,
      asOfEntryDateTime: startedAt.toISOString(),
      asOfEffectiveDate: effectiveDateInTimeZone(
        startedAt,
        client.effectiveTimeZone
      ),
    }
  }

  if (
    state.stateVersion !== DIRECTORY_SYNC_STATE_VERSION ||
    state.sourceContractFingerprint !== client.sourceContractFingerprint
  ) {
    throw new Error(
      "Workday sync state is incompatible; reset the sync state before retrying."
    )
  }

  const page = positiveInteger(state.page, "Workday sync state.page")
  const totalPages = positiveInteger(
    state.totalPages,
    "Workday sync state.totalPages"
  )
  const totalResults = positiveInteger(
    state.totalResults,
    "Workday sync state.totalResults"
  )
  if (
    page < 2 ||
    page > totalPages ||
    totalPages > MAX_SNAPSHOT_PAGES ||
    Math.ceil(totalResults / WORKDAY_PAGE_SIZE) !== totalPages
  ) {
    throw new Error("Workday sync state has an invalid page boundary.")
  }

  return {
    page,
    asOfEntryDateTime: isoDateTime(
      state.asOfEntryDateTime,
      "Workday sync state.asOfEntryDateTime"
    ),
    asOfEffectiveDate: isoDate(
      state.asOfEffectiveDate,
      "Workday sync state.asOfEffectiveDate"
    ),
  }
}

function pageResult(
  state: DirectorySyncState | undefined,
  request: WorkdayPageRequest,
  page: WorkdayWorkersPage,
  sourceContractFingerprint: string
) {
  if (page.page !== request.page) {
    throw new Error("Workday returned a different page than requested.")
  }
  positiveInteger(page.totalPages, "Workday response totalPages")
  positiveInteger(page.totalResults, "Workday response totalResults")
  if (
    page.totalPages > MAX_SNAPSHOT_PAGES ||
    page.page > page.totalPages ||
    page.people.length === 0
  ) {
    throw new Error("Workday returned an incomplete directory snapshot.")
  }
  if (
    state &&
    (page.totalPages !== state.totalPages ||
      page.totalResults !== state.totalResults)
  ) {
    throw new Error("Workday snapshot totals changed while paging.")
  }

  const hasMore = page.page < page.totalPages
  const nextState: DirectorySyncState | undefined = hasMore
    ? {
        stateVersion: DIRECTORY_SYNC_STATE_VERSION,
        sourceContractFingerprint,
        page: page.page + 1,
        asOfEntryDateTime: request.asOfEntryDateTime,
        asOfEffectiveDate: request.asOfEffectiveDate,
        totalPages: page.totalPages,
        totalResults: page.totalResults,
      }
    : undefined

  return {
    hasMore,
    nextState,
  }
}

export async function runPeopleSyncPage(
  client: WorkdayDirectoryClient,
  state: DirectorySyncState | undefined,
  now?: () => Date
) {
  const request = snapshotRequest(state, client, now)
  const fingerprints = previousWorkEmailFingerprints(state)
  const page = await client.fetchWorkersPage(request, {
    includeWorkEmail: true,
  })
  const result = pageResult(
    state,
    request,
    page,
    client.sourceContractFingerprint
  )
  const seen = new Set(fingerprints)
  for (const person of page.people) {
    if (!person.workEmail) continue
    const fingerprint = client.workEmailFingerprint(person.workEmail)
    if (
      fingerprint.length !== WORK_EMAIL_FINGERPRINT_LENGTH ||
      !WORK_EMAIL_FINGERPRINT_PATTERN.test(fingerprint)
    ) {
      throw new Error("Workday client returned an invalid email fingerprint.")
    }
    if (seen.has(fingerprint)) {
      throw new Error(
        "Workday returned one public work email for multiple employees."
      )
    }
    seen.add(fingerprint)
  }

  const nextState = result.nextState
    ? {
        ...result.nextState,
        seenWorkEmailFingerprints: [...seen].join(""),
      }
    : undefined

  return {
    changes: page.people.map(personToChange),
    hasMore: result.hasMore,
    ...(nextState ? { nextState } : {}),
  }
}

export async function runOrganizationsSyncPage(
  client: WorkdayDirectoryClient,
  state: DirectorySyncState | undefined,
  now?: () => Date
) {
  const request = snapshotRequest(state, client, now)
  const page = await client.fetchWorkersPage(request, {
    includeWorkEmail: false,
  })
  const result = pageResult(
    state,
    request,
    page,
    client.sourceContractFingerprint
  )

  return {
    changes: organizationsFromPeople(page.people).map(organizationToChange),
    hasMore: result.hasMore,
    ...(result.nextState ? { nextState: result.nextState } : {}),
  }
}
