import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

import {
  IntercomApiError,
  type IntercomClient,
  type IntercomCompany,
  type IntercomCompanyPage,
} from "./intercom.js"
import {
  humanize,
  nonEmpty,
  optionalUnixSecondsToIso,
  uniqueStrings,
  unixSecondsToIso,
} from "./helpers.js"
import { advancePageGuard, type PaginationGuardState } from "./pagination.js"

export const INITIAL_TITLE = "Intercom Companies"
export const PRIMARY_KEY = "Company ID"

export const companySchema = {
  databaseIcon: notionIcon("briefcase"),
  properties: {
    Name: Schema.title(),

    Plan: Schema.select([]),

    Industry: Schema.select([]),

    Website: Schema.url(),

    Employees: Schema.number(),

    Users: Schema.number(),

    Sessions: Schema.number(),

    "Monthly Spend": Schema.number(),

    "Last Active": Schema.date(),

    Tags: Schema.multiSelect([]),

    Segments: Schema.multiSelect([]),

    Updated: Schema.date(),

    Created: Schema.date(),

    "Created at Source": Schema.date(),

    "External Company ID": Schema.richText(),

    "Company ID": Schema.richText(),
  },
} satisfies Schema.Schema<typeof PRIMARY_KEY>

export type CompanySyncState = PaginationGuardState & {
  scrollParameter: string
  restartCount?: number
  lastRequestAt?: number
}

const MAX_SCROLL_RESTARTS = 2
// Intercom expires a Company Scroll after one idle minute. A small grace
// avoids starting a replacement scroll while the previous one may still own
// the app-wide single-scroll slot.
export const COMPANY_SCROLL_RESTART_AFTER_MS = 65_000

function clockMillis(now: () => Date): number {
  const value = now().getTime()
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Intercom company sync clock is invalid.")
  }
  return value
}

function scrollExpired(
  state: CompanySyncState | undefined,
  nowMillis: number
): boolean {
  if (!state?.scrollParameter || state.lastRequestAt === undefined) return false
  if (
    !Number.isSafeInteger(state.lastRequestAt) ||
    state.lastRequestAt < 0 ||
    state.lastRequestAt > nowMillis
  ) {
    throw new Error("Intercom company scroll state has an invalid timestamp.")
  }
  return nowMillis - state.lastRequestAt >= COMPANY_SCROLL_RESTART_AFTER_MS
}

function restartableScrollError(error: unknown): boolean {
  if (!(error instanceof IntercomApiError)) return false
  if (error.status === 400 || error.status === 404) return true
  return (
    error.status === 500 &&
    /internal network error[\s\S]*restart the scroll operation/i.test(
      error.message
    )
  )
}

function companyId(company: IntercomCompany): string {
  const id = nonEmpty(company.id)
  if (!id) throw new Error("Intercom company is missing its id.")
  return id
}

function finiteNumber(value: number | null | undefined): number | undefined {
  return value != null && Number.isFinite(value) ? value : undefined
}

function normalizeWebsite(
  value: string | null | undefined
): string | undefined {
  const website = nonEmpty(value)
  if (!website) return undefined
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(website)
    ? website
    : `https://${website}`
  try {
    const url = new URL(candidate)
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined
  } catch {
    return undefined
  }
}

function namedValues(
  values: Array<{ id?: string | null; name?: string | null }>
): string[] {
  return uniqueStrings(
    values.map((value) => {
      const id = nonEmpty(value.id)
      return nonEmpty(value.name) ?? (id ? `Unknown (${id})` : undefined)
    })
  )
}

