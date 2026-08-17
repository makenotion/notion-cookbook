// Serializable state transitions for PagerDuty offset pagination. The REST
// API does not provide snapshot cursors, so each transition validates totals,
// ordering, and progress instead of silently accepting a partial traversal.
//
// Incidents: open -> openConfirm -> recent window(s) -> complete
// Services: discover -> publish -> complete
// Configured services begin directly in publish. The state transitions below
// are pure; index.ts performs I/O, and the Workers runtime persists nextState
// between callbacks.

import type {
  IncidentSyncPhase,
  PagerDutyConfig,
  PagerDutyIncident,
  PagerDutyOffsetPage,
  PagerDutyScope,
  PagerDutyService,
} from "./pagerduty.js"
import { MAX_PAGERDUTY_OFFSET_RECORDS } from "./pagerduty.js"

const DAY_MS = 24 * 60 * 60 * 1_000
export const INCIDENT_WINDOW_DAYS = 7
const INCIDENT_WINDOW_MS = INCIDENT_WINDOW_DAYS * DAY_MS
export const MIN_INCIDENT_WINDOW_MS = 60_000

export type IncidentSyncState = {
  phase: IncidentSyncPhase
  scope: PagerDutyScope
  cycleSince: string
  cycleUntil: string
  windowSince: string
  windowUntil: string
  offset: number
  processed: number
  /** Right-hand boundaries waiting after an oversized window is bisected. */
  pendingWindowUntils: string[]
  /** First-pass IDs that the second all-open pass must reproduce exactly. */
  openIncidentIds: string[]
  expectedTotal?: number
  lastIncidentId?: string
  lastIncidentNumber?: number
}

export type ServiceSyncState = {
  phase: "discover" | "publish"
  scope: PagerDutyScope
  observedAt: string
  offset: number
  expectedTotal?: number
  seenServiceIds: string[]
  /** Complete unscoped discovery set, or the explicitly configured IDs. */
  expectedServiceIds: string[]
}

function scopeFromConfig(
  config: PagerDutyConfig,
  incidentPhase?: IncidentSyncPhase
): PagerDutyScope {
  return {
    region: config.region,
    serviceIds: [...config.serviceIds],
    teamIds: [...config.teamIds],
    ...(incidentPhase ? { incidentPhase } : {}),
  }
}

function timestamp(value: Date | string): number {
  const milliseconds =
    value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(milliseconds)) {
    throw new Error("PagerDuty sync state requires a valid observation time.")
  }
  return milliseconds
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString()
}

function minTimestamp(left: number, right: number): number {
  return left < right ? left : right
}

export function initialIncidentSyncState(
  config: PagerDutyConfig,
  now: Date | string = new Date()
): IncidentSyncState {
  const cycleUntilMs = timestamp(now)
  const cycleSinceMs = cycleUntilMs - config.incidentLookbackDays * DAY_MS
  const windowUntilMs = minTimestamp(
    cycleSinceMs + INCIDENT_WINDOW_MS,
    cycleUntilMs
  )

  return {
    phase: "open",
    scope: scopeFromConfig(config, "open"),
    cycleSince: iso(cycleSinceMs),
    cycleUntil: iso(cycleUntilMs),
    windowSince: iso(cycleSinceMs),
    windowUntil: iso(windowUntilMs),
    offset: 0,
    processed: 0,
    pendingWindowUntils: [],
    openIncidentIds: [],
  }
}

function checkedExpectedTotal(
  previous: number | undefined,
  actual: number,
  resource: string
): number {
  if (previous !== undefined && previous !== actual) {
    throw new Error(
      `PagerDuty ${resource} total changed during pagination (${previous} to ${actual}).`
    )
  }
  return previous ?? actual
}

function checkedNextOffset(
  currentOffset: number,
  nextOffset: number | undefined,
  resource: string
): number {
  if (
    nextOffset === undefined ||
    !Number.isSafeInteger(nextOffset) ||
    nextOffset <= currentOffset
  ) {
    throw new Error(`PagerDuty ${resource} pagination did not advance.`)
  }
  return nextOffset
}

/**
 * Re-read the last record of the previous page. A changing live offset set can
 * otherwise shift an unseen record behind the next offset without changing
 * the reported total.
 */
