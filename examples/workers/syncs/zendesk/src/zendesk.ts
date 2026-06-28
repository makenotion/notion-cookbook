// Zendesk API client. Handles authentication and paginated ticket fetching.
//
// To sync additional related data (e.g. group names, organization names),
// add them to the `include` parameter in buildTicketsUrl:
//   include: "users,groups,organizations"
// Then add the corresponding types and extend the return value of
// fetchTicketsPage to include the new lookup maps.

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

type ListTicketsResponse = {
  tickets: ZendeskTicket[]
  users: ZendeskUser[]
  meta: { has_more: boolean; after_cursor: string }
}

export type UserLookup = Map<number, ZendeskUser>

const PAGE_SIZE = 100

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is not set.`)
  }
  return value
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

// Sideloading (include=users) embeds user objects in the ticket response so
// we can resolve assignee/requester IDs to names without extra API calls.
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

export function requireSubdomain(): string {
  return requireEnv("ZENDESK_SUBDOMAIN")
}

export async function fetchTicketsPage(cursor?: string): Promise<{
  tickets: ZendeskTicket[]
  users: UserLookup
  hasMore: boolean
  nextCursor: string | undefined
}> {
  const subdomain = requireEnv("ZENDESK_SUBDOMAIN")
  const authorization = getAuthorizationHeader()
  const url = buildTicketsUrl(subdomain, cursor)

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

  const data = JSON.parse(text) as ListTicketsResponse

  const users: UserLookup = new Map()
  for (const user of data.users ?? []) {
    users.set(user.id, user)
  }

  return {
    tickets: data.tickets,
    users,
    hasMore: data.meta.has_more,
    nextCursor: data.meta.has_more ? data.meta.after_cursor : undefined,
  }
}
