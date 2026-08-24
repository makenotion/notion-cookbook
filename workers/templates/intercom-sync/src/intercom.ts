// Intercom REST API client. It pins the stable API version, selects the
// workspace's regional host, resolves opaque IDs, and turns provider throttling
// into a Workers retry signal. Collection methods fetch exactly one provider
// page; resource executors own cursor continuation through persisted state.

import { RateLimitError } from "@notionhq/workers"

export const INTERCOM_API_VERSION = "2.15"
export const INTERCOM_PAGE_SIZE = 150
// Ticket Search returns full Ticket objects, including potentially large
// ticket_parts collections. Keep Ticket responses much smaller than the
// lightweight list/search endpoints used by the other resources.
export const INTERCOM_TICKET_PAGE_SIZE = 20
const DEFAULT_RETRY_AFTER_SECONDS = 10
const MAX_ERROR_DETAIL_LENGTH = 500

export type BeforeRequest = () => Promise<void>

export class IntercomApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = "IntercomApiError"
  }
}

// These DTOs intentionally model only the fields consumed from the API 2.15
// List, Search, and Scroll responses used by this recipe. Intercom response
// shapes vary by endpoint, so verify the exact collection endpoint before
// extending a projection with fields documented for a Retrieve response.
export type IntercomTag = {
  id?: string | null
  name?: string | null
}

export type IntercomContact = {
  id: string
  external_id?: string | null
  workspace_id?: string | null
  role?: string | null
  email?: string | null
  phone?: string | null
  name?: string | null
  owner_id?: string | number | null
  has_hard_bounced?: boolean | null
  marked_email_as_spam?: boolean | null
  unsubscribed_from_emails?: boolean | null
  created_at: number
  updated_at: number
  signed_up_at?: number | null
  last_seen_at?: number | null
  last_replied_at?: number | null
  last_contacted_at?: number | null
  language_override?: string | null
  tags?: {
    data?: IntercomTag[] | null
    total_count?: number | null
    has_more?: boolean | null
  } | null
  companies?: {
    data?: Array<{
      id?: string | null
      name?: string | null
    }> | null
    total_count?: number | null
    has_more?: boolean | null
  } | null
  location?: {
    country?: string | null
    region?: string | null
    city?: string | null
  } | null
}

export type IntercomCompany = {
  id: string
  name?: string | null
  company_id?: string | null
  created_at: number
  updated_at: number
  remote_created_at?: number | null
  last_request_at?: number | null
  size?: number | null
  website?: string | null
  industry?: string | null
  monthly_spend?: number | null
  session_count?: number | null
  user_count?: number | null
  plan?: {
    id?: string | null
    name?: string | null
  } | null
  tags?: {
    tags?: IntercomTag[] | null
  } | null
  segments?: {
    segments?: Array<{ id?: string | null; name?: string | null }> | null
  } | null
}

export type IntercomConversation = {
  id: string
  title?: string | null
  created_at: number
  updated_at: number
  waiting_since?: number | null
  snoozed_until?: number | null
  state?: string | null
  read?: boolean | null
  priority?: string | null
  admin_assignee_id?: string | number | null
  team_assignee_id?: string | number | null
  company?: {
    id?: string | null
    name?: string | null
  } | null
  tags?: { tags?: IntercomTag[] | null } | null
  source?: {
    type?: string | null
    subject?: string | null
    body?: string | null
    url?: string | null
    redacted?: boolean | null
  } | null
  contacts?: {
    contacts?: Array<{
      id?: string | null
      external_id?: string | null
    }> | null
  } | null
  conversation_rating?: {
    rating?: number | null
    remark?: string | null
  } | null
  sla_applied?: {
    sla_name?: string | null
    sla_status?: string | null
  } | null
  statistics?: {
    time_to_admin_reply?: number | null
    median_time_to_reply?: number | null
    handling_time?: number | null
    adjusted_handling_time?: number | null
    last_contact_reply_at?: number | null
    count_reopens?: number | null
    count_assignments?: number | null
    count_conversation_parts?: number | null
  } | null
  ai_agent?: {
    resolution_state?: string | null
  } | null
  ai_agent_participated?: boolean | null
}

