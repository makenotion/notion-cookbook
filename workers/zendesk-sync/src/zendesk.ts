// Zendesk API client. Handles authentication and paginated fetching for all
// synced resources (tickets, organizations, users, CSAT survey responses,
// ticket metrics, SLA policies).
//
// To add a new resource:
//   1. Add a type for the API response shape
//   2. Add a paginated fetchXxxPage() function
//   3. Wire it into index.ts

import { RateLimitError } from "@notionhq/workers"

// ---------------------------------------------------------------------------
// Shared types and helpers
// ---------------------------------------------------------------------------

const PAGE_SIZE = 100
const INITIAL_EXPORT_START_TIME = 1

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is not set.`)
  }
  return value
}

export function requireSubdomain(): string {
  return requireEnv("ZENDESK_SUBDOMAIN")
}

// Zendesk API tokens use Basic auth as email/token:apitoken (not Bearer).
export function getAuthorizationHeader(): string {
  const apiToken = process.env.ZENDESK_API_TOKEN?.trim()
  if (apiToken) {
    const email = requireEnv("ZENDESK_API_USER_EMAIL")
    return `Basic ${Buffer.from(`${email}/token:${apiToken}`).toString("base64")}`
  }

  const basicAuth = process.env.ZENDESK_BASIC_AUTH_TOKEN?.trim()
  if (basicAuth) {
    return /^basic /i.test(basicAuth) ? basicAuth : `Basic ${basicAuth}`
  }

  throw new Error(
    "Zendesk API credentials not configured. " +
      "Set ZENDESK_API_TOKEN + ZENDESK_API_USER_EMAIL, or ZENDESK_BASIC_AUTH_TOKEN."
  )
}

function retryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get("Retry-After")
  if (!header?.trim()) return undefined
  const value = Number(header)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

async function fetchJson<T>(url: string): Promise<T> {
  const authorization = getAuthorizationHeader()
  const response = await fetch(url, {
    headers: { Authorization: authorization, Accept: "application/json" },
    redirect: "error",
  })

  const text = await response.text()
  if (response.status === 429) {
    throw new RateLimitError({ retryAfter: retryAfterSeconds(response) })
  }
  if (!response.ok) {
    throw new Error(
      `Zendesk API error (${response.status}): ${text || "No response body"}`
    )
  }

  return JSON.parse(text) as T
}

// Generic paginated fetch for any Zendesk list endpoint.
export async function fetchPage<T>(
  subdomain: string,
  path: string,
  extraParams?: Record<string, string>,
  cursor?: string
): Promise<{ data: T; hasMore: boolean; nextCursor: string | undefined }> {
  const base = `https://${subdomain}.zendesk.com${path}`
  const params = new URLSearchParams({
    "page[size]": String(PAGE_SIZE),
    ...extraParams,
  })
  if (cursor) {
    params.set("page[after]", cursor)
  }
  const url = `${base}?${params.toString()}`

  const body = await fetchJson<
    T & { meta: { has_more: boolean; after_cursor?: string | null } }
  >(url)
  const nextCursor = body.meta.has_more
    ? (body.meta.after_cursor ?? undefined)
    : undefined
  if (body.meta.has_more && !nextCursor) {
    throw new Error("Zendesk pagination response is missing after_cursor")
  }

  return {
    data: body,
    hasMore: body.meta.has_more,
    nextCursor,
  }
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

// Add fields here when extending the sync — the Zendesk Tickets API returns
// many more fields than we use. See:
// https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/#json-format
export type ZendeskTicket = {
  id: number
  subject: string
  description: string
  type: string | null
  status: string
  priority: string | null
  assignee_id: number | null
  requester_id: number
  group_id: number | null
  organization_id: number | null
  tags: string[]
  via: { channel: string }
  created_at: string
  updated_at: string
}

export type ZendeskDeletedTicket = {
  id: number
  status: "deleted"
}

export type ZendeskExportTicket = ZendeskTicket | ZendeskDeletedTicket

export function isDeletedTicket(
  ticket: ZendeskExportTicket
): ticket is ZendeskDeletedTicket {
  return ticket.status === "deleted"
}

export type ZendeskUser = {
  id: number
  name: string
  email: string
}

export type ZendeskGroup = {
  id: number
  name: string
}

export type ZendeskOrganizationRef = {
  id: number
  name: string
}

export type UserLookup = Map<number, ZendeskUser>
export type GroupLookup = Map<number, ZendeskGroup>
export type OrgLookup = Map<number, ZendeskOrganizationRef>

