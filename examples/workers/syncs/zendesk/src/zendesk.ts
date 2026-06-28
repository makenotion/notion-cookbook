// Zendesk API client. Handles authentication and paginated fetching for all
// synced resources (tickets, organizations, users, satisfaction ratings,
// ticket metrics, SLA policies).
//
// To add a new resource:
//   1. Add a type for the API response shape
//   2. Add a fetchXxxPage() function using fetchPage()
//   3. Wire it into index.ts

// ---------------------------------------------------------------------------
// Shared types and helpers
// ---------------------------------------------------------------------------

const PAGE_SIZE = 100

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

  const authorization = getAuthorizationHeader()
  const response = await fetch(url, {
    headers: { Authorization: authorization, Accept: "application/json" },
    redirect: "error",
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `Zendesk API error (${response.status}): ${text || "No response body"}`
    )
  }

  const body = JSON.parse(text) as T & {
    meta: { has_more: boolean; after_cursor: string }
  }

  return {
    data: body,
    hasMore: body.meta.has_more,
    nextCursor: body.meta.has_more ? body.meta.after_cursor : undefined,
  }
}

// Non-paginated fetch for small collections (e.g. SLA policies).
export async function fetchAll<T>(
  subdomain: string,
  path: string
): Promise<T> {
  const url = `https://${subdomain}.zendesk.com${path}`
  const authorization = getAuthorizationHeader()

  const response = await fetch(url, {
    headers: { Authorization: authorization, Accept: "application/json" },
    redirect: "error",
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `Zendesk API error (${response.status}): ${text || "No response body"}`
    )
  }

  return JSON.parse(text) as T
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
  satisfaction_rating: { score: string } | null
  via: { channel: string }
  created_at: string
  updated_at: string
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

type ListTicketsResponse = {
  tickets: ZendeskTicket[]
  users: ZendeskUser[]
  groups: ZendeskGroup[]
  organizations: ZendeskOrganizationRef[]
}

// Kept for backward compatibility with tests.
export function buildTicketsUrl(
  subdomain: string,
  cursor?: string
): string {
  const base = `https://${subdomain}.zendesk.com/api/v2/tickets.json`
  const params = new URLSearchParams({
    "page[size]": String(PAGE_SIZE),
    include: "users",
  })
  if (cursor) {
    params.set("page[after]", cursor)
  }
  return `${base}?${params.toString()}`
}

// Sideloading embeds related objects in the ticket response so we can
// resolve IDs to names without extra API calls.
export async function fetchTicketsPage(cursor?: string): Promise<{
  tickets: ZendeskTicket[]
  users: UserLookup
  groups: GroupLookup
  orgs: OrgLookup
  hasMore: boolean
  nextCursor: string | undefined
}> {
  const subdomain = requireSubdomain()
  const { data, hasMore, nextCursor } = await fetchPage<ListTicketsResponse>(
    subdomain,
    "/api/v2/tickets.json",
    { include: "users,groups,organizations" },
    cursor
  )

  const users: UserLookup = new Map()
  for (const user of data.users ?? []) {
    users.set(user.id, user)
  }

  const groups: GroupLookup = new Map()
  for (const group of data.groups ?? []) {
    groups.set(group.id, group)
  }

  const orgs: OrgLookup = new Map()
  for (const org of data.organizations ?? []) {
    orgs.set(org.id, org)
  }

  return { tickets: data.tickets, users, groups, orgs, hasMore, nextCursor }
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
// Satisfaction Ratings (Professional+ plans)
// https://developer.zendesk.com/api-reference/ticketing/ticket-management/satisfaction_ratings/
// ---------------------------------------------------------------------------

export type ZendeskSatisfactionRating = {
  id: number
  ticket_id: number
  score: string
  comment: string | null
  requester_id: number
  assignee_id: number
  group_id: number | null
  reason: string | null
  created_at: string
  updated_at: string
}

type ListSatisfactionRatingsResponse = {
  satisfaction_ratings: ZendeskSatisfactionRating[]
}

export async function fetchSatisfactionRatingsPage(cursor?: string): Promise<{
  ratings: ZendeskSatisfactionRating[]
  hasMore: boolean
  nextCursor: string | undefined
}> {
  const subdomain = requireSubdomain()
  const { data, hasMore, nextCursor } =
    await fetchPage<ListSatisfactionRatingsResponse>(
      subdomain,
      "/api/v2/satisfaction_ratings.json",
      undefined,
      cursor
    )

  return { ratings: data.satisfaction_ratings, hasMore, nextCursor }
}

// ---------------------------------------------------------------------------
// Ticket Metrics
// https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_metrics/
// ---------------------------------------------------------------------------

export type ZendeskTicketMetric = {
  id: number
  ticket_id: number
  reopens: number
  replies: number
  assignee_stations: number
  group_stations: number
  solved_at: string | null
  reply_time_in_minutes: { calendar: number; business: number }
  first_resolution_time_in_minutes: { calendar: number; business: number }
  full_resolution_time_in_minutes: { calendar: number; business: number }
  on_hold_time_in_minutes: { calendar: number; business: number }
  agent_wait_time_in_minutes: { calendar: number; business: number }
  requester_wait_time_in_minutes: { calendar: number; business: number }
  created_at: string
  updated_at: string
}

type ListTicketMetricsResponse = {
  ticket_metrics: ZendeskTicketMetric[]
}

export async function fetchTicketMetricsPage(cursor?: string): Promise<{
  metrics: ZendeskTicketMetric[]
  hasMore: boolean
  nextCursor: string | undefined
}> {
  const subdomain = requireSubdomain()
  const { data, hasMore, nextCursor } =
    await fetchPage<ListTicketMetricsResponse>(
      subdomain,
      "/api/v2/ticket_metrics.json",
      undefined,
      cursor
    )

  return { metrics: data.ticket_metrics, hasMore, nextCursor }
}

// ---------------------------------------------------------------------------
// SLA Policies (Professional+ plans)
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
  position: number
  policy_metrics: ZendeskSlaPolicyMetric[]
  created_at: string
  updated_at: string
}

type ListSlaPoliciesResponse = {
  sla_policies: ZendeskSlaPolicy[]
}

// SLA policies are a small collection (typically <20) — no pagination needed.
export async function fetchSlaPolicies(): Promise<ZendeskSlaPolicy[]> {
  const subdomain = requireSubdomain()
  const data = await fetchAll<ListSlaPoliciesResponse>(
    subdomain,
    "/api/v2/slas/policies"
  )

  return data.sla_policies
}
