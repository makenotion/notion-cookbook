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
  fetchSlaPoliciesPage,
  isDeletedTicket,
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

// Team accounts allow 200 Support API requests/minute. Keep aggregate general
// traffic below that limit, with headroom for the incremental export pacer.
const generalPacer = worker.pacer("zendesk", {
  allowedRequests: 170,
  intervalMs: 60_000,
})

// Incremental exports have their own 10 requests/minute endpoint limit.
// Tickets and metrics share this pacer so the limit applies collectively.
const incrementalExportPacer = worker.pacer("zendeskIncrementalExports", {
  allowedRequests: 9,
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
  mode: "incremental",
  schedule: "5m",
  execute: async (state: SyncState | undefined) => {
    await incrementalExportPacer.wait()
    const subdomain = requireSubdomain()
    const page = await fetchTicketsPage(state?.cursor)
    const changes = page.tickets.map((t) =>
      isDeletedTicket(t)
        ? { type: "delete" as const, key: String(t.id) }
        : ticketToChange(t, subdomain, page.users, page.groups, page.orgs)
    )
    return {
      changes,
      hasMore: page.hasMore,
      // Incremental mode persists this checkpoint across scheduled runs,
      // including when this page reaches end_of_stream.
      nextState: { cursor: page.nextCursor },
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
    await generalPacer.wait()
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
    await generalPacer.wait()
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
// Legacy Satisfaction Ratings — CSAT responses for legacy CSAT accounts
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
    await generalPacer.wait()
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
  mode: "incremental",
  schedule: "5m",
  execute: async (state: SyncState | undefined) => {
    await incrementalExportPacer.wait()
    const page = await fetchTicketMetricsPage(state?.cursor)
    const deletedTicketIds = new Set(page.deletedTicketIds)
    const changes = [
      ...page.metrics
        .filter((metric) => !deletedTicketIds.has(metric.ticket_id))
        .map(ticketMetricToChange),
      ...[...deletedTicketIds].map((ticketId) => ({
        type: "delete" as const,
        key: String(ticketId),
      })),
    ]
    return {
      changes,
      hasMore: page.hasMore,
      nextState: { cursor: page.nextCursor },
    }
  },
})

// ---------------------------------------------------------------------------
// SLA Policies — SLA definitions and targets (Support Professional or
// Suite Growth and above). Small, rarely changing, and manually triggered.
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
  schedule: "manual",
  execute: async (state: SyncState | undefined) => {
    await generalPacer.wait()
    const page = await fetchSlaPoliciesPage(state?.cursor)
    const changes = page.policies.map(slaPolicyToChange)
    return {
      changes,
      hasMore: page.hasMore,
      nextState: page.nextCursor ? { cursor: page.nextCursor } : undefined,
    }
  },
})

export default worker