type IncrementalTicketsResponse = {
  tickets: ZendeskExportTicket[]
  users?: ZendeskUser[]
  groups?: ZendeskGroup[]
  organizations?: ZendeskOrganizationRef[]
  metric_sets?: ZendeskTicketMetric[]
  after_cursor: string
  end_of_stream: boolean
}

type SearchExportTicket = ZendeskExportTicket & {
  result_type?: string
}

type SearchExportTicketsResponse = {
  results: SearchExportTicket[]
  users?: ZendeskUser[]
  groups?: ZendeskGroup[]
  organizations?: ZendeskOrganizationRef[]
  metric_sets?: ZendeskTicketMetric[]
  meta: {
    has_more: boolean
    after_cursor?: string | null
  }
}

type SearchExportTicketsPage = {
  tickets: ZendeskExportTicket[]
  users: UserLookup
  groups: GroupLookup
  orgs: OrgLookup
  metrics: ZendeskTicketMetric[]
  hasMore: boolean
  nextCursor: string | undefined
}

async function fetchIncrementalTicketsPage(
  includes: string[],
  cursor?: string,
  startTime: number = INITIAL_EXPORT_START_TIME
): Promise<IncrementalTicketsResponse> {
  if (!Number.isSafeInteger(startTime) || startTime < 1) {
    throw new Error(
      "Zendesk incremental export start_time must be a positive Unix timestamp"
    )
  }
  const subdomain = requireSubdomain()
  const url = new URL(
    `https://${subdomain}.zendesk.com/api/v2/incremental/tickets/cursor`
  )
  url.searchParams.set("per_page", String(PAGE_SIZE))
  url.searchParams.set("support_type_scope", "all")
  if (includes.length > 0) {
    url.searchParams.set("include", includes.join(","))
  }
  if (cursor) {
    url.searchParams.set("cursor", cursor)
  } else {
    url.searchParams.set("start_time", String(startTime))
  }

  const page = await fetchJson<IncrementalTicketsResponse>(url.toString())
  if (!page.after_cursor) {
    throw new Error("Zendesk incremental export is missing after_cursor")
  }
  if (!page.end_of_stream && page.after_cursor === cursor) {
    throw new Error("Zendesk incremental export repeated its cursor")
  }
  if (includes.includes("metric_sets") && !Array.isArray(page.metric_sets)) {
    throw new Error(
      "Zendesk incremental export is missing its metric_sets sideload"
    )
  }
  return page
}

function userLookup(users: ZendeskUser[] | undefined): UserLookup {
  return new Map((users ?? []).map((user) => [user.id, user]))
}

function groupLookup(groups: ZendeskGroup[] | undefined): GroupLookup {
  return new Map((groups ?? []).map((group) => [group.id, group]))
}

function organizationLookup(
  organizations: ZendeskOrganizationRef[] | undefined
): OrgLookup {
  return new Map((organizations ?? []).map((org) => [org.id, org]))
}

async function fetchSearchExportTicketsPage(
  createdBefore: string,
  includes: string[],
  cursor?: string
): Promise<SearchExportTicketsPage> {
  const subdomain = requireSubdomain()
  const url = new URL(`https://${subdomain}.zendesk.com/api/v2/search/export`)
  url.searchParams.set("filter[type]", "ticket")
  url.searchParams.set("query", `created<=${createdBefore}`)
  // Zendesk allows up to 1,000 Search Export results but recommends 100 when
  // archived tickets are present because larger responses may time out.
  url.searchParams.set("page[size]", String(PAGE_SIZE))
  url.searchParams.set("include", `tickets(${includes.join(",")})`)
  if (cursor) {
    url.searchParams.set("page[after]", cursor)
  }

  const page = await fetchJson<SearchExportTicketsResponse>(url.toString())
  if (
    !Array.isArray(page.results) ||
    typeof page.meta?.has_more !== "boolean"
  ) {
    throw new Error("Zendesk ticket search export returned an invalid page")
  }
  if (
    page.results.some(
      (result) =>
        result.result_type !== undefined && result.result_type !== "ticket"
    )
  ) {
    throw new Error("Zendesk ticket search export returned a non-ticket result")
  }

  const nextCursor = page.meta.has_more
    ? (page.meta.after_cursor ?? undefined)
    : undefined
  if (page.meta.has_more && !nextCursor) {
    throw new Error("Zendesk ticket search export is missing its after_cursor")
  }
  if (page.meta.has_more && nextCursor === cursor) {
    throw new Error("Zendesk ticket search export repeated its cursor")
  }
  // Search Export can return an empty page with has_more and a new cursor.
  // Continue through it; missing or immediately repeated cursors still fail
  // closed.
  if (includes.includes("metric_sets") && !Array.isArray(page.metric_sets)) {
    // A missing sideload must not be mistaken for an empty metrics keyspace;
    // completing replace mode in that case would delete valid metric pages.
    throw new Error(
      "Zendesk ticket search export is missing its metric_sets sideload"
    )
  }

  return {
    tickets: page.results,
    users: userLookup(page.users),
    groups: groupLookup(page.groups),
    orgs: organizationLookup(page.organizations),
    metrics: page.metric_sets ?? [],
    hasMore: page.meta.has_more,
    nextCursor,
  }
}

