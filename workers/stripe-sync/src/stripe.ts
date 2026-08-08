// Stripe REST API client. Uses the public HTTP API directly (not the Stripe
// SDK) so this example shows the full pagination, pacing, and rate-limit
// behavior a production sync needs, matching the style of the other REST-
// backed syncs in this repository (see ../github-sync/src/github.ts).

import { RateLimitError } from "@notionhq/workers"

// No path segment on the base: `new URL(path, base)` treats a leading-slash
// path as absolute and replaces the entire base path, so "/v1" belongs on
// each request path below instead of here.
const API_BASE_URL = "https://api.stripe.com"
// The maximum page size Stripe's list endpoints accept.
const PAGE_SIZE = 100
// Stripe's rate-limit window is one second; a short fallback delay keeps a
// 429 with no Retry-After header from stalling a run for longer than needed.
const DEFAULT_RETRY_AFTER_SECONDS = 1

export type BeforeRequest = () => Promise<void>

export type StripeListResponse<T> = {
  object: "list"
  data: T[]
  has_more: boolean
  url: string
}

export type StripePage<T> = {
  resources: T[]
  hasMore: boolean
  nextCursor: string | undefined
}

export type StripeAddress = {
  line1: string | null
  line2: string | null
  city: string | null
  state: string | null
  postal_code: string | null
  country: string | null
}

export type StripeCustomer = {
  id: string
  object: "customer"
  name: string | null
  email: string | null
  description: string | null
  balance: number
  currency: string | null
  delinquent: boolean | null
  address: StripeAddress | null
  created: number
  livemode: boolean
}

export type StripePrice = {
  id: string
  nickname: string | null
  unit_amount: number | null
  currency: string
  product: string
  recurring: { interval: "day" | "week" | "month" | "year" } | null
}

export type StripeSubscriptionItem = {
  id: string
  quantity: number | null
  price: StripePrice
  // Stripe API versions on or after 2024-04-10 report the billing period per
  // item instead of on the subscription itself, because a subscription's
  // items can each have an independent billing cycle. Older API versions
  // never populate these fields on the item. See stripe.subscriptionPeriod().
  current_period_start?: number
  current_period_end?: number
}

export type StripeSubscription = {
  id: string
  object: "subscription"
  customer: string
  status:
    | "incomplete"
    | "incomplete_expired"
    | "trialing"
    | "active"
    | "past_due"
    | "canceled"
    | "unpaid"
    | "paused"
  currency: string
  items: { data: StripeSubscriptionItem[] }
  // Present on API versions before 2024-04-10; absent afterward.
  current_period_start?: number
  current_period_end?: number
  cancel_at_period_end: boolean
  canceled_at: number | null
  trial_end: number | null
  created: number
  livemode: boolean
}

export type StripeCharge = {
  id: string
  object: "charge"
  customer: string | null
  amount: number
  amount_refunded: number
  currency: string
  status: "succeeded" | "pending" | "failed"
  description: string | null
  refunded: boolean
  failure_message: string | null
  receipt_url: string | null
  created: number
  livemode: boolean
}

type StripeErrorResponse = {
  error?: {
    message?: string
    type?: string
    code?: string
  }
}

function getApiKey(): string {
  const apiKey = process.env.STRIPE_API_KEY?.trim()
  if (!apiKey) {
    throw new Error("STRIPE_API_KEY is not set.")
  }
  return apiKey
}

/**
 * Parse the standard Retry-After header. It can be either delta-seconds or an
 * HTTP date. Workers' RateLimitError expects the resulting delay in seconds.
 */
export function parseRetryAfterSeconds(
  value: string | null,
  now = Date.now()
): number | undefined {
  if (!value?.trim()) return undefined

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds)
  }

  const retryAt = Date.parse(value)
  if (!Number.isFinite(retryAt)) return undefined
  return Math.max(0, Math.ceil((retryAt - now) / 1_000))
}

/**
 * Execute one Stripe REST request. Stripe authenticates with the secret key
 * as a Bearer token (no "sk_..." wrapping or additional signing required).
 */
