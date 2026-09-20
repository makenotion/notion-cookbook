// Offline tests for the Stripe sync worker. No real Stripe API calls.
// Run from this directory with `npm test`.

import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { RateLimitError } from "@notionhq/workers"

import { chargeToChange } from "../charges.js"
import { customerToChange } from "../customers.js"
import {
  amountToDecimal,
  dashboardUrl,
  formatAddress,
  formatEnumLabel,
  unixToISO,
} from "../helpers.js"
import worker from "../index.js"
import {
  fetchChargesPage,
  fetchCustomersPage,
  fetchSubscriptionsPage,
  parseRetryAfterSeconds,
  subscriptionPeriod,
} from "../stripe.js"
import type {
  StripeCharge,
  StripeCustomer,
  StripeSubscription,
} from "../stripe.js"
import { subscriptionToChange } from "../subscriptions.js"
import { nextCursorState } from "../sync-state.js"

const originalFetch = globalThis.fetch
const originalApiKey = process.env.STRIPE_API_KEY
const originalApiVersion = process.env.STRIPE_API_VERSION

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalApiKey === undefined) {
    delete process.env.STRIPE_API_KEY
  } else {
    process.env.STRIPE_API_KEY = originalApiKey
  }
  if (originalApiVersion === undefined) {
    delete process.env.STRIPE_API_VERSION
  } else {
    process.env.STRIPE_API_VERSION = originalApiVersion
  }
})

function propertyText(value: unknown): string {
  return JSON.stringify(value)
}

