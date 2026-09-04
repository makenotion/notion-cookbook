// Entry point — wires together all synced resources: tickets, organizations,
// users, CSAT survey responses, ticket metrics, and SLA policies.
//
// Each resource module owns its schema and transform. This file registers the
// managed databases and sync schedules. Most customization happens in those
// resource files; this file rarely needs changes unless you're adjusting
// sync modes, schedules, or adding a new resource.

import { Worker } from "@notionhq/workers"

import {
  fetchTicketsPage,
  fetchTicketsReconciliationPage,
  fetchOrganizationsPage,
  fetchUsersPage,
  fetchSurveyResponsesPage,
  fetchTicketMetricsPage,
  fetchTicketMetricsReconciliationPage,
  fetchSlaPoliciesPage,
  isDeletedTicket,
  requireSubdomain,
} from "./zendesk.js"
import {
  INITIAL_TITLE,
  PRIMARY_KEY,
  ticketSchema,
  ticketToChange,
} from "./tickets.js"
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
  INITIAL_TITLE as SURVEY_RESPONSES_TITLE,
  PRIMARY_KEY as SURVEY_RESPONSES_PK,
  surveyResponseSchema,
  surveyResponseToChange,
} from "./survey-responses.js"
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

type ReconciliationState = {
  phase: "search" | "tail"
  cutoff: string
  cursor?: string
}

const SEARCH_INDEX_BUFFER_MS = 5 * 60_000

function reconciliationState(
  state: ReconciliationState | undefined,
  resourceName: string
): ReconciliationState {
  if (!state) {
    // Zendesk documents that newly created records can take a few minutes to
    // enter Search. Keep the immutable creation boundary behind that lag; the
    // five-minute incremental capability owns the newer tail.
    return {
      phase: "search",
      cutoff: new Date(Date.now() - SEARCH_INDEX_BUFFER_MS).toISOString(),
    }
  }

  if (state.phase !== "search" && state.phase !== "tail") {
    throw new Error(
      `Zendesk ${resourceName} reconciliation has an invalid phase`
    )
  }
  if (
    typeof state.cutoff !== "string" ||
    Number.isNaN(Date.parse(state.cutoff))
  ) {
    throw new Error(
      `Zendesk ${resourceName} reconciliation has an invalid cutoff`
    )
  }
  if (
    state.cursor !== undefined &&
    (typeof state.cursor !== "string" || !state.cursor.trim())
  ) {
    throw new Error(
      `Zendesk ${resourceName} reconciliation has an invalid cursor`
    )
  }
  return state
}

function nextReconciliationState(
  state: ReconciliationState,
  nextCursor: string | undefined,
  resourceName: string
): ReconciliationState {
  if (!nextCursor?.trim()) {
    throw new Error(
      `Zendesk ${resourceName} reconciliation is missing its next cursor`
    )
  }
  return {
    ...state,
    cursor: nextCursor,
  }
}

function tailReconciliationState(
  state: ReconciliationState
): ReconciliationState {
  return {
    phase: "tail",
    cutoff: state.cutoff,
  }
}

function reconciliationTailStart(state: ReconciliationState): number {
  return Math.max(1, Math.floor(Date.parse(state.cutoff) / 1_000))
}

const worker = new Worker()

// Team accounts allow 200 Support API requests/minute. These three independent
// pacers sum to 169 requests/minute, leaving headroom for account activity.
const generalPacer = worker.pacer("zendesk", {
  allowedRequests: 70,
  intervalMs: 60_000,
})

// Incremental exports have their own 10 requests/minute endpoint limit.
// Tickets and metrics share this pacer so the limit applies collectively.
const incrementalExportPacer = worker.pacer("zendeskIncrementalExports", {
  allowedRequests: 9,
  intervalMs: 60_000,
})