// Sideloading embeds related objects in the ticket response so we can
// resolve IDs to names without extra API calls.
export async function fetchTicketsPage(
  cursor?: string,
  startTime: number = INITIAL_EXPORT_START_TIME
): Promise<{
  tickets: ZendeskExportTicket[]
  users: UserLookup
  groups: GroupLookup
  orgs: OrgLookup
  hasMore: boolean
  nextCursor: string
}> {
  const page = await fetchIncrementalTicketsPage(
    ["users", "groups", "organizations"],
    cursor,
    startTime
  )

  return {
    tickets: page.tickets,
    users: userLookup(page.users),
    groups: groupLookup(page.groups),
    orgs: organizationLookup(page.organizations),
    hasMore: !page.end_of_stream,
    nextCursor: page.after_cursor,
  }
}

export async function fetchTicketsReconciliationPage(
  createdBefore: string,
  cursor?: string
): Promise<{
  tickets: ZendeskExportTicket[]
  users: UserLookup
  groups: GroupLookup
  orgs: OrgLookup
  hasMore: boolean
  nextCursor: string | undefined
}> {
  const page = await fetchSearchExportTicketsPage(
    createdBefore,
    ["users", "groups", "organizations"],
    cursor
  )
  return {
    tickets: page.tickets,
    users: page.users,
    groups: page.groups,
    orgs: page.orgs,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  }
}

// ---------------------------------------------------------------------------
// Organizations
// https://developer.zendesk.com/api-reference/ticketing/organizations/organizations/
// ---------------------------------------------------------------------------

export type ZendeskOrganization = {
  id: number
  name: string
  domain_names: string[]
  details: string | null
  notes: string | null
  tags: string[]
  group_id: number | null
  created_at: string
  updated_at: string
}

type ListOrganizationsResponse = {
  organizations: ZendeskOrganization[]
}

export async function fetchOrganizationsPage(cursor?: string): Promise<{
  organizations: ZendeskOrganization[]
  hasMore: boolean
  nextCursor: string | undefined
}> {
  const subdomain = requireSubdomain()
  const { data, hasMore, nextCursor } =
    await fetchPage<ListOrganizationsResponse>(
      subdomain,
      "/api/v2/organizations.json",
      undefined,
      cursor
    )

  return { organizations: data.organizations, hasMore, nextCursor }
}

// ---------------------------------------------------------------------------
// Users
// https://developer.zendesk.com/api-reference/ticketing/users/users/
// ---------------------------------------------------------------------------

export type ZendeskFullUser = {
  id: number
  name: string
  email: string
  role: string
  phone: string | null
  organization_id: number | null
  tags: string[]
  suspended: boolean
  last_login_at: string | null
  created_at: string
  updated_at: string
}

type ListUsersResponse = {
  users: ZendeskFullUser[]
}

export async function fetchUsersPage(cursor?: string): Promise<{
  users: ZendeskFullUser[]
  hasMore: boolean
  nextCursor: string | undefined
}> {
  const subdomain = requireSubdomain()
  const { data, hasMore, nextCursor } = await fetchPage<ListUsersResponse>(
    subdomain,
    "/api/v2/users.json",
    undefined,
    cursor
  )

  return { users: data.users, hasMore, nextCursor }
}

// ---------------------------------------------------------------------------
// CSAT Survey Responses (Support Professional or Suite Growth and above)
// https://developer.zendesk.com/api-reference/ticketing/ticket-management/csat_survey_responses/
// ---------------------------------------------------------------------------

export type ZendeskSurveyAnswer = {
  type: string
  question: {
    id: string
    type: string
    sub_type?: string
    alias?: string
  }
  rating?: number
  rating_category?: string
  value?: string
  created_at?: string
  updated_at?: string
}

export type ZendeskSurveyResponse = {
  id: string
  answers?: ZendeskSurveyAnswer[] | null
  expires_at?: string | null
  responder_id: number
  subjects?:
    | {
        id: string
        type: string
        zrn: string
      }[]
    | null
  survey?: {
    id: string
    version: number
    state: string
  } | null
}

type ListSurveyResponsesResponse = {
  survey_responses: ZendeskSurveyResponse[]
}