function assertPropertyContains(value: unknown, expected: string): void {
  assert.match(
    propertyText(value),
    new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  )
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fullCustomer: StripeCustomer = {
  id: "cus_full123",
  object: "customer",
  name: "Ada Lovelace",
  email: "ada@example.com",
  description: "Enterprise pilot account",
  balance: -1500,
  currency: "usd",
  delinquent: false,
  address: {
    line1: "123 Analytical Engine Ave",
    line2: "Suite 2",
    city: "London",
    state: null,
    postal_code: "SW1A 1AA",
    country: "GB",
  },
  created: 1_735_689_600, // 2025-01-01T00:00:00Z
  livemode: false,
}

const minimalCustomer: StripeCustomer = {
  id: "cus_minimal456",
  object: "customer",
  name: null,
  email: null,
  description: null,
  balance: 0,
  currency: null,
  delinquent: null,
  address: null,
  created: 1_735_689_600,
  livemode: false,
}

const fullSubscription: StripeSubscription = {
  id: "sub_full123",
  object: "subscription",
  customer: "cus_full123",
  status: "active",
  currency: "usd",
  items: {
    data: [
      {
        id: "si_1",
        quantity: 2,
        price: {
          id: "price_1",
          nickname: "Pro plan",
          unit_amount: 5_000,
          currency: "usd",
          product: "prod_pro",
          recurring: { interval: "month" },
        },
      },
    ],
  },
  current_period_start: 1_735_689_600,
  current_period_end: 1_738_368_000,
  cancel_at_period_end: false,
  canceled_at: null,
  trial_end: null,
  created: 1_735_689_600,
  livemode: false,
}

const minimalSubscription: StripeSubscription = {
  id: "sub_minimal456",
  object: "subscription",
  customer: "cus_minimal456",
  status: "canceled",
  currency: "usd",
  items: { data: [] },
  cancel_at_period_end: false,
  canceled_at: 1_738_368_000,
  trial_end: null,
  created: 1_735_689_600,
  livemode: false,
}

// A 2024-04-10+ API version response: no subscription-level period, only the
// item reports it.
const itemLevelPeriodSubscription: StripeSubscription = {
  ...fullSubscription,
  id: "sub_itemlevel789",
  current_period_start: undefined,
  current_period_end: undefined,
  items: {
    data: [
      {
        ...fullSubscription.items.data[0]!,
        current_period_start: 1_735_689_600,
        current_period_end: 1_738_368_000,
      },
    ],
  },
}

const fullCharge: StripeCharge = {
  id: "ch_full123",
  object: "charge",
  customer: "cus_full123",
  amount: 5_000,
  amount_refunded: 0,
  currency: "usd",
  status: "succeeded",
  description: "Invoice for Pro plan",
  refunded: false,
  failure_message: null,
  receipt_url: "https://pay.stripe.com/receipts/abc123",
  created: 1_735_689_600,
  livemode: false,
}

const minimalCharge: StripeCharge = {
  id: "ch_minimal456",
  object: "charge",
  customer: null,
  amount: 100,
  amount_refunded: 0,
  currency: "jpy",
  status: "failed",
  description: null,
  refunded: false,
  failure_message: "Your card was declined.",
  receipt_url: null,
  created: 1_735_689_600,
  livemode: false,
}

// ---------------------------------------------------------------------------
// Worker manifest
// ---------------------------------------------------------------------------

test("worker manifest preserves databases, sync schedules, and shared pacing", () => {
  assert.deepEqual(
    worker.manifest.databases.map((database) => ({
      key: database.key,
      title: database.config.initialTitle,
      primaryKey: database.config.primaryKeyProperty,
      icon: database.config.schema.databaseIcon,
    })),
    [
      {
        key: "customers",
        title: "Stripe Customers",
        primaryKey: "Stripe Customer ID",
        icon: { type: "notion", icon: "profile", color: "gray" },
      },
      {
        key: "subscriptions",
        title: "Stripe Subscriptions",
        primaryKey: "Stripe Subscription ID",
        icon: { type: "notion", icon: "repeat", color: "gray" },
      },
      {
        key: "charges",
        title: "Stripe Charges",
        primaryKey: "Stripe Charge ID",
        icon: { type: "notion", icon: "receipt", color: "gray" },
      },
    ]
  )

  type SyncManifestConfig = {
    databaseKey: string
    mode: string
    schedule: { type: string; intervalMs: number }
  }
  assert.deepEqual(
    worker.manifest.capabilities.map((capability) => {
      assert.equal(capability._tag, "sync")
      const config = capability.config as SyncManifestConfig
      return {
        key: capability.key,
        databaseKey: config.databaseKey,
        mode: config.mode,
        schedule: config.schedule,
      }
    }),
    [
      {
        key: "customersSync",
        databaseKey: "customers",
        mode: "replace",
        schedule: { type: "interval", intervalMs: 15 * 60_000 },
      },
      {
        key: "subscriptionsSync",
        databaseKey: "subscriptions",
        mode: "replace",
        schedule: { type: "interval", intervalMs: 15 * 60_000 },
      },
      {
        key: "chargesSync",
        databaseKey: "charges",
        mode: "replace",
        schedule: { type: "interval", intervalMs: 60 * 60_000 },
      },
    ]
  )

  assert.deepEqual(worker.manifest.pacers, [
    { key: "stripe", config: { allowedRequests: 100, intervalMs: 1_000 } },
  ])
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test("amountToDecimal divides normal currencies by 100 and leaves zero-decimal currencies untouched", () => {
  assert.equal(amountToDecimal(5_000, "usd"), 50)
  assert.equal(amountToDecimal(5_000, "USD"), 50)
  assert.equal(amountToDecimal(100, "jpy"), 100)
  assert.equal(amountToDecimal(100, "JPY"), 100)
  assert.equal(amountToDecimal(0, "usd"), 0)
  assert.equal(amountToDecimal(-1_500, "usd"), -15)
  assert.equal(amountToDecimal(null, "usd"), null)
  assert.equal(amountToDecimal(undefined, "usd"), null)
  assert.equal(amountToDecimal(500, null), 5)
})

test("unixToISO converts Stripe's Unix-seconds timestamps", () => {
  assert.equal(unixToISO(1_735_689_600), "2025-01-01T00:00:00.000Z")
  assert.equal(unixToISO(null), null)
  assert.equal(unixToISO(undefined), null)
})

test("formatEnumLabel maps known Stripe enums and title-cases unknown ones", () => {
  assert.equal(formatEnumLabel("past_due"), "Past Due")
  assert.equal(formatEnumLabel("incomplete_expired"), "Incomplete Expired")
  assert.equal(formatEnumLabel("succeeded"), "Succeeded")
  assert.equal(formatEnumLabel("some_future_status"), "Some Future Status")
})

test("formatAddress joins present lines and drops missing ones", () => {
  assert.equal(
    formatAddress(fullCustomer.address),
    "123 Analytical Engine Ave, Suite 2, London, SW1A 1AA, GB"
  )
  assert.equal(formatAddress(null), null)
  assert.equal(
    formatAddress({
      line1: null,
      line2: null,
      city: "Remote",
      state: null,
      postal_code: null,
      country: null,
    }),
    "Remote"
  )
})

test("dashboardUrl builds a stable Stripe dashboard link", () => {
  assert.equal(
    dashboardUrl("customers/cus_123"),
    "https://dashboard.stripe.com/customers/cus_123"
  )
})

// ---------------------------------------------------------------------------
// Customer transform
// ---------------------------------------------------------------------------

test("customer transform emits a full record with formatted balance and address", () => {
  const change = customerToChange(fullCustomer)

  assert.equal(change.type, "upsert")
  assert.equal(change.key, fullCustomer.id, "the Stripe customer ID is the key")
  assert.equal(change.pageContentMarkdown, fullCustomer.description)
  assertPropertyContains(change.properties.Name, "Ada Lovelace")
  assertPropertyContains(change.properties.Email, "ada@example.com")
  assertPropertyContains(change.properties.Balance, "-15")
  assertPropertyContains(change.properties.Currency, "USD")
  assertPropertyContains(change.properties.Delinquent, "No")
  assertPropertyContains(change.properties.Address, "123 Analytical Engine Ave")
  assertPropertyContains(change.properties.Description, "Enterprise pilot")
  assertPropertyContains(change.properties["Customer Link"], fullCustomer.id)
  assertPropertyContains(change.properties.Created, "2025-01-01")
  assertPropertyContains(
    change.properties["Stripe Customer ID"],
    fullCustomer.id
  )
})

test("customer transform falls back to email then ID for the title and omits absent fields", () => {
  const change = customerToChange(minimalCustomer)

  assert.equal(change.key, minimalCustomer.id)
  assert.equal(change.pageContentMarkdown, "")
  assertPropertyContains(change.properties.Name, minimalCustomer.id)
  assert.equal(change.properties.Email, undefined)
  assertPropertyContains(change.properties.Balance, "0")
  assert.equal(change.properties.Currency, undefined)
  assertPropertyContains(change.properties.Delinquent, "No")
  assert.equal(change.properties.Address, undefined)
  assert.equal(change.properties.Description, undefined)

  const emailOnly = customerToChange({
    ...minimalCustomer,
    email: "guest@example.com",
  })
  assertPropertyContains(emailOnly.properties.Name, "guest@example.com")
})

// ---------------------------------------------------------------------------
// Subscription transform
// ---------------------------------------------------------------------------

test("subscription transform surfaces the primary item's plan, amount, and period", () => {
  const change = subscriptionToChange(fullSubscription)

  assert.equal(change.type, "upsert")
  assert.equal(change.key, fullSubscription.id)
  assertPropertyContains(change.properties.Title, "Pro plan")
  assertPropertyContains(change.properties.Customer, "cus_full123")
  assertPropertyContains(change.properties.Status, "Active")
  assertPropertyContains(change.properties.Plan, "Pro plan")
  assertPropertyContains(change.properties.Amount, "50")
  assertPropertyContains(change.properties.Currency, "USD")
  assertPropertyContains(change.properties["Billing Interval"], "Month")
  assertPropertyContains(change.properties.Quantity, "2")
  assertPropertyContains(
    change.properties["Current Period Start"],
    "2025-01-01"
  )
  assertPropertyContains(change.properties["Current Period End"], "2025-02-01")
  assertPropertyContains(change.properties["Cancel At Period End"], "No")
  assert.equal(change.properties["Canceled At"], undefined)
  assert.equal(change.properties["Trial End"], undefined)
  assertPropertyContains(
    change.properties["Subscription Link"],
    fullSubscription.id
  )
  assertPropertyContains(
    change.properties["Stripe Subscription ID"],
    fullSubscription.id
  )
})

test("subscription transform handles a canceled subscription with no items", () => {
  const change = subscriptionToChange(minimalSubscription)

  assert.equal(change.key, minimalSubscription.id)
  assertPropertyContains(change.properties.Title, minimalSubscription.id)
  assertPropertyContains(change.properties.Status, "Canceled")
  assert.equal(change.properties.Plan, undefined)
  assert.equal(change.properties.Amount, undefined)
  assert.equal(change.properties["Billing Interval"], undefined)
  assert.equal(change.properties.Quantity, undefined)
  assert.equal(change.properties["Current Period Start"], undefined)
  assertPropertyContains(change.properties["Canceled At"], "2025-02-01")
})

test("subscription period prefers the subscription-level value, then falls back to the item", () => {
  assert.deepEqual(subscriptionPeriod(fullSubscription), {
    start: 1_735_689_600,
    end: 1_738_368_000,
  })
  assert.deepEqual(subscriptionPeriod(itemLevelPeriodSubscription), {
    start: 1_735_689_600,
    end: 1_738_368_000,
  })
  assert.deepEqual(subscriptionPeriod(minimalSubscription), {
    start: undefined,
    end: undefined,
  })

  const change = subscriptionToChange(itemLevelPeriodSubscription)
  assertPropertyContains(
    change.properties["Current Period Start"],
    "2025-01-01"
  )
})

// ---------------------------------------------------------------------------
// Charge transform
// ---------------------------------------------------------------------------

test("charge transform emits a full succeeded record", () => {
  const change = chargeToChange(fullCharge)

  assert.equal(change.type, "upsert")
  assert.equal(change.key, fullCharge.id)
  assert.equal("upstreamUpdatedAt" in change, false)
  assertPropertyContains(change.properties.Title, "Invoice for Pro plan")
  assertPropertyContains(change.properties.Customer, "cus_full123")
  assertPropertyContains(change.properties.Amount, "50")
  assertPropertyContains(change.properties.Currency, "USD")
  assertPropertyContains(change.properties.Status, "Succeeded")
  assertPropertyContains(change.properties.Description, "Invoice for Pro plan")
  assertPropertyContains(change.properties.Refunded, "No")
  assertPropertyContains(change.properties["Amount Refunded"], "0")
  assert.equal(change.properties["Failure Message"], undefined)
  assertPropertyContains(change.properties.Date, "2025-01-01")
  assertPropertyContains(
    change.properties["Receipt Link"],
    "https://pay.stripe.com/receipts/abc123"
  )
  assertPropertyContains(change.properties["Charge Link"], fullCharge.id)
})

test("charge transform falls back to a generated title and formats a zero-decimal currency", () => {
  const change = chargeToChange(minimalCharge)

  assert.equal(change.key, minimalCharge.id)
  assertPropertyContains(change.properties.Title, `Charge ${minimalCharge.id}`)
  assert.equal(change.properties.Customer, undefined)
  assertPropertyContains(change.properties.Amount, "100")
  assertPropertyContains(change.properties.Currency, "JPY")
  assertPropertyContains(change.properties.Status, "Failed")
  assert.equal(change.properties.Description, undefined)
  assertPropertyContains(
    change.properties["Failure Message"],
    "Your card was declined."
  )
  assert.equal(change.properties["Receipt Link"], undefined)
})

// ---------------------------------------------------------------------------
// Sync-state cursor safety
// ---------------------------------------------------------------------------

test("cursor state rejects missing, immediate, and longer repeated cursors", () => {
  assert.throws(
    () => nextCursorState(undefined, undefined, "customers"),
    /Stripe customers pagination is missing next cursor/
  )

  const first = nextCursorState(undefined, "cus_a", "customers")
  assert.deepEqual(first, { after: "cus_a", seenCursors: ["cus_a"] })

  assert.throws(
    () => nextCursorState(first, "cus_a", "customers"),
    /Stripe customers pagination repeated cursor/
  )

  const second = nextCursorState(first, "cus_b", "customers")
  assert.deepEqual(second, {
    after: "cus_b",
    seenCursors: ["cus_a", "cus_b"],
  })
  assert.throws(
    () => nextCursorState(second, "cus_a", "customers"),
    /Stripe customers pagination repeated cursor/,
    "serialized cursor history catches A -> B -> A loops"
  )
})

// ---------------------------------------------------------------------------
// Stripe REST client
// ---------------------------------------------------------------------------

type FetchCall = {
  url: URL
  method: string | undefined
  authorization: string | null
  accept: string | null
  stripeVersion: string | null
}

function installQueuedFetch(
  responses: Array<Response | (() => Response)>,
  calls: FetchCall[]
): void {
  globalThis.fetch = (async (input, init) => {
    const headers = new Headers(init?.headers)
    calls.push({
      url: new URL(String(input)),
      method: init?.method,
      authorization: headers.get("authorization"),
      accept: headers.get("accept"),
      stripeVersion: headers.get("stripe-version"),
    })

    const next = responses.shift()
    assert.ok(next, `unexpected Stripe request: ${String(input)}`)
    return typeof next === "function" ? next() : next
  }) as typeof fetch
}

const noPacing = async (): Promise<void> => {}

function customerList(data: StripeCustomer[], hasMore: boolean): Response {
  return Response.json({
    object: "list",
    data,
    has_more: hasMore,
    url: "/v1/customers",
  })
}

test("Stripe client authenticates with a Bearer secret key and sets limit/starting_after", async () => {
  process.env.STRIPE_API_KEY = "sk_test_12345"
  const calls: FetchCall[] = []
  installQueuedFetch([customerList([fullCustomer], false)], calls)

  const page = await fetchCustomersPage(noPacing, "cus_previous")

  assert.equal(page.resources[0]?.id, fullCustomer.id)
  assert.equal(page.hasMore, false)
  assert.equal(page.nextCursor, undefined)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.method, "GET")
  assert.equal(calls[0]?.authorization, "Bearer sk_test_12345")
  assert.equal(calls[0]?.accept, "application/json")
  assert.equal(calls[0]?.url.pathname, "/v1/customers")
  assert.equal(calls[0]?.url.searchParams.get("limit"), "100")
  assert.equal(calls[0]?.url.searchParams.get("starting_after"), "cus_previous")
  assert.equal(calls[0]?.stripeVersion, null, "no version pinned by default")
})

test("STRIPE_API_VERSION, when set, is sent as the Stripe-Version header", async () => {
  process.env.STRIPE_API_KEY = "sk_test_12345"
  process.env.STRIPE_API_VERSION = "2024-06-20"
  const calls: FetchCall[] = []
  installQueuedFetch([customerList([fullCustomer], false)], calls)

  await fetchCustomersPage(noPacing)

  assert.equal(calls[0]?.stripeVersion, "2024-06-20")
})

test("Stripe pagination derives the next cursor from the last record's ID", async () => {
  process.env.STRIPE_API_KEY = "sk_test_12345"
  const calls: FetchCall[] = []
  installQueuedFetch(
    [
      customerList([fullCustomer, minimalCustomer], true),
      customerList([], false),
    ],
    calls
  )

  const firstPage = await fetchCustomersPage(noPacing)
  assert.equal(firstPage.hasMore, true)
  assert.equal(firstPage.nextCursor, minimalCustomer.id)

  const secondPage = await fetchCustomersPage(noPacing, firstPage.nextCursor)
  assert.equal(secondPage.hasMore, false)
  assert.equal(
    calls[1]?.url.searchParams.get("starting_after"),
    minimalCustomer.id
  )
})

test("subscriptions list always requests status=all so canceled subscriptions are included", async () => {
  process.env.STRIPE_API_KEY = "sk_test_12345"
  const calls: FetchCall[] = []
  installQueuedFetch(
    [
      Response.json({
        object: "list",
        data: [fullSubscription],
        has_more: false,
        url: "/v1/subscriptions",
      }),
    ],
    calls
  )

  await fetchSubscriptionsPage(noPacing)

  assert.equal(calls[0]?.url.searchParams.get("status"), "all")
})

test("a page reporting has_more with no records is rejected instead of looping forever", async () => {
  process.env.STRIPE_API_KEY = "sk_test_12345"
  installQueuedFetch([customerList([], true)], [])

  await assert.rejects(
    () => fetchCustomersPage(noPacing),
    /has more pages but no records to derive a cursor from/
  )
})

test("a repeated cursor from the API is rejected", async () => {
  process.env.STRIPE_API_KEY = "sk_test_12345"
  installQueuedFetch([customerList([fullCustomer], true)], [])

  await assert.rejects(
    () => fetchCustomersPage(noPacing, fullCustomer.id),
    /Stripe customers pagination repeated cursor/
  )
})

test("retry-after parsing handles delta seconds and HTTP dates", () => {
  const now = Date.parse("2026-06-30T12:00:00Z")
  assert.equal(parseRetryAfterSeconds("2", now), 2)
  assert.equal(parseRetryAfterSeconds("Tue, 30 Jun 2026 12:00:07 GMT", now), 7)
  assert.equal(parseRetryAfterSeconds("invalid", now), undefined)
  assert.equal(parseRetryAfterSeconds(null, now), undefined)
})

test("HTTP 429 with Retry-After becomes a RateLimitError with that delay", async () => {
  process.env.STRIPE_API_KEY = "sk_test_12345"
  installQueuedFetch(
    [new Response("", { status: 429, headers: { "Retry-After": "3" } })],
    []
  )

  await assert.rejects(
    () => fetchCustomersPage(noPacing),
    (error: unknown) => {
      assert.ok(error instanceof RateLimitError)
      assert.equal(error.retryAfter, 3)
      return true
    }
  )
})

test("HTTP 429 without Retry-After falls back to a one-second delay", async () => {
  process.env.STRIPE_API_KEY = "sk_test_12345"
  installQueuedFetch([new Response("", { status: 429 })], [])

  await assert.rejects(
    () => fetchCustomersPage(noPacing),
    (error: unknown) => {
      assert.ok(error instanceof RateLimitError)
      assert.equal(error.retryAfter, 1)
      return true
    }
  )
})

test("a non-2xx response surfaces Stripe's error envelope message", async () => {
  process.env.STRIPE_API_KEY = "sk_test_bad"
  installQueuedFetch(
    [
      Response.json(
        {
          error: {
            message: "Invalid API Key provided",
            type: "invalid_request_error",
          },
        },
        { status: 401 }
      ),
    ],
    []
  )

  await assert.rejects(
    () => fetchCustomersPage(noPacing),
    /Stripe API error \(401\): Invalid API Key provided/
  )
})

test("charges page maps the raw list response into a typed page", async () => {
  process.env.STRIPE_API_KEY = "sk_test_12345"
  installQueuedFetch(
    [
      Response.json({
        object: "list",
        data: [fullCharge, minimalCharge],
        has_more: false,
        url: "/v1/charges",
      }),
    ],
    []
  )

  const page = await fetchChargesPage(noPacing)
  assert.deepEqual(
    page.resources.map((charge) => charge.id),
    [fullCharge.id, minimalCharge.id]
  )
  assert.equal(page.hasMore, false)
})

test("missing STRIPE_API_KEY fails fast with a clear error", async () => {
  delete process.env.STRIPE_API_KEY
  await assert.rejects(
    () => fetchCustomersPage(noPacing),
    /STRIPE_API_KEY is not set/
  )
})