// Search Export has a separate 100-request/minute account limit. Both manual
// reconciliation capabilities share this pacer and leave provider headroom.
const searchExportPacer = worker.pacer("zendeskSearchExports", {
  allowedRequests: 90,
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

// Search Export includes archived tickets, unlike the ordinary List Tickets
// endpoint. A pinned creation cutoff keeps membership fixed while its
// short-lived cursor is paged; a fresh incremental tail then adds newer
// tickets before replacement is allowed to complete.
worker.sync("ticketsReconciliationSync", {
  database: tickets,
  mode: "replace",
  schedule: "manual",
  execute: async (state: ReconciliationState | undefined) => {
    const reconciliation = reconciliationState(state, "ticket")
    const subdomain = requireSubdomain()
    if (reconciliation.phase === "search") {
      await searchExportPacer.wait()
      const page = await fetchTicketsReconciliationPage(
        reconciliation.cutoff,
        reconciliation.cursor
      )
      const changes = page.tickets.flatMap((ticket) =>
        isDeletedTicket(ticket)
          ? []
          : [
              ticketToChange(
                ticket,
                subdomain,
                page.users,
                page.groups,
                page.orgs
              ),
            ]
      )
      return {
        changes,
        hasMore: true as const,
        nextState: page.hasMore
          ? nextReconciliationState(reconciliation, page.nextCursor, "ticket")
          : tailReconciliationState(reconciliation),
      }
    }

    await incrementalExportPacer.wait()
    const page = await fetchTicketsPage(
      reconciliation.cursor,
      reconciliationTailStart(reconciliation)
    )
    const changes = page.tickets.map((ticket) =>
      isDeletedTicket(ticket)
        ? { type: "delete" as const, key: String(ticket.id) }
        : ticketToChange(ticket, subdomain, page.users, page.groups, page.orgs)
    )
    return {
      changes,
      hasMore: page.hasMore,
      nextState: page.hasMore
        ? nextReconciliationState(reconciliation, page.nextCursor, "ticket")
        : undefined,
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
// CSAT Survey Responses — current Zendesk customer feedback (Support
// Professional or Suite Growth and above). A daily replace sweep catches
// edited answers because the API has no update-time cursor.
// ---------------------------------------------------------------------------

const surveyResponses = worker.database("surveyResponses", {
  type: "managed",
  initialTitle: SURVEY_RESPONSES_TITLE,
  primaryKeyProperty: SURVEY_RESPONSES_PK,
  schema: surveyResponseSchema,
})

worker.sync("surveyResponsesSync", {
  database: surveyResponses,
  mode: "replace",
  schedule: "1d",
  execute: async (state: SyncState | undefined) => {
    await generalPacer.wait()
    const page = await fetchSurveyResponsesPage(state?.cursor)
    const changes = page.responses.map(surveyResponseToChange)
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

// List Ticket Metrics excludes archived tickets, so this replacement also
// uses Search Export with the documented tickets(metric_sets) sideload. This
// preserves the historical keyspace populated by the incremental export.
worker.sync("ticketMetricsReconciliationSync", {
  database: ticketMetrics,
  mode: "replace",
  schedule: "manual",
  execute: async (state: ReconciliationState | undefined) => {
    const reconciliation = reconciliationState(state, "ticket metric")
    if (reconciliation.phase === "search") {
      await searchExportPacer.wait()
      const page = await fetchTicketMetricsReconciliationPage(
        reconciliation.cutoff,
        reconciliation.cursor
      )
      return {
        changes: page.metrics.map(ticketMetricToChange),
        hasMore: true as const,
        nextState: page.hasMore
          ? nextReconciliationState(
              reconciliation,
              page.nextCursor,
              "ticket metric"
            )
          : tailReconciliationState(reconciliation),
      }
    }

    await incrementalExportPacer.wait()
    const page = await fetchTicketMetricsPage(
      reconciliation.cursor,
      reconciliationTailStart(reconciliation)
    )
    const deletedTicketIds = new Set(page.deletedTicketIds)
    return {
      changes: [
        ...page.metrics
          .filter((metric) => !deletedTicketIds.has(metric.ticket_id))
          .map(ticketMetricToChange),
        ...[...deletedTicketIds].map((ticketId) => ({
          type: "delete" as const,
          key: String(ticketId),
        })),
      ],
      hasMore: page.hasMore,
      nextState: page.hasMore
        ? nextReconciliationState(
            reconciliation,
            page.nextCursor,
            "ticket metric"
          )
        : undefined,
    }
  },
})

// ---------------------------------------------------------------------------
// SLA Policies — SLA definitions and targets (Support Professional or
// Suite Growth and above). Small, rarely changing, and refreshed daily.
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
