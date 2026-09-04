// Entry point — syncs Stripe customers, subscriptions, and charges into
// managed Notion databases for a billing and revenue-operations view.
//
// Three databases are created:
//   1. Stripe Customers      — who is billed (every 15 min)
//   2. Stripe Subscriptions  — recurring billing status (every 15 min)
//   3. Stripe Charges        — individual payment attempts (hourly; higher
//                              volume, so a slower sweep bounds request cost)

// Every API request shares one pacer. All pagination cursors are plain
// serializable state so executions never rely on module globals.

import { Worker } from "@notionhq/workers"

import {
  fetchChargesPage,
  fetchCustomersPage,
  fetchSubscriptionsPage,
} from "./stripe.js"
import {
  INITIAL_TITLE as CUSTOMERS_TITLE,
  PRIMARY_KEY as CUSTOMERS_PK,
  customerSchema,
  customerToChange,
} from "./customers.js"
import {
  INITIAL_TITLE as SUBSCRIPTIONS_TITLE,
  PRIMARY_KEY as SUBSCRIPTIONS_PK,
  subscriptionSchema,
  subscriptionToChange,
} from "./subscriptions.js"
import {
  INITIAL_TITLE as CHARGES_TITLE,
  PRIMARY_KEY as CHARGES_PK,
  chargeSchema,
  chargeToChange,
} from "./charges.js"
import { nextCursorState, type CursorSyncState } from "./sync-state.js"

const worker = new Worker()

// Stripe's default live-mode limit is 100 requests/second; leaving no
// headroom here is fine because the pacer is the only thing calling Stripe
// and every call already blocks on it before firing.
const pacer = worker.pacer("stripe", {
  allowedRequests: 100,
  intervalMs: 1_000,
})
const beforeStripeRequest = () => pacer.wait()

// ---------------------------------------------------------------------------
// Customers — who is billed
// ---------------------------------------------------------------------------

const customers = worker.database("customers", {
  type: "managed",
  initialTitle: CUSTOMERS_TITLE,
  primaryKeyProperty: CUSTOMERS_PK,
  schema: customerSchema,
})

worker.sync("customersSync", {
  database: customers,
  mode: "replace",
  schedule: "15m",
  execute: async (state: CursorSyncState | undefined) => {
    const page = await fetchCustomersPage(beforeStripeRequest, state?.after)
    const changes = page.resources.map(customerToChange)

    return {
      changes,
      hasMore: page.hasMore,
      nextState: page.hasMore
        ? nextCursorState(state, page.nextCursor, "customers")
        : undefined,
    }
  },
})

// ---------------------------------------------------------------------------
// Subscriptions — recurring billing status
// ---------------------------------------------------------------------------

const subscriptions = worker.database("subscriptions", {
  type: "managed",
  initialTitle: SUBSCRIPTIONS_TITLE,
  primaryKeyProperty: SUBSCRIPTIONS_PK,
  schema: subscriptionSchema,
})

worker.sync("subscriptionsSync", {
  database: subscriptions,
  mode: "replace",
  schedule: "15m",
  execute: async (state: CursorSyncState | undefined) => {
    const page = await fetchSubscriptionsPage(beforeStripeRequest, state?.after)
    const changes = page.resources.map(subscriptionToChange)

    return {
      changes,
      hasMore: page.hasMore,
      nextState: page.hasMore
        ? nextCursorState(state, page.nextCursor, "subscriptions")
        : undefined,
    }
  },
})

// ---------------------------------------------------------------------------
// Charges — individual payment attempts
// ---------------------------------------------------------------------------

const charges = worker.database("charges", {
  type: "managed",
  initialTitle: CHARGES_TITLE,
  primaryKeyProperty: CHARGES_PK,
  schema: chargeSchema,
})

worker.sync("chargesSync", {
  database: charges,
  mode: "replace",
  schedule: "1h",
  execute: async (state: CursorSyncState | undefined) => {
    const page = await fetchChargesPage(beforeStripeRequest, state?.after)
    const changes = page.resources.map(chargeToChange)

    return {
      changes,
      hasMore: page.hasMore,
      nextState: page.hasMore
        ? nextCursorState(state, page.nextCursor, "charges")
        : undefined,
    }
  },
})

export default worker
