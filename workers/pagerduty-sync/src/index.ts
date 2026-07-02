// Entry point — syncs active and recent PagerDuty incidents and their services
// into related managed Notion databases.
//
// Two databases are created:
//   1. Incidents — operations awareness and handoff (every 5 min)
//   2. Services  — readiness, coverage, ownership, and routing (every 5 min)
//
// Both replacement traversals keep their complete cycle state serializable.

import { Worker } from "@notionhq/workers"

import {
  INITIAL_TITLE as INCIDENTS_TITLE,
  PRIMARY_KEY as INCIDENTS_PK,
  incidentSchema,
  incidentToChange,
} from "./incidents.js"
import {
  createPagerDutyClient,
  getPagerDutyConfig,
  type PagerDutyClient,
  type PagerDutyConfig,
} from "./pagerduty.js"
import {
  INITIAL_TITLE as SERVICES_TITLE,
  PRIMARY_KEY as SERVICES_PK,
  buildServiceOperationalContext,
  serviceSchema,
  serviceToChange,
} from "./services.js"
import {
  initialIncidentSyncState,
  initialServiceSyncState,
  nextIncidentSyncState,
  nextServiceSyncState,
  type IncidentSyncState,
  type ServiceSyncState,
} from "./sync-state.js"

const worker = new Worker()

// PagerDuty's limits depend on the credential and operation. Keep aggregate
// cookbook traffic conservative and still honor server-provided 429 delays.
const pacer = worker.pacer("pagerduty", {
  allowedRequests: 120,
  intervalMs: 60_000,
})
const beforePagerDutyRequest = () => pacer.wait()
const pagerduty = createPagerDutyClient({
  beforeRequest: beforePagerDutyRequest,
})

type ConfigProvider = () => PagerDutyConfig

/**
 * One incidents callback, exported with injectable boundaries so this file is
 * both the production registration point and an end-to-end example to test.
 */
export async function executeIncidents(
  previousState: IncidentSyncState | undefined,
  client: PagerDutyClient = pagerduty,
  readConfig: ConfigProvider = getPagerDutyConfig
) {
  const state = previousState ?? initialIncidentSyncState(readConfig())
  const page = await client.fetchIncidentsPage(state.scope, {
    since: state.windowSince,
    until: state.windowUntil,
    offset: state.offset,
  })
  const nextState = nextIncidentSyncState(state, page)
  // Confirmation validates the complete identity set only. The first open
  // pass already emitted these keys, so replaying their full upserts would add
  // write volume without strengthening replacement completeness.
  const changes =
    state.phase === "openConfirm" ? [] : page.resources.map(incidentToChange)

  return nextState
    ? { changes, hasMore: true as const, nextState }
    : { changes, hasMore: false as const }
}

/** Services have no updated_at, so the state-pinned observation time is used. */
export async function executeServices(
  previousState: ServiceSyncState | undefined,
  client: PagerDutyClient = pagerduty,
  readConfig: ConfigProvider = getPagerDutyConfig
) {
  const state = previousState ?? initialServiceSyncState(readConfig())
  const page = await client.fetchServicesPage(state.scope, state.offset)
  const nextState = nextServiceSyncState(state, page)

  // The unscoped collection is live offset pagination ordered by mutable
  // name. Discover the complete identity set before emitting replacement rows,
  // then require the publish pass to reproduce that set exactly.
  if (state.phase === "discover") {
    if (!nextState) {
      throw new Error(
        "PagerDuty service discovery completed without a publish state."
      )
    }
    return { changes: [], hasMore: true as const, nextState }
  }

  const escalationPolicyIds = [
    ...new Set(
      page.resources.flatMap((service) => {
        const id = service.escalation_policy?.id.trim()
        return id ? [id] : []
      })
    ),
  ]
  const currentOnCalls = await client.fetchCurrentOnCalls(
    state.scope,
    escalationPolicyIds,
    state.observedAt
  )
  const operationalContext = buildServiceOperationalContext(
    escalationPolicyIds,
    currentOnCalls
  )
  const changes = page.resources.map((service) =>
    serviceToChange(service, state.observedAt, operationalContext)
  )

  return nextState
    ? { changes, hasMore: true as const, nextState }
    : { changes, hasMore: false as const }
}

// ---------------------------------------------------------------------------
// Incidents — active plus recent workflow, linked to managed service rows
// ---------------------------------------------------------------------------

const incidents = worker.database("incidents", {
  type: "managed",
  initialTitle: INCIDENTS_TITLE,
  primaryKeyProperty: INCIDENTS_PK,
  schema: incidentSchema,
})

worker.sync("incidentsSync", {
  database: incidents,
  mode: "replace",
  schedule: "5m",
  execute: (previousState: IncidentSyncState | undefined) =>
    executeIncidents(previousState),
})

// ---------------------------------------------------------------------------
// Services — readiness, current coverage, ownership, and routing context
// ---------------------------------------------------------------------------

const services = worker.database("services", {
  type: "managed",
  initialTitle: SERVICES_TITLE,
  primaryKeyProperty: SERVICES_PK,
  schema: serviceSchema,
})

worker.sync("servicesSync", {
  database: services,
  mode: "replace",
  schedule: "5m",
  execute: (previousState: ServiceSyncState | undefined) =>
    executeServices(previousState),
})

export default worker