export type IntercomTicket = {
  id: string
  ticket_id?: string | null
  category?: string | null
  created_at: number
  updated_at: number
  open?: boolean | null
  snoozed_until?: number | null
  is_shared?: boolean | null
  admin_assignee_id?: string | number | null
  team_assignee_id?: string | number | null
  ticket_attributes?: Record<string, unknown> | null
  ticket_state?: {
    id?: string | null
    category?: string | null
    internal_label?: string | null
    external_label?: string | null
  } | null
  ticket_type?: {
    id?: string | null
    name?: string | null
  } | null
  contacts?: {
    contacts?: Array<{ id?: string | null }> | null
  } | null
}

export type IntercomPage<T> = {
  records: T[]
  nextCursor?: string
  totalCount?: number
}

export type IntercomCompanyPage = {
  records: IntercomCompany[]
  scrollParameter?: string
}

export type ContactDirectory = {
  admins: Map<string, string>
  tags: Map<string, string>
}

export type AssignmentDirectory = {
  admins: Map<string, string>
  teams: Map<string, string>
}

export type IntercomClient = {
  listContacts(cursor?: string): Promise<IntercomPage<IntercomContact>>
  scrollCompanies(scrollParameter?: string): Promise<IntercomCompanyPage>
  searchConversations(
    since: number,
    until: number,
    cursor?: string
  ): Promise<IntercomPage<IntercomConversation>>
  listConversations(
    cursor?: string
  ): Promise<IntercomPage<IntercomConversation>>
  searchTickets(
    since: number,
    until: number,
    cursor?: string
  ): Promise<IntercomPage<IntercomTicket>>
  searchTicketsForReconciliation(
    createdBefore: number,
    cursor?: string
  ): Promise<IntercomPage<IntercomTicket>>
  fetchContactDirectory(): Promise<ContactDirectory>
  fetchAssignmentDirectory(): Promise<AssignmentDirectory>
}

const API_ROOTS = {
  us: "https://api.intercom.io",
  eu: "https://api.eu.intercom.io",
  au: "https://api.au.intercom.io",
} as const

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is not set.`)
  return value
}

export function getIntercomApiRoot(): string {
  const region = (process.env.INTERCOM_REGION?.trim().toLowerCase() ||
    "us") as keyof typeof API_ROOTS
  const root = API_ROOTS[region]
  if (!root) {
    throw new Error("INTERCOM_REGION must be one of: us, eu, au.")
  }
  return root
}

function errorDetail(text: string): string {
  try {
    const value: unknown = JSON.parse(text)
    if (value && typeof value === "object") {
      const errors = (value as { errors?: unknown }).errors
      if (Array.isArray(errors)) {
        const details = errors
          .map((error) => {
            if (!error || typeof error !== "object") return undefined
            const item = error as { code?: unknown; message?: unknown }
            const code = typeof item.code === "string" ? item.code : undefined
            const message =
              typeof item.message === "string" ? item.message : undefined
            return [code, message].filter(Boolean).join(": ") || undefined
          })
          .filter((detail): detail is string => Boolean(detail))
        if (details.length > 0) {
          return details.join("; ").slice(0, MAX_ERROR_DETAIL_LENGTH)
        }
      }
    }
  } catch {
    // Fall back to a bounded response body below.
  }

  return (text.trim() || "No response body").slice(0, MAX_ERROR_DETAIL_LENGTH)
}

function retryAfterHeaderSeconds(value: string | null): number | undefined {
  if (!value?.trim()) return undefined

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)

  const retryAt = Date.parse(value)
  return Number.isNaN(retryAt)
    ? undefined
    : Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000))
}

function resetHeaderSeconds(value: string | null): number | undefined {
  if (!value?.trim()) return undefined
  const resetAt = Number(value)
  if (!Number.isFinite(resetAt) || resetAt < 0) return undefined
  return Math.max(0, Math.ceil(resetAt - Date.now() / 1_000))
}

export function retryAfterSeconds(response: Response): number {
  const delays = [
    retryAfterHeaderSeconds(response.headers.get("Retry-After")),
    resetHeaderSeconds(response.headers.get("X-RateLimit-Reset")),
  ].filter((value): value is number => value !== undefined)

  return delays.length > 0 ? Math.max(...delays) : DEFAULT_RETRY_AFTER_SECONDS
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`Intercom ${label} returned invalid JSON.`)
  }
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Intercom ${label} response must be an object.`)
  }
  return value as Record<string, unknown>
}

function recordsValue<T>(
  body: Record<string, unknown>,
  key: string,
  label: string
): T[] {
  const records = body[key]
  if (!Array.isArray(records)) {
    throw new Error(`Intercom ${label} response is missing ${key}.`)
  }
  return records as T[]
}