async function request<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  beforeRequest: BeforeRequest
): Promise<T> {
  const apiKey = getApiKey()
  const apiVersion = process.env.STRIPE_API_VERSION?.trim()

  const url = new URL(path, API_BASE_URL)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }

  await beforeRequest()
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      // Unset by default: an unpinned request uses the account's default API
      // version. Set STRIPE_API_VERSION to pin a specific version instead.
      ...(apiVersion ? { "Stripe-Version": apiVersion } : {}),
    },
    redirect: "error",
  })

  const text = await response.text()

  if (response.status === 429) {
    throw new RateLimitError({
      retryAfter:
        parseRetryAfterSeconds(response.headers.get("retry-after")) ??
        DEFAULT_RETRY_AFTER_SECONDS,
    })
  }

  if (!response.ok) {
    let detail = text || "No response body"
    try {
      const body = JSON.parse(text) as StripeErrorResponse
      if (body.error?.message) detail = body.error.message
    } catch {
      // Fall back to the raw response text below.
    }
    throw new Error(`Stripe API error (${response.status}): ${detail}`)
  }

  if (!text) {
    throw new Error("Stripe API response is missing a body")
  }
  return JSON.parse(text) as T
}

function listToPage<T extends { id: string }>(
  list: StripeListResponse<T>,
  after: string | undefined,
  resourceName: string
): StripePage<T> {
  if (
    !list ||
    list.object !== "list" ||
    !Array.isArray(list.data) ||
    typeof list.has_more !== "boolean"
  ) {
    throw new Error(`Stripe ${resourceName} response has an invalid list shape`)
  }

  if (!list.has_more) {
    return { resources: list.data, hasMore: false, nextCursor: undefined }
  }

  // Stripe pagination has no explicit cursor token: the next `starting_after`
  // is the ID of the last object on this page.
  const lastId = list.data[list.data.length - 1]?.id
  if (!lastId) {
    throw new Error(
      `Stripe ${resourceName} response has more pages but no records to derive a cursor from`
    )
  }
  if (lastId === after) {
    throw new Error(`Stripe ${resourceName} pagination repeated cursor`)
  }

  return { resources: list.data, hasMore: true, nextCursor: lastId }
}

export async function fetchCustomersPage(
  beforeRequest: BeforeRequest,
  after?: string
): Promise<StripePage<StripeCustomer>> {
  const list = await request<StripeListResponse<StripeCustomer>>(
    "/v1/customers",
    { limit: PAGE_SIZE, starting_after: after },
    beforeRequest
  )
  return listToPage(list, after, "customers")
}

export async function fetchSubscriptionsPage(
  beforeRequest: BeforeRequest,
  after?: string
): Promise<StripePage<StripeSubscription>> {
  const list = await request<StripeListResponse<StripeSubscription>>(
    "/v1/subscriptions",
    { limit: PAGE_SIZE, starting_after: after, status: "all" },
    beforeRequest
  )
  return listToPage(list, after, "subscriptions")
}

export async function fetchChargesPage(
  beforeRequest: BeforeRequest,
  after?: string
): Promise<StripePage<StripeCharge>> {
  const list = await request<StripeListResponse<StripeCharge>>(
    "/v1/charges",
    { limit: PAGE_SIZE, starting_after: after },
    beforeRequest
  )
  return listToPage(list, after, "charges")
}

/**
 * Resolve a subscription item's billing period across Stripe API versions.
 * Versions before 2024-04-10 report `current_period_start`/`end` on the
 * subscription; later versions report it per item because items can have
 * independent billing cycles. Prefer the subscription-level value when
 * present, then fall back to the first item's value.
 */
export function subscriptionPeriod(subscription: StripeSubscription): {
  start: number | undefined
  end: number | undefined
} {
  const item = subscription.items.data[0]
  return {
    start: subscription.current_period_start ?? item?.current_period_start,
    end: subscription.current_period_end ?? item?.current_period_end,
  }
}
