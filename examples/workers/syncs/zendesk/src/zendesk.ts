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

type ListTicketsResponse = {
  tickets: ZendeskTicket[]
  meta: { has_more: boolean; after_cursor: string }
}

const PAGE_SIZE = 100

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is not set.`)
  }
  return value
}

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

export function buildTicketsUrl(
  subdomain: string,
  cursor?: string
): string {
  const base = `https://${subdomain}.zendesk.com/api/v2/tickets.json`
  const params = new URLSearchParams({ "page[size]": String(PAGE_SIZE) })
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

  return {
    tickets: data.tickets,
    hasMore: data.meta.has_more,
    nextCursor: data.meta.has_more ? data.meta.after_cursor : undefined,
  }
}