function checkedOverlappingNextOffset(
  currentOffset: number,
  naturalNextOffset: number | undefined,
  resource: string
): number {
  const nextOffset =
    checkedNextOffset(currentOffset, naturalNextOffset, resource) - 1
  if (nextOffset <= currentOffset) {
    throw new Error(
      `PagerDuty ${resource} pages are too small for boundary overlap.`
    )
  }
  return nextOffset
}

function assertPageOffset(
  expected: number,
  actual: number,
  resource: string
): void {
  if (actual !== expected) {
    throw new Error(
      `PagerDuty ${resource} page offset ${actual} did not match state ${expected}.`
    )
  }
}

function splitRecentIncidentWindow(
  state: IncidentSyncState
): IncidentSyncState {
  const windowSinceMs = timestamp(state.windowSince)
  const windowUntilMs = timestamp(state.windowUntil)
  const durationMs = windowUntilMs - windowSinceMs

  if (durationMs <= MIN_INCIDENT_WINDOW_MS) {
    throw new Error(
      `PagerDuty returned more than ${MAX_PAGERDUTY_OFFSET_RECORDS.toLocaleString()} incidents in a one-minute window. ` +
        "Narrow PAGERDUTY_SERVICE_IDS or PAGERDUTY_TEAM_IDS before retrying."
    )
  }

  // Prefer an even split, but keep the left side at least as wide as this
  // recipe's minimum. Adjacent windows still share the exact boundary.
  const midpointMs = Math.max(
    windowSinceMs + MIN_INCIDENT_WINDOW_MS,
    windowSinceMs + Math.floor(durationMs / 2)
  )
  if (midpointMs >= windowUntilMs) {
    throw new Error("PagerDuty incident time window could not be narrowed.")
  }

  return {
    phase: "recent",
    scope: { ...state.scope, incidentPhase: "recent" },
    cycleSince: state.cycleSince,
    cycleUntil: state.cycleUntil,
    windowSince: state.windowSince,
    windowUntil: iso(midpointMs),
    offset: 0,
    processed: 0,
    pendingWindowUntils: [
      state.windowUntil,
      ...(state.pendingWindowUntils ?? []),
    ],
    openIncidentIds: [],
  }
}

/**
 * Advance within the open scan or one pinned recent subwindow. Adjacent recent
 * windows intentionally share one exact boundary timestamp. Duplicate upserts
 * are harmless; advancing by a guessed precision could miss a record.
 */