export function companyToChange(
  company: IntercomCompany
): SyncChangeUpsert<typeof PRIMARY_KEY, typeof companySchema.properties> {
  const id = companyId(company)
  const updated = unixSecondsToIso(company.updated_at, "Company updated_at")
  const created = unixSecondsToIso(company.created_at, "Company created_at")
  const sourceCreated = optionalUnixSecondsToIso(
    company.remote_created_at,
    "Company remote_created_at"
  )
  const lastActive = optionalUnixSecondsToIso(
    company.last_request_at,
    "Company last_request_at"
  )
  const plan = nonEmpty(company.plan?.name)
  const industry = nonEmpty(company.industry)
  const website = normalizeWebsite(company.website)
  const employees = finiteNumber(company.size)
  const users = finiteNumber(company.user_count)
  const sessions = finiteNumber(company.session_count)
  const monthlySpend = finiteNumber(company.monthly_spend)
  const tags = namedValues(company.tags?.tags ?? [])
  const segments = namedValues(company.segments?.segments ?? [])
  const externalId = nonEmpty(company.company_id)

  return {
    type: "upsert",
    key: id,
    upstreamUpdatedAt: updated,
    properties: {
      Name: Builder.title(
        nonEmpty(company.name) ?? externalId ?? `Company ${id}`
      ),
      Plan: plan ? Builder.select(plan) : [],
      Industry: industry ? Builder.select(humanize(industry)) : [],
      Website: website ? Builder.url(website) : [],
      Employees: employees !== undefined ? Builder.number(employees) : [],
      Users: users !== undefined ? Builder.number(users) : [],
      Sessions: sessions !== undefined ? Builder.number(sessions) : [],
      "Monthly Spend":
        monthlySpend !== undefined ? Builder.number(monthlySpend) : [],
      "Last Active": lastActive ? Builder.dateTime(lastActive) : [],
      Tags: tags.length > 0 ? Builder.multiSelect(...tags) : [],
      Segments: segments.length > 0 ? Builder.multiSelect(...segments) : [],
      Updated: Builder.dateTime(updated),
      Created: Builder.dateTime(created),
      "Created at Source": sourceCreated ? Builder.dateTime(sourceCreated) : [],
      "External Company ID": externalId ? Builder.richText(externalId) : [],
      "Company ID": Builder.richText(id),
    },
  }
}

export async function runCompaniesPage(
  client: IntercomClient,
  state: CompanySyncState | undefined,
  now: () => Date = () => new Date()
) {
  let page: IntercomCompanyPage
  let restartCount = state?.restartCount ?? 0
  let restarted = false
  if (
    !Number.isSafeInteger(restartCount) ||
    restartCount < 0 ||
    restartCount > MAX_SCROLL_RESTARTS
  ) {
    throw new Error(
      "Intercom company scroll state has an invalid restart count."
    )
  }
  const beforeRequest = clockMillis(now)
  if (scrollExpired(state, beforeRequest)) {
    if (restartCount >= MAX_SCROLL_RESTARTS) {
      throw new Error(
        "Intercom company scroll repeatedly expired between Worker continuations."
      )
    }
    restartCount++
    restarted = true
    page = await client.scrollCompanies()
  } else {
    try {
      page = await client.scrollCompanies(state?.scrollParameter)
    } catch (error) {
      const restartable =
        state?.scrollParameter && restartableScrollError(error)
      if (!restartable || restartCount >= MAX_SCROLL_RESTARTS) throw error

      // Some documented Company Scroll errors require a full restart.
      // Replayed upserts are safe in the same replacement cycle, and the
      // restart limit makes the cycle fail closed before Notion deletes rows.
      restartCount++
      restarted = true
      page = await client.scrollCompanies()
    }
  }
  const lastRequestAt = clockMillis(now)
  const changes = page.records.map(companyToChange)

  // Intercom terminates a company scroll with an empty data page. Its scroll
  // token can stay constant while records advance, so guard on page identity.
  if (page.records.length === 0) {
    if (restarted && state?.pageCount) {
      throw new Error(
        "Intercom company scroll restarted into an empty collection; retry the replacement."
      )
    }
    return { changes, hasMore: false as const }
  }
  if (!page.scrollParameter) {
    throw new Error("Intercom company scroll is missing scroll_param.")
  }

  const first = companyId(page.records[0])
  const last = companyId(page.records[page.records.length - 1])
  const guard = advancePageGuard(
    restarted ? undefined : state,
    `${first}:${last}:${page.records.length}`,
    "company scroll"
  )
  return {
    changes,
    hasMore: true as const,
    nextState: {
      scrollParameter: page.scrollParameter,
      restartCount,
      lastRequestAt,
      ...guard,
    },
  }
}
