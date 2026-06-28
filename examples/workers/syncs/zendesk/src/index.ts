// Entry point — wires together all synced resources: tickets, organizations,
// users, satisfaction ratings, ticket metrics, and SLA policies.
//
// Each resource has its own schema + transform file. This file registers the
// managed databases and sync schedules. Most customization happens in those
// per-resource files; this file rarely needs changes unless you're adjusting
// sync modes, schedules, or adding a new resource.

import { Worker } from "@notionhq/workers"

import {
  fetchTicketsPage,
  fetchOrganizationsPage,
  fetchUsersPage,
  fetchSatisfactionRatingsPage,
  fetchTicketMetricsPage,
  fetchSlaPolicies,
  requireSubdomain,
} from "./zendesk.js"
import { INITIAL_TITLE, PRIMARY_KEY, ticketSchema } from "./schema.js"
import { ticketToChange } from "./transform.js"
import {
  INITIAL_TITLE as ORGS_TITLE,
  PRIMARY_KEY as ORGS_PK,
  organizationSchema,
  organizationToChange,
} from "./organizations.js"
import {
  INITIAL_TITLE as USERS_TITLE,
  PRIMARY_KEY as USERS_PK,
  userSchema,
  userToChange,
} from "./users.js"
import {
  INITIAL_TITLE as CSAT_TITLE,
  PRIMARY_KEY as CSAT_PK,
  satisfactionRatingSchema,
  satisfactionRatingToChange,
} from "./satisfaction-ratings.js"
import {
  INITIAL_TITLE as METRICS_TITLE,
  PRIMARY_KEY as METRICS_PK,
  ticketMetricSchema,
  ticketMetricToChange,
} from "./ticket-metrics.js"
import {
  INITIAL_TITLE as SLA_TITLE,
  PRIMARY_KEY as SLA_PK,
  slaPolicySchema,
  slaPolicyToChange,
} from "./sla-policies.js"

type SyncState = {
  cursor: string
}

const worker = new Worker()

// Zendesk rate-limits API calls to 400 requests per minute on most plans.
// All syncs share this pacer so they don't exceed the limit collectively.
const pacer = worker.pacer("zendesk", {
  allowedRequests: 380,
  intervalMs: 60_000,
})

// ---------------------------------------------------------------------------
// Tickets — core support ticket data (all plans)
// ---------------------------------------------------------------------------

const tickets = worker.database("tickets", {
  type: "managed",
  initialTitle: INITIAL_TITLE,
  primaryKeyProperty: PRIMARY_KEY,
  schema: ticketSchema,
})

worker.sync("ticketsSync", {
  database: tickets,
  mode: "replace",
  schedule: "2m",
  execute: async (state: SyncState | undefined) => {
    await pacer.wait()
    const subdomain = requireSubdomain()
    const page = await fetchTicketsPage(state?.cursor)
    const changes = page.tickets.map((t) =>
      ticketToChange(t, subdomain, page.users, page.groups, page.orgs)
    )
    return {
      changes,
      hasMore: page.hasMore,
      nextState: page.nextCursor ? { cursor: page.nextCursor } : undefined,
    }
  },
})

// ---------------------------------------------------------------------------
// Organizations — companies / accounts (all plans)
// ---------------------------------------------------------------------------

const organizations = worker.database("organizations", {
  type: "managed",
  initialTitle: ORGS_TITLE,
  primaryKeyProperty: ORGS_PK,
  schema: organizationSchema,
})

worker.sync("organizationsSync", {
  database: organizations,
  mode: "replace",
  schedule: "5m",
  execute: async (state: SyncState | undefined) => {
    await pacer.wait()
    const page = await fetchOrganizationsPage(state?.cursor)
    const changes = page.organizations.map(organizationToChange)
    return {
      changes,
      hasMore: page.hasMore,
      nextState: page.nextCursor ? { cursor: page.nextCursor } : undefined,
    }
  },
})

// ---------------------------------------------------------------------------
// Users — agents and end-users (all plans)
// ---------------------------------------------------------------------------

const users = worker.database("users", {
  type: "managed",
  initialTitle: USERS_TITLE,
  primaryKeyProperty: USERS_PK,
  schema: userSchema,
})

worker.sync("usersSync", {
  database: users,
  mode: "replace",
  schedule: "5m",
  execute: async (state: SyncState | undefined) => {
    await pacer.wait()
    const page = await fetchUsersPage(state?.cursor)
    const changes = page.users.map(userToChange)
    return {
      changes,
      hasMore: page.hasMore,
      nextState: page.nextCursor ? { cursor: page.nextCursor } : undefined,
    }
  },
})

// ---------------------------------------------------------------------------
// Satisfaction Ratings — CSAT responses with comments (Professional+ plans)
// ---------------------------------------------------------------------------

const satisfactionRatings = worker.database("satisfactionRatings", {
  type: "managed",
  initialTitle: CSAT_TITLE,
  primaryKeyProperty: CSAT_PK,
  schema: satisfactionRatingSchema,
})

worker.sync("satisfactionRatingsSync", {
  database: satisfactionRatings,
  mode: "replace",
  schedule: "5m",
  execute: async (state: SyncState | undefined) => {
    await pacer.wait()
    const page = await fetchSatisfactionRatingsPage(state?.cursor)
    const changes = page.ratings.map(satisfactionRatingToChange)
    return {
      changes,
      hasMore: page.hasMore,
      nextState: page.nextCursor ? { cursor: page.nextCursor } : undefined,
    }
  },
})

// ---------------------------------------------------------------------------
// Ticket Metrics — response times, resolution times, reopens (all plans)
// ---------------------------------------------------------------------------

const ticketMetrics = worker.database("ticketMetrics", {
  type: "managed",
  initialTitle: METRICS_TITLE,
  primaryKeyProperty: METRICS_PK,
  schema: ticketMetricSchema,
})

worker.sync("ticketMetricsSync", {
  database: ticketMetrics,
  mode: "replace",
  schedule: "5m",
  execute: async (state: SyncState | undefined) => {
    await pacer.wait()
    const page = await fetchTicketMetricsPage(state?.cursor)
    const changes = page.metrics.map(ticketMetricToChange)
    return {
      changes,
      hasMore: page.hasMore,
      nextState: page.nextCursor ? { cursor: page.nextCursor } : undefined,
    }
  },
})

// ---------------------------------------------------------------------------
// SLA Policies — SLA definitions and targets (Professional+ plans)
// Small, rarely-changing dataset — manual trigger only.
// ---------------------------------------------------------------------------

const slaPolicies = worker.database("slaPolicies", {
  type: "managed",
  initialTitle: SLA_TITLE,
  primaryKeyProperty: SLA_PK,
  schema: slaPolicySchema,
})

worker.sync("slaPoliciesSync", {
  database: slaPolicies,
  mode: "replace",
  schedule: "1d",
  execute: async () => {
    await pacer.wait()
    const policies = await fetchSlaPolicies()
    const changes = policies.map(slaPolicyToChange)
    return { changes, hasMore: false }
  },
})

export default worker