export async function fetchSurveyResponsesPage(cursor?: string): Promise<{
  responses: ZendeskSurveyResponse[]
  hasMore: boolean
  nextCursor: string | undefined
}> {
  const subdomain = requireSubdomain()
  const { data, hasMore, nextCursor } =
    await fetchPage<ListSurveyResponsesResponse>(
      subdomain,
      "/api/v2/guide/survey_responses",
      undefined,
      cursor
    )

  return { responses: data.survey_responses, hasMore, nextCursor }
}

// ---------------------------------------------------------------------------
// Ticket Metrics
// https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_metrics/
// ---------------------------------------------------------------------------

export type ZendeskTicketMetric = {
  id: number
  ticket_id: number
  reopens?: number | null
  replies?: number | null
  assignee_stations?: number | null
  group_stations?: number | null
  solved_at?: string | null
  reply_time_in_minutes?: ZendeskMinuteMetric | null
  first_resolution_time_in_minutes?: ZendeskMinuteMetric | null
  full_resolution_time_in_minutes?: ZendeskMinuteMetric | null
  on_hold_time_in_minutes?: ZendeskMinuteMetric | null
  agent_wait_time_in_minutes?: ZendeskMinuteMetric | null
  requester_wait_time_in_minutes?: ZendeskMinuteMetric | null
  created_at?: string | null
  updated_at?: string | null
}

export type ZendeskMinuteMetric = {
  calendar?: number | null
  business?: number | null
}

export async function fetchTicketMetricsPage(
  cursor?: string,
  startTime: number = INITIAL_EXPORT_START_TIME
): Promise<{
  metrics: ZendeskTicketMetric[]
  deletedTicketIds: number[]
  hasMore: boolean
  nextCursor: string
}> {
  const page = await fetchIncrementalTicketsPage(
    ["metric_sets"],
    cursor,
    startTime
  )
  const deletedTicketIds = page.tickets
    .filter(isDeletedTicket)
    .map((ticket) => ticket.id)

  return {
    metrics: page.metric_sets ?? [],
    deletedTicketIds,
    hasMore: !page.end_of_stream,
    nextCursor: page.after_cursor,
  }
}

export async function fetchTicketMetricsReconciliationPage(
  createdBefore: string,
  cursor?: string
): Promise<{
  metrics: ZendeskTicketMetric[]
  hasMore: boolean
  nextCursor: string | undefined
}> {
  const page = await fetchSearchExportTicketsPage(
    createdBefore,
    ["metric_sets"],
    cursor
  )
  const liveTicketIds = new Set(
    page.tickets
      .filter((ticket) => !isDeletedTicket(ticket))
      .map((ticket) => ticket.id)
  )
  return {
    metrics: page.metrics.filter((metric) =>
      liveTicketIds.has(metric.ticket_id)
    ),
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  }
}

// ---------------------------------------------------------------------------
// SLA Policies (Support Professional or Suite Growth and above)
// https://developer.zendesk.com/api-reference/ticketing/business-rules/sla_policies/
// ---------------------------------------------------------------------------

export type ZendeskSlaPolicyMetric = {
  priority: string
  metric: string
  target: number
  business_hours: boolean
}

export type ZendeskSlaPolicy = {
  id: number
  title: string
  description: string | null
  position?: number | null
  policy_metrics?: ZendeskSlaPolicyMetric[] | null
  created_at?: string | null
  updated_at?: string | null
}

type ListSlaPoliciesResponse = {
  sla_policies: ZendeskSlaPolicy[]
  next_page: string | null
}

function validateSlaPageUrl(url: string, subdomain: string): string {
  const parsed = new URL(url)
  const expectedOrigin = `https://${subdomain}.zendesk.com`
  if (
    parsed.origin !== expectedOrigin ||
    !parsed.pathname.startsWith("/api/v2/slas/policies")
  ) {
    throw new Error("Zendesk returned an invalid SLA pagination URL")
  }
  return parsed.toString()
}

export async function fetchSlaPoliciesPage(cursor?: string): Promise<{
  policies: ZendeskSlaPolicy[]
  hasMore: boolean
  nextCursor: string | undefined
}> {
  const subdomain = requireSubdomain()
  const url = cursor
    ? validateSlaPageUrl(cursor, subdomain)
    : `https://${subdomain}.zendesk.com/api/v2/slas/policies`
  const data = await fetchJson<ListSlaPoliciesResponse>(url)

  return {
    policies: data.sla_policies,
    hasMore: Boolean(data.next_page),
    nextCursor: data.next_page
      ? validateSlaPageUrl(data.next_page, subdomain)
      : undefined,
  }
}