function nextCursor(body: Record<string, unknown>, label: string) {
  if (body.pages == null) return undefined
  const pages = recordValue(body.pages, `${label} pages`)
  if (pages.next == null) return undefined
  const next = recordValue(pages.next, `${label} next page`)
  const cursor = next.starting_after
  if (typeof cursor !== "string" || !cursor.trim()) {
    throw new Error(`Intercom ${label} next page is missing starting_after.`)
  }
  return cursor
}

function requiredTotalCount(
  body: Record<string, unknown>,
  label: string
): number {
  const totalCount = body.total_count
  if (
    typeof totalCount !== "number" ||
    !Number.isSafeInteger(totalCount) ||
    totalCount < 0
  ) {
    throw new Error(`Intercom ${label} response is missing total_count.`)
  }
  return totalCount
}

function displayName(value: {
  name?: unknown
  email?: unknown
}): string | undefined {
  const name = typeof value.name === "string" ? value.name.trim() : ""
  if (name) return name
  const email = typeof value.email === "string" ? value.email.trim() : ""
  return email || undefined
}

function idNameMap(values: unknown[], label: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const value of values) {
    const item = recordValue(value, label)
    const id =
      typeof item.id === "string" || typeof item.id === "number"
        ? String(item.id)
        : undefined
    const name = displayName(item)
    if (id && name) result.set(id, name)
  }
  return result
}