export function nextIncidentSyncState(
  state: IncidentSyncState,
  page: PagerDutyOffsetPage<PagerDutyIncident>
): IncidentSyncState | undefined {
  assertPageOffset(state.offset, page.offset, "incident")
  if (state.scope.incidentPhase !== state.phase) {
    throw new Error("PagerDuty incident phase does not match its pinned scope.")
  }

  if (page.total > MAX_PAGERDUTY_OFFSET_RECORDS) {
    if (state.phase !== "recent") {
      throw new Error(
        `PagerDuty returned more than ${MAX_PAGERDUTY_OFFSET_RECORDS.toLocaleString()} open incidents. ` +
          "Narrow PAGERDUTY_SERVICE_IDS or PAGERDUTY_TEAM_IDS before retrying."
      )
    }
    if (!page.requiresWindowSplit || page.resources.length > 0) {
      throw new Error(
        "PagerDuty oversized incident window returned resources before splitting."
      )
    }
    if (state.offset !== 0 || state.processed !== 0) {
      throw new Error(
        "PagerDuty incident window exceeded the offset limit after pagination began."
      )
    }
    return splitRecentIncidentWindow(state)
  }
  if (page.requiresWindowSplit) {
    throw new Error(
      "PagerDuty incident page requested a split below the offset limit."
    )
  }

  const expectedTotal = checkedExpectedTotal(
    state.expectedTotal,
    page.total,
    "incident"
  )

  const expectsBoundary = state.offset > 0
  if (
    expectsBoundary !==
    (state.lastIncidentId !== undefined &&
      state.lastIncidentNumber !== undefined)
  ) {
    throw new Error(
      "PagerDuty incident pagination is missing its overlap boundary."
    )
  }

  let firstNewResource = 0
  let lastIncidentNumber = state.lastIncidentNumber
  if (expectsBoundary) {
    const boundary = page.resources[0]
    if (
      !boundary ||
      boundary.id !== state.lastIncidentId ||
      boundary.incident_number !== state.lastIncidentNumber
    ) {
      throw new Error(
        "PagerDuty incident membership shifted across the page boundary."
      )
    }
    firstNewResource = 1
  }

  for (const incident of page.resources.slice(firstNewResource)) {
    if (
      !Number.isSafeInteger(incident.incident_number) ||
      (lastIncidentNumber !== undefined &&
        incident.incident_number <= lastIncidentNumber)
    ) {
      throw new Error(
        "PagerDuty incidents were not strictly ordered by incident_number."
      )
    }
    lastIncidentNumber = incident.incident_number
  }

  const processed = state.processed + page.resources.length - firstNewResource
  if (processed > expectedTotal) {
    throw new Error(
      "PagerDuty incident pagination exceeded its reported total."
    )
  }

  const newResources = page.resources.slice(firstNewResource)
  const firstPassIds = state.openIncidentIds ?? []
  if (state.phase === "openConfirm") {
    if (page.total !== firstPassIds.length) {
      throw new Error(
        "PagerDuty open incident total changed between confirmation passes."
      )
    }
    for (const [index, incident] of newResources.entries()) {
      if (firstPassIds[state.processed + index] !== incident.id) {
        throw new Error(
          "PagerDuty open incident identities changed between confirmation passes."
        )
      }
    }
  }
  const openIncidentIds =
    state.phase === "open"
      ? [...firstPassIds, ...newResources.map((incident) => incident.id)]
      : firstPassIds

  if (page.more) {
    if (page.resources.length !== page.limit) {
      throw new Error(
        "PagerDuty incident pagination returned a partial continuing page."
      )
    }
    if (processed >= expectedTotal) {
      throw new Error(
        "PagerDuty incident pagination reported more after reaching its total."
      )
    }
    const boundary = page.resources.at(-1)
    if (!boundary) {
      throw new Error("PagerDuty incident pagination has no page boundary.")
    }
    return {
      ...state,
      offset: checkedOverlappingNextOffset(
        state.offset,
        page.nextOffset,
        "incident"
      ),
      processed,
      expectedTotal,
      openIncidentIds,
      lastIncidentId: boundary.id,
      lastIncidentNumber: boundary.incident_number,
    }
  }

  if (processed !== expectedTotal) {
    throw new Error(
      `PagerDuty incident pagination processed ${processed} of ${expectedTotal} records.`
    )
  }

  if (state.phase === "open") {
    // A second full identity pass catches equal-count membership substitutions
    // that can happen entirely before a single overlapped page boundary.
    return {
      phase: "openConfirm",
      scope: { ...state.scope, incidentPhase: "openConfirm" },
      cycleSince: state.cycleSince,
      cycleUntil: state.cycleUntil,
      windowSince: state.cycleSince,
      windowUntil: state.windowUntil,
      offset: 0,
      processed: 0,
      pendingWindowUntils: [],
      openIncidentIds,
    }
  }

  if (state.phase === "openConfirm") {
    if (processed !== firstPassIds.length) {
      throw new Error(
        "PagerDuty open incident confirmation did not reproduce every identity."
      )
    }
    // Reset every open-pass invariant before replaying recent history. Open
    // incidents inside the lookback are harmless idempotent upserts.
    return {
      phase: "recent",
      scope: { ...state.scope, incidentPhase: "recent" },
      cycleSince: state.cycleSince,
      cycleUntil: state.cycleUntil,
      windowSince: state.cycleSince,
      windowUntil: state.windowUntil,
      offset: 0,
      processed: 0,
      pendingWindowUntils: [],
      openIncidentIds: [],
    }
  }

  const currentWindowUntilMs = timestamp(state.windowUntil)
  const cycleUntilMs = timestamp(state.cycleUntil)
  if (currentWindowUntilMs >= cycleUntilMs) return undefined

  const [pendingWindowUntil, ...remainingPendingWindowUntils] =
    state.pendingWindowUntils ?? []
  const nextWindowUntilMs = pendingWindowUntil
    ? timestamp(pendingWindowUntil)
    : minTimestamp(currentWindowUntilMs + INCIDENT_WINDOW_MS, cycleUntilMs)
  if (nextWindowUntilMs <= currentWindowUntilMs) {
    throw new Error("PagerDuty incident time window did not advance.")
  }

  return {
    phase: "recent",
    scope: state.scope,
    cycleSince: state.cycleSince,
    cycleUntil: state.cycleUntil,
    windowSince: state.windowUntil,
    windowUntil: iso(nextWindowUntilMs),
    offset: 0,
    processed: 0,
    pendingWindowUntils: remainingPendingWindowUntils,
    openIncidentIds: [],
  }
}

