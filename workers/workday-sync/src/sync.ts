import type { DirectoryPerson } from "./people.js"
import { personToChange } from "./people.js"
import { teamToChange, teamsFromPeople } from "./teams.js"

// Notion recommends replace-mode syncs for datasets below roughly 10,000
// rows. Fail closed above 100 x 100-record pages instead of silently turning
// this reference recipe into an unbounded enterprise-wide full scan.
export const WORKDAY_PAGE_SIZE = 100
export const MAX_SNAPSHOT_PAGES = 100

export type DirectorySyncState = {
  page: number
  asOfEntryDateTime: string
  asOfEffectiveDate: string
  totalPages: number
  totalResults: number
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
  fetchWorkersPage(request: WorkdayPageRequest): Promise<WorkdayWorkersPage>
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return value as number
}

function isoDateTime(value: unknown, label: string): string {
  if (typeof value !== "string" || !isCanonicalIsoDateTime(value)) {
    throw new Error(`${label} must be an ISO 8601 timestamp.`)
  }
  return value
}

function isCanonicalIsoDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false
  }
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

function isoDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !isStrictIsoDate(value)) {
    throw new Error(`${label} must be an ISO 8601 date.`)
  }
  return value
}

function isStrictIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  )
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
  effectiveTimeZone: string,
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
      asOfEffectiveDate: effectiveDateInTimeZone(startedAt, effectiveTimeZone),
    }
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
  page: WorkdayWorkersPage
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
  return {
    hasMore,
    nextState: hasMore
      ? {
          page: page.page + 1,
          asOfEntryDateTime: request.asOfEntryDateTime,
          asOfEffectiveDate: request.asOfEffectiveDate,
          totalPages: page.totalPages,
          totalResults: page.totalResults,
        }
      : undefined,
  }
}

export async function runPeopleSyncPage(
  client: WorkdayDirectoryClient,
  state: DirectorySyncState | undefined,
  now?: () => Date
) {
  const request = snapshotRequest(state, client.effectiveTimeZone, now)
  const page = await client.fetchWorkersPage(request)
  const result = pageResult(state, request, page)

  return {
    changes: page.people.map(personToChange),
    hasMore: result.hasMore,
    ...(result.nextState ? { nextState: result.nextState } : {}),
  }
}

export async function runTeamsSyncPage(
  client: WorkdayDirectoryClient,
  state: DirectorySyncState | undefined,
  now?: () => Date
) {
  const request = snapshotRequest(state, client.effectiveTimeZone, now)
  const page = await client.fetchWorkersPage(request)
  const result = pageResult(state, request, page)

  return {
    changes: teamsFromPeople(page.people).map(teamToChange),
    hasMore: result.hasMore,
    ...(result.nextState ? { nextState: result.nextState } : {}),
  }
}