export function createIntercomClient(
  beforeRequest: BeforeRequest
): IntercomClient {
  const apiRoot = getIntercomApiRoot()

  async function fetchJson(
    path: string,
    label: string,
    init?: RequestInit
  ): Promise<Record<string, unknown>> {
    const headers = new Headers(init?.headers)
    headers.set(
      "Authorization",
      `Bearer ${requiredEnv("INTERCOM_ACCESS_TOKEN")}`
    )
    headers.set("Accept", "application/json")
    headers.set("Intercom-Version", INTERCOM_API_VERSION)
    if (init?.body != null) headers.set("Content-Type", "application/json")

    await beforeRequest()
    const response = await fetch(new URL(path, `${apiRoot}/`), {
      ...init,
      headers,
      redirect: "error",
    })
    const text = await response.text()

    if (response.status === 429) {
      throw new RateLimitError({ retryAfter: retryAfterSeconds(response) })
    }
    if (!response.ok) {
      throw new IntercomApiError(
        response.status,
        `Intercom API error (${response.status}) while ${label}: ${errorDetail(text)}`
      )
    }

    return recordValue(parseJson(text, label), label)
  }

  async function listContacts(
    cursor?: string
  ): Promise<IntercomPage<IntercomContact>> {
    const url = new URL("/contacts", `${apiRoot}/`)
    url.searchParams.set("per_page", String(INTERCOM_PAGE_SIZE))
    if (cursor) url.searchParams.set("starting_after", cursor)
    const body = await fetchJson(url.toString(), "listing contacts")
    return {
      records: recordsValue<IntercomContact>(body, "data", "contacts"),
      nextCursor: nextCursor(body, "contacts"),
    }
  }

  async function searchConversations(
    since: number,
    until: number,
    cursor?: string
  ): Promise<IntercomPage<IntercomConversation>> {
    const pagination: { per_page: number; starting_after?: string } = {
      per_page: INTERCOM_PAGE_SIZE,
    }
    if (cursor) pagination.starting_after = cursor

    const body = await fetchJson(
      "/conversations/search",
      "searching conversations",
      {
        method: "POST",
        body: JSON.stringify({
          query: {
            operator: "AND",
            value: [
              { field: "updated_at", operator: ">", value: since },
              { field: "updated_at", operator: "<", value: until },
            ],
          },
          pagination,
          // Search pagination is stateless. An immutable ordering minimizes
          // movement between pages while the fixed time window is in flight.
          sort: { field: "id", order: "ascending" },
        }),
      }
    )
    return {
      records: recordsValue<IntercomConversation>(
        body,
        "conversations",
        "conversation search"
      ),
      nextCursor: nextCursor(body, "conversation search"),
    }
  }

  async function listConversations(
    cursor?: string
  ): Promise<IntercomPage<IntercomConversation>> {
    const url = new URL("/conversations", `${apiRoot}/`)
    url.searchParams.set("per_page", String(INTERCOM_PAGE_SIZE))
    if (cursor) url.searchParams.set("starting_after", cursor)
    const body = await fetchJson(url.toString(), "listing conversations")
    return {
      records: recordsValue<IntercomConversation>(
        body,
        "conversations",
        "conversations"
      ),
      nextCursor: nextCursor(body, "conversations"),
      totalCount: requiredTotalCount(body, "conversation reconciliation"),
    }
  }

  async function searchTickets(
    since: number,
    until: number,
    cursor?: string
  ): Promise<IntercomPage<IntercomTicket>> {
    const pagination: { per_page: number; starting_after?: string } = {
      per_page: INTERCOM_TICKET_PAGE_SIZE,
    }
    if (cursor) pagination.starting_after = cursor

    const body = await fetchJson("/tickets/search", "searching tickets", {
      method: "POST",
      body: JSON.stringify({
        query: {
          operator: "AND",
          value: [
            { field: "updated_at", operator: ">", value: since },
            { field: "updated_at", operator: "<", value: until },
          ],
        },
        pagination,
        sort: { field: "id", order: "ascending" },
      }),
    })
    return {
      records: recordsValue<IntercomTicket>(body, "tickets", "ticket search"),
      nextCursor: nextCursor(body, "ticket search"),
    }
  }

  async function searchTicketsForReconciliation(
    createdBefore: number,
    cursor?: string
  ): Promise<IntercomPage<IntercomTicket>> {
    const pagination: { per_page: number; starting_after?: string } = {
      per_page: INTERCOM_TICKET_PAGE_SIZE,
    }
    if (cursor) pagination.starting_after = cursor

    const body = await fetchJson(
      "/tickets/search",
      "searching tickets for reconciliation",
      {
        method: "POST",
        body: JSON.stringify({
          // Ticket Search is the only collection read endpoint. Creation time
          // is immutable, so this broad query keeps replacement membership
          // steadier than an updated_at filter while the sweep is in flight.
          query: {
            operator: "AND",
            value: [
              { field: "created_at", operator: ">", value: 0 },
              {
                field: "created_at",
                operator: "<",
                value: createdBefore,
              },
            ],
          },
          pagination,
          sort: { field: "id", order: "ascending" },
        }),
      }
    )
    return {
      records: recordsValue<IntercomTicket>(
        body,
        "tickets",
        "ticket reconciliation"
      ),
      nextCursor: nextCursor(body, "ticket reconciliation"),
      totalCount: requiredTotalCount(body, "ticket reconciliation"),
    }
  }

  async function fetchAdmins(): Promise<Map<string, string>> {
    const body = await fetchJson("/admins", "listing admins")
    return idNameMap(recordsValue(body, "admins", "admins"), "admin")
  }

  async function fetchTeams(): Promise<Map<string, string>> {
    const body = await fetchJson("/teams", "listing teams")
    return idNameMap(recordsValue(body, "teams", "teams"), "team")
  }

  async function fetchTags(): Promise<Map<string, string>> {
    const body = await fetchJson("/tags", "listing tags")
    return idNameMap(recordsValue(body, "data", "tags"), "tag")
  }

  async function scrollCompanies(
    scrollParameter?: string
  ): Promise<IntercomCompanyPage> {
    const url = new URL("/companies/scroll", `${apiRoot}/`)
    if (scrollParameter) url.searchParams.set("scroll_param", scrollParameter)
    const body = await fetchJson(url.toString(), "listing companies")
    const records = recordsValue<IntercomCompany>(body, "data", "companies")
    const returned = body.scroll_param
    const nextScrollParameter =
      typeof returned === "string" && returned.trim()
        ? returned.trim()
        : scrollParameter

    if (records.length > 0 && !nextScrollParameter) {
      throw new Error(
        "Intercom company scroll is missing its next scroll_param."
      )
    }
    return { records, scrollParameter: nextScrollParameter }
  }

  return {
    listContacts,
    scrollCompanies,
    searchConversations,
    listConversations,
    searchTickets,
    searchTicketsForReconciliation,
    async fetchContactDirectory() {
      const [admins, tags] = await Promise.all([fetchAdmins(), fetchTags()])
      return { admins, tags }
    },
    async fetchAssignmentDirectory() {
      const [admins, teams] = await Promise.all([fetchAdmins(), fetchTeams()])
      return { admins, teams }
    },
  }
}