export function initialServiceSyncState(
  config: PagerDutyConfig,
  now: Date | string = new Date()
): ServiceSyncState {
  return {
    phase: config.serviceIds.length > 0 ? "publish" : "discover",
    scope: scopeFromConfig(config),
    observedAt: iso(timestamp(now)),
    offset: 0,
    seenServiceIds: [],
    expectedServiceIds: [...config.serviceIds],
  }
}

/**
 * Discover then publish unscoped services because the endpoint can only use
 * live offset pagination ordered by mutable name. The publish pass must
 * reproduce the complete discovered identity set before replacement commits.
 */
export function nextServiceSyncState(
  state: ServiceSyncState,
  page: PagerDutyOffsetPage<PagerDutyService>
): ServiceSyncState | undefined {
  assertPageOffset(state.offset, page.offset, "service")
  if (
    state.scope.serviceIds.length === 0 &&
    page.total > MAX_PAGERDUTY_OFFSET_RECORDS
  ) {
    throw new Error(
      `PagerDuty returned more than ${MAX_PAGERDUTY_OFFSET_RECORDS.toLocaleString()} services. ` +
        "Set PAGERDUTY_SERVICE_IDS to the services this Worker should sync."
    )
  }
  const expectedTotal = checkedExpectedTotal(
    state.expectedTotal,
    page.total,
    "service"
  )
  const expectedServiceIds = new Set(state.expectedServiceIds)
  if (
    state.phase === "publish" &&
    page.total !== state.expectedServiceIds.length
  ) {
    throw new Error(
      `PagerDuty service membership changed between discovery and publish (${state.expectedServiceIds.length} to ${page.total}).`
    )
  }
  const seen = new Set(state.seenServiceIds)

  for (const service of page.resources) {
    if (state.phase === "publish" && !expectedServiceIds.has(service.id)) {
      throw new Error(
        `PagerDuty service ${service.id} appeared after service discovery.`
      )
    }
    if (seen.has(service.id)) {
      throw new Error(
        `PagerDuty service pagination repeated service ${service.id}.`
      )
    }
    seen.add(service.id)
  }

  const seenServiceIds = [...seen]
  if (seenServiceIds.length > expectedTotal) {
    throw new Error("PagerDuty service pagination exceeded its reported total.")
  }

  if (page.more) {
    if (seenServiceIds.length >= expectedTotal) {
      throw new Error(
        "PagerDuty service pagination reported more after reaching its total."
      )
    }
    return {
      ...state,
      offset: checkedNextOffset(state.offset, page.nextOffset, "service"),
      expectedTotal,
      seenServiceIds,
    }
  }

  if (seenServiceIds.length !== expectedTotal) {
    throw new Error(
      `PagerDuty service pagination saw ${seenServiceIds.length} of ${expectedTotal} unique services.`
    )
  }

  if (state.phase === "discover") {
    return {
      ...state,
      phase: "publish",
      offset: 0,
      expectedTotal: undefined,
      seenServiceIds: [],
      expectedServiceIds: [...seenServiceIds].sort(),
    }
  }

  if (
    seenServiceIds.some((serviceId) => !expectedServiceIds.has(serviceId)) ||
    state.expectedServiceIds.some((serviceId) => !seen.has(serviceId))
  ) {
    throw new Error(
      "PagerDuty service identities changed between discovery and publish."
    )
  }
  return undefined
}
