// PagerDuty REST API v2 client. Authentication, regional routing, response
// validation, pagination, and rate-limit behavior live here so resource
// transforms remain small and easy to extend.

import { RateLimitError } from "@notionhq/workers"

const API_BASE_URLS = {
  us: "https://api.pagerduty.com",
  eu: "https://api.eu.pagerduty.com",
} as const

const PAGE_SIZE = 100
export const MAX_PAGERDUTY_OFFSET_RECORDS = 10_000
const DEFAULT_LOOKBACK_DAYS = 90
const MAX_LOOKBACK_DAYS = 180
const DEFAULT_RATE_LIMIT_DELAY_SECONDS = 60
const MAX_PAGERDUTY_ID_CHARACTERS = 255
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u

export type PagerDutyRegion = keyof typeof API_BASE_URLS
export type IncidentSyncPhase = "open" | "openConfirm" | "recent"

export type PagerDutyReference = {
  id: string
  type?: string | null
  summary?: string | null
  name?: string | null
  self?: string | null
  html_url?: string | null
}

export type PagerDutyAssignment = {
  at: string
  assignee: PagerDutyReference
}

export type PagerDutyAcknowledgement = {
  at: string
  acknowledger: PagerDutyReference
}

export type PagerDutyIncidentContext = {
  type: string
  href?: string | null
  src?: string | null
  text?: string | null
}

export type PagerDutyTriggerLogEntry = {
  event_details?: { description?: string | null } | null
  channel?: {
    type?: string | null
    description?: string | null
    body?: string | null
    body_content_type?: string | null
    details?: unknown
  } | null
  contexts?: PagerDutyIncidentContext[] | null
}

export type PagerDutyIncidentType = {
  name: string
}

export type PagerDutyIncidentAction = {
  type: string
  at: string
  to?: string | null
}

export type PagerDutyConferenceBridge = {
  conference_url?: string | null
  conference_number?: string | null
}

export type PagerDutyIncident = {
  id: string
  incident_number: number
  title: string
  html_url?: string | null
  status: string
  urgency?: string | null
  priority?: PagerDutyReference | null
  service?: PagerDutyReference | null
  assignments?: PagerDutyAssignment[] | null
  assigned_via?: string | null
  last_status_change_at?: string | null
  last_status_change_by?: PagerDutyReference | null
  resolved_at?: string | null
  incident_type?: PagerDutyIncidentType | null
  pending_actions?: PagerDutyIncidentAction[] | null
  conference_bridge?: PagerDutyConferenceBridge | null
  first_trigger_log_entry?: PagerDutyTriggerLogEntry | null
  alert_counts?: {
    all?: number | null
    triggered?: number | null
    resolved?: number | null
  } | null
  escalation_policy?: PagerDutyReference | null
  teams?: PagerDutyReference[] | null
  acknowledgements?: PagerDutyAcknowledgement[] | null
  created_at: string
  updated_at: string
}

export type PagerDutyUrgencyRule = {
  type: string
  urgency?: string | null
  during_support_hours?: { urgency?: string | null } | null
  outside_support_hours?: { urgency?: string | null } | null
}

export type PagerDutySupportHours = {
  type: string
  time_zone: string
  days_of_week: number[]
  start_time: string
  end_time: string
}

export type PagerDutyService = {
  id: string
  name: string
  description?: string | null
  html_url?: string | null
  status: string
  created_at: string
  last_incident_timestamp?: string | null
  escalation_policy?: PagerDutyReference | null
  teams?: PagerDutyReference[] | null
  integrations?: PagerDutyReference[] | null
  auto_resolve_timeout?: number | null
  acknowledgement_timeout?: number | null
  incident_urgency_rule?: PagerDutyUrgencyRule | null
  support_hours?: PagerDutySupportHours | null
}

export type PagerDutyOnCall = {
  escalation_policy: PagerDutyReference
  user: PagerDutyReference
  schedule?: PagerDutyReference | null
  escalation_level: number
  start: string | null
  end: string | null
}

type PagerDutyOnCallTraversal = {
  onCalls: PagerDutyOnCall[]
  identities: string[]
  total: number
  pageCount: number
}

export type PagerDutyScope = {
  region: PagerDutyRegion
  serviceIds: string[]
  teamIds: string[]
  /** Pinned only for incident traversals; service scopes leave this unset. */
  incidentPhase?: IncidentSyncPhase
}

export type PagerDutyConfig = PagerDutyScope & {
  incidentLookbackDays: number
}

export type PagerDutyOffsetPage<T> = {
  resources: T[]
  offset: number
  limit: number
  total: number
  more: boolean
  nextOffset: number | undefined
  /** The state machine must narrow the time window before emitting resources. */
  requiresWindowSplit?: true
}

export type IncidentPageQuery = {
  since: string
  until: string
  offset?: number
}

export type BeforeRequest = () => Promise<void>

type FetchFunction = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>

export type PagerDutyClientOptions = {
  beforeRequest: BeforeRequest
  fetch?: FetchFunction
  getApiToken?: () => string
}

export type PagerDutyClient = {
  fetchIncidentsPage(
    scope: PagerDutyScope,
    query: IncidentPageQuery
  ): Promise<PagerDutyOffsetPage<PagerDutyIncident>>
  fetchServicesPage(
    scope: PagerDutyScope,
    offset?: number
  ): Promise<PagerDutyOffsetPage<PagerDutyService>>
  fetchCurrentOnCalls(
    scope: PagerDutyScope,
    escalationPolicyIds: string[],
    observedAt: string
  ): Promise<PagerDutyOnCall[]>
}

type Environment = Record<string, string | undefined>

function parseIdList(
  name: string,
  raw: string | undefined,
  { usedAsPathSegment = false }: { usedAsPathSegment?: boolean } = {}
): string[] {
  if (!raw?.trim()) return []

  const ids: string[] = []
  const seen = new Set<string>()
  for (const part of raw.split(",")) {
    const id = part.trim()
    if (!id) continue
    if (CONTROL_CHARACTERS.test(id)) {
      throw new Error(
        `${name} contains a PagerDuty ID with control characters.`
      )
    }
    if (usedAsPathSegment && (id === "." || id === "..")) {
      throw new Error(
        `${name} contains a PagerDuty ID that cannot be used as a URL path segment.`
      )
    }
    if (Array.from(id).length > MAX_PAGERDUTY_ID_CHARACTERS) {
      throw new Error(
        `${name} contains a PagerDuty ID longer than ${MAX_PAGERDUTY_ID_CHARACTERS} characters.`
      )
    }
    if (!seen.has(id)) {
      ids.push(id)
      seen.add(id)
    }
  }

  if (ids.length === 0) {
    throw new Error(`${name} must contain at least one PagerDuty ID when set.`)
  }
  return ids
}

function parseLookbackDays(raw: string | undefined): number {
  if (!raw?.trim()) return DEFAULT_LOOKBACK_DAYS

  const days = Number(raw)
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_LOOKBACK_DAYS) {
    throw new Error(
      `PAGERDUTY_INCIDENT_LOOKBACK_DAYS must be an integer from 1 to ${MAX_LOOKBACK_DAYS}.`
    )
  }
  return days
}

/** Parse non-secret configuration. The API token is read only at request time. */
export function getPagerDutyConfig(
  env: Environment = process.env
): PagerDutyConfig {
  const regionValue = env.PAGERDUTY_REGION?.trim().toLowerCase() || "us"
  if (regionValue !== "us" && regionValue !== "eu") {
    throw new Error('PAGERDUTY_REGION must be either "us" or "eu".')
  }

  return {
    region: regionValue,
    incidentLookbackDays: parseLookbackDays(
      env.PAGERDUTY_INCIDENT_LOOKBACK_DAYS
    ),
    serviceIds: parseIdList(
      "PAGERDUTY_SERVICE_IDS",
      env.PAGERDUTY_SERVICE_IDS,
      { usedAsPathSegment: true }
    ),
    teamIds: parseIdList("PAGERDUTY_TEAM_IDS", env.PAGERDUTY_TEAM_IDS),
  }
}

function requireApiToken(env: Environment = process.env): string {
  const token = env.PAGERDUTY_API_TOKEN?.trim()
  if (!token) throw new Error("PAGERDUTY_API_TOKEN is not set.")
  return token
}

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
 * PagerDuty documents `ratelimit-reset` as a delay in seconds. Accept epoch
 * seconds/milliseconds too, since proxies and older clients have exposed both.
 */
function parseRateLimitResetSeconds(
  value: string | null,
  now: number
): number | undefined {
  if (!value?.trim()) return undefined
  const reset = Number(value)
  if (!Number.isFinite(reset) || reset < 0) return undefined

  if (reset >= 1_000_000_000_000) {
    return Math.max(0, Math.ceil((reset - now) / 1_000))
  }
  if (reset >= 1_000_000_000) {
    return Math.max(0, Math.ceil(reset - now / 1_000))
  }
  return Math.ceil(reset)
}

export function rateLimitRetryAfterSeconds(
  headers: Headers,
  now = Date.now()
): number | undefined {
  const delays = [
    parseRetryAfterSeconds(headers.get("retry-after"), now),
    parseRateLimitResetSeconds(headers.get("ratelimit-reset"), now),
  ].filter((delay): delay is number => delay !== undefined)

  return delays.length > 0 ? Math.max(...delays) : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  resource: string
): string {
  const value = record[key]
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`PagerDuty ${resource} is missing ${key}.`)
  }
  return value
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  resource: string
): void {
  const value = record[key]
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new Error(`PagerDuty ${resource} has an invalid ${key}.`)
  }
}

function requireTimestamp(
  record: Record<string, unknown>,
  key: string,
  resource: string
): string {
  const value = requireString(record, key, resource)
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`PagerDuty ${resource} has an invalid ${key}.`)
  }
  return value
}

function optionalTimestamp(
  record: Record<string, unknown>,
  key: string,
  resource: string
): void {
  optionalString(record, key, resource)
  const value = record[key]
  if (
    typeof value === "string" &&
    value.trim() &&
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`PagerDuty ${resource} has an invalid ${key}.`)
  }
}

function optionalFiniteNumber(
  record: Record<string, unknown>,
  key: string,
  resource: string
): void {
  const value = record[key]
  if (
    value !== undefined &&
    value !== null &&
    (typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new Error(`PagerDuty ${resource} has an invalid ${key}.`)
  }
}

function optionalRecord(
  record: Record<string, unknown>,
  key: string,
  resource: string
): Record<string, unknown> | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) {
    throw new Error(`PagerDuty ${resource} has an invalid ${key}.`)
  }
  return value
}

function validateReference(
  value: unknown,
  resource: string
): PagerDutyReference {
  if (!isRecord(value)) {
    throw new Error(`PagerDuty ${resource} is not a reference object.`)
  }
  requireString(value, "id", resource)
  optionalString(value, "type", resource)
  optionalString(value, "summary", resource)
  optionalString(value, "name", resource)
  optionalString(value, "self", resource)
  optionalString(value, "html_url", resource)
  return value as PagerDutyReference
}

function validateOptionalReference(
  record: Record<string, unknown>,
  key: string,
  resource: string
): void {
  const value = record[key]
  if (value !== undefined && value !== null) {
    validateReference(value, `${resource}.${key}`)
  }
}

function validateReferenceArray(
  record: Record<string, unknown>,
  key: string,
  resource: string
): void {
  const value = record[key]
  if (value === undefined || value === null) return
  if (!Array.isArray(value)) {
    throw new Error(`PagerDuty ${resource} has an invalid ${key}.`)
  }
  value.forEach((item, index) =>
    validateReference(item, `${resource}.${key}[${index}]`)
  )
}

function validateAssignments(
  record: Record<string, unknown>,
  resource: string
): void {
  const value = record.assignments
  if (value === undefined || value === null) return
  if (!Array.isArray(value)) {
    throw new Error(`PagerDuty ${resource} has invalid assignments.`)
  }
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      throw new Error(
        `PagerDuty ${resource}.assignments[${index}] is not an object.`
      )
    }
    requireTimestamp(item, "at", `${resource}.assignments[${index}]`)
    validateReference(
      item.assignee,
      `${resource}.assignments[${index}].assignee`
    )
  })
}

function validateAcknowledgements(
  record: Record<string, unknown>,
  resource: string
): void {
  const value = record.acknowledgements
  if (value === undefined || value === null) return
  if (!Array.isArray(value)) {
    throw new Error(`PagerDuty ${resource} has invalid acknowledgements.`)
  }
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      throw new Error(
        `PagerDuty ${resource}.acknowledgements[${index}] is not an object.`
      )
    }
    requireTimestamp(item, "at", `${resource}.acknowledgements[${index}]`)
    validateReference(
      item.acknowledger,
      `${resource}.acknowledgements[${index}].acknowledger`
    )
  })
}

function validateIncidentDetails(
  record: Record<string, unknown>,
  resource: string
): void {
  const incidentType = optionalRecord(record, "incident_type", resource)
  if (incidentType) {
    requireString(incidentType, "name", `${resource}.incident_type`)
  }

  const pendingActions = record.pending_actions
  if (pendingActions !== undefined && pendingActions !== null) {
    if (!Array.isArray(pendingActions)) {
      throw new Error(`PagerDuty ${resource} has invalid pending_actions.`)
    }
    pendingActions.forEach((action, index) => {
      const actionResource = `${resource}.pending_actions[${index}]`
      if (!isRecord(action)) {
        throw new Error(`PagerDuty ${actionResource} is not an object.`)
      }
      requireString(action, "type", actionResource)
      requireTimestamp(action, "at", actionResource)
      optionalString(action, "to", actionResource)
    })
  }

  const conferenceBridge = optionalRecord(record, "conference_bridge", resource)
  if (conferenceBridge) {
    optionalString(
      conferenceBridge,
      "conference_url",
      `${resource}.conference_bridge`
    )
    optionalString(
      conferenceBridge,
      "conference_number",
      `${resource}.conference_bridge`
    )
  }
}

function validateTriggerLogEntry(
  record: Record<string, unknown>,
  resource: string
): void {
  const trigger = optionalRecord(record, "first_trigger_log_entry", resource)
  if (!trigger) return

  const eventDetails = optionalRecord(
    trigger,
    "event_details",
    `${resource}.first_trigger_log_entry`
  )
  if (eventDetails) {
    optionalString(
      eventDetails,
      "description",
      `${resource}.first_trigger_log_entry.event_details`
    )
  }

  const channel = optionalRecord(
    trigger,
    "channel",
    `${resource}.first_trigger_log_entry`
  )
  if (channel) {
    for (const key of ["type", "description", "body", "body_content_type"]) {
      optionalString(
        channel,
        key,
        `${resource}.first_trigger_log_entry.channel`
      )
    }
  }

  const contexts = trigger.contexts
  if (contexts === undefined || contexts === null) return
  if (!Array.isArray(contexts)) {
    throw new Error(
      `PagerDuty ${resource}.first_trigger_log_entry has invalid contexts.`
    )
  }
  contexts.forEach((context, index) => {
    const contextResource = `${resource}.first_trigger_log_entry.contexts[${index}]`
    if (!isRecord(context)) {
      throw new Error(`PagerDuty ${contextResource} is not an object.`)
    }
    requireString(context, "type", contextResource)
    optionalString(context, "href", contextResource)
    optionalString(context, "src", contextResource)
    optionalString(context, "text", contextResource)
  })
}

function validateIncident(value: unknown, index: number): PagerDutyIncident {
  if (!isRecord(value)) {
    throw new Error(`PagerDuty incidents[${index}] is not an object.`)
  }
  requireString(value, "id", `incidents[${index}]`)
  requireString(value, "title", `incidents[${index}]`)
  requireString(value, "status", `incidents[${index}]`)
  const resource = `incidents[${index}]`
  requireTimestamp(value, "created_at", resource)
  requireTimestamp(value, "updated_at", resource)
  optionalString(value, "html_url", resource)
  optionalString(value, "urgency", resource)
  optionalString(value, "assigned_via", resource)
  optionalTimestamp(value, "last_status_change_at", resource)
  optionalTimestamp(value, "resolved_at", resource)
  validateOptionalReference(value, "priority", resource)
  validateOptionalReference(value, "service", resource)
  validateOptionalReference(value, "escalation_policy", resource)
  validateOptionalReference(value, "last_status_change_by", resource)
  validateReferenceArray(value, "teams", resource)
  validateAssignments(value, resource)
  validateAcknowledgements(value, resource)
  validateIncidentDetails(value, resource)
  validateTriggerLogEntry(value, resource)

  const alertCounts = optionalRecord(value, "alert_counts", resource)
  if (alertCounts) {
    optionalFiniteNumber(alertCounts, "all", `${resource}.alert_counts`)
    optionalFiniteNumber(alertCounts, "triggered", `${resource}.alert_counts`)
    optionalFiniteNumber(alertCounts, "resolved", `${resource}.alert_counts`)
  }

  if (
    !Number.isSafeInteger(value.incident_number) ||
    (value.incident_number as number) < 0
  ) {
    throw new Error(
      `PagerDuty incidents[${index}] has an invalid incident_number.`
    )
  }
  return value as PagerDutyIncident
}

function validateService(value: unknown, index: number): PagerDutyService {
  if (!isRecord(value)) {
    throw new Error(`PagerDuty services[${index}] is not an object.`)
  }
  requireString(value, "id", `services[${index}]`)
  requireString(value, "name", `services[${index}]`)
  requireString(value, "status", `services[${index}]`)
  const resource = `services[${index}]`
  requireTimestamp(value, "created_at", resource)
  optionalString(value, "html_url", resource)
  optionalString(value, "description", resource)
  optionalTimestamp(value, "last_incident_timestamp", resource)
  validateOptionalReference(value, "escalation_policy", resource)
  validateReferenceArray(value, "teams", resource)
  validateReferenceArray(value, "integrations", resource)
  optionalFiniteNumber(value, "auto_resolve_timeout", resource)
  optionalFiniteNumber(value, "acknowledgement_timeout", resource)
  const urgencyRule = optionalRecord(value, "incident_urgency_rule", resource)
  if (urgencyRule) {
    requireString(urgencyRule, "type", `${resource}.incident_urgency_rule`)
    optionalString(urgencyRule, "urgency", `${resource}.incident_urgency_rule`)
    for (const key of ["during_support_hours", "outside_support_hours"]) {
      const rulePart = optionalRecord(
        urgencyRule,
        key,
        `${resource}.incident_urgency_rule`
      )
      if (rulePart) {
        optionalString(
          rulePart,
          "urgency",
          `${resource}.incident_urgency_rule.${key}`
        )
      }
    }
  }

  const supportHours = optionalRecord(value, "support_hours", resource)
  if (supportHours) {
    const supportHoursResource = `${resource}.support_hours`
    requireString(supportHours, "type", supportHoursResource)
    requireString(supportHours, "time_zone", supportHoursResource)
    requireString(supportHours, "start_time", supportHoursResource)
    requireString(supportHours, "end_time", supportHoursResource)

    const daysOfWeek = supportHours.days_of_week
    if (!Array.isArray(daysOfWeek)) {
      throw new Error(
        `PagerDuty ${supportHoursResource} has invalid days_of_week.`
      )
    }
    daysOfWeek.forEach((day, index) => {
      if (!Number.isSafeInteger(day) || (day as number) < 1 || day > 7) {
        throw new Error(
          `PagerDuty ${supportHoursResource}.days_of_week[${index}] is invalid.`
        )
      }
    })
  }
  return value as PagerDutyService
}

function validateOnCall(value: unknown, index: number): PagerDutyOnCall {
  const resource = `oncalls[${index}]`
  if (!isRecord(value)) {
    throw new Error(`PagerDuty ${resource} is not an object.`)
  }

  validateReference(value.escalation_policy, `${resource}.escalation_policy`)
  validateReference(value.user, `${resource}.user`)
  validateOptionalReference(value, "schedule", resource)

  if (
    !Number.isSafeInteger(value.escalation_level) ||
    (value.escalation_level as number) < 1
  ) {
    throw new Error(`PagerDuty ${resource} has an invalid escalation_level.`)
  }

  for (const key of ["start", "end"] as const) {
    if (value[key] !== null) requireTimestamp(value, key, resource)
  }

  return value as unknown as PagerDutyOnCall
}

function onCallIdentity(onCall: PagerDutyOnCall): string {
  return JSON.stringify([
    onCall.escalation_policy.id,
    onCall.escalation_level,
    onCall.user.id,
    onCall.schedule?.id ?? null,
    onCall.start,
    onCall.end,
  ])
}

function deduplicateOnCalls(onCalls: PagerDutyOnCall[]): PagerDutyOnCall[] {
  const unique: PagerDutyOnCall[] = []
  const seen = new Set<string>()
  for (const onCall of onCalls) {
    const identity = onCallIdentity(onCall)
    if (seen.has(identity)) continue
    seen.add(identity)
    unique.push(onCall)
  }
  return unique
}

function requirePageInteger(
  body: Record<string, unknown>,
  key: string,
  minimum: number
): number {
  const value = body[key]
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`PagerDuty pagination response has an invalid ${key}.`)
  }
  return value as number
}

function parseOffsetPage<T>(
  value: unknown,
  collection: string,
  requestedOffset: number,
  validate: (item: unknown, index: number) => T
): PagerDutyOffsetPage<T> {
  if (!isRecord(value)) {
    throw new Error("PagerDuty API response is not an object.")
  }

  const rawResources = value[collection]
  if (!Array.isArray(rawResources)) {
    throw new Error(`PagerDuty response is missing ${collection}.`)
  }

  const offset = requirePageInteger(value, "offset", 0)
  const limit = requirePageInteger(value, "limit", 1)
  const total = requirePageInteger(value, "total", 0)
  if (offset !== requestedOffset) {
    throw new Error(
      `PagerDuty pagination returned offset ${offset}; expected ${requestedOffset}.`
    )
  }
  if (typeof value.more !== "boolean") {
    throw new Error("PagerDuty pagination response is missing more.")
  }

  const resources = rawResources.map(validate)
  if (resources.length > limit) {
    throw new Error(
      "PagerDuty pagination returned more records than its limit."
    )
  }

  const more = value.more
  const nextOffset = more ? offset + limit : undefined
  if (more && resources.length === 0) {
    throw new Error("PagerDuty pagination reported more after an empty page.")
  }
  if (more && resources.length !== limit) {
    throw new Error(
      "PagerDuty pagination returned a partial page while more records remained."
    )
  }
  if (more && (nextOffset ?? offset) <= offset) {
    throw new Error("PagerDuty pagination did not advance its offset.")
  }
  if (more && offset + resources.length >= total) {
    throw new Error("PagerDuty pagination total conflicts with more=true.")
  }
  if (!more && offset + resources.length < total) {
    throw new Error("PagerDuty pagination ended before reaching its total.")
  }

  return { resources, offset, limit, total, more, nextOffset }
}

function addRepeatedParams(url: URL, name: string, values: string[]): void {
  for (const value of values) url.searchParams.append(name, value)
}

function assertDateRange(since: string, until: string): void {
  const sinceMs = Date.parse(since)
  const untilMs = Date.parse(until)
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) {
    throw new Error("PagerDuty incident range must use ISO 8601 timestamps.")
  }
  if (sinceMs > untilMs) {
    throw new Error("PagerDuty incident range starts after it ends.")
  }
}

function apiErrorDetail(text: string, token: string): string {
  try {
    const body = JSON.parse(text) as unknown
    if (!isRecord(body) || !isRecord(body.error))
      return "Unexpected error response"

    const message = body.error.message
    const code = body.error.code
    const safeMessage =
      typeof message === "string"
        ? message.split(token).join("[REDACTED]").slice(0, 300)
        : null
    const safeCode = Number.isSafeInteger(code) ? `code ${code}` : null
    return (
      [safeCode, safeMessage].filter(Boolean).join(": ") || "Request failed"
    )
  } catch {
    return "Unexpected non-JSON error response"
  }
}

export function createPagerDutyClient(
  options: PagerDutyClientOptions
): PagerDutyClient {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const getApiToken = options.getApiToken ?? (() => requireApiToken())

  async function fetchJson(url: URL): Promise<unknown> {
    const token = getApiToken().trim()
    if (!token) throw new Error("PAGERDUTY_API_TOKEN is not set.")

    await options.beforeRequest()
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Token token=${token}`,
        Accept: "application/vnd.pagerduty+json;version=2",
        "Content-Type": "application/json",
        "User-Agent": "notion-cookbook-pagerduty-sync",
      },
      redirect: "error",
    })

    const text = await response.text()
    if (response.status === 429) {
      throw new RateLimitError({
        retryAfter:
          rateLimitRetryAfterSeconds(response.headers) ??
          DEFAULT_RATE_LIMIT_DELAY_SECONDS,
      })
    }
    if (!response.ok) {
      throw new Error(
        `PagerDuty API error (${response.status}): ${apiErrorDetail(text, token)}`
      )
    }
    if (!text) throw new Error("PagerDuty API returned an empty response.")

    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error(
        `PagerDuty API returned invalid JSON (${response.status}).`
      )
    }
  }

  async function fetchOnCallTraversal(
    scope: PagerDutyScope,
    policyIds: string[],
    requestedPolicyIds: ReadonlySet<string>,
    observedAt: string
  ): Promise<PagerDutyOnCallTraversal> {
    const onCalls: PagerDutyOnCall[] = []
    const identities: string[] = []
    let offset = 0
    let processed = 0
    let pageCount = 0
    let expectedTotal: number | undefined

    while (true) {
      const url = new URL("/oncalls", API_BASE_URLS[scope.region])
      url.searchParams.set("limit", String(PAGE_SIZE))
      url.searchParams.set("offset", String(offset))
      url.searchParams.set("total", "true")
      url.searchParams.set("since", observedAt)
      url.searchParams.set("until", observedAt)
      addRepeatedParams(url, "escalation_policy_ids[]", policyIds)

      const page = parseOffsetPage(
        await fetchJson(url),
        "oncalls",
        offset,
        validateOnCall
      )
      pageCount++
      if (page.total > MAX_PAGERDUTY_OFFSET_RECORDS) {
        throw new Error(
          `PagerDuty returned more than ${MAX_PAGERDUTY_OFFSET_RECORDS.toLocaleString()} current on-call entries. ` +
            "Narrow the configured service scope before retrying."
        )
      }
      if (expectedTotal === undefined) {
        expectedTotal = page.total
      } else if (page.total !== expectedTotal) {
        throw new Error(
          `PagerDuty current on-call total changed during pagination (${expectedTotal} to ${page.total}).`
        )
      }

      processed += page.resources.length
      for (const onCall of page.resources) {
        if (!requestedPolicyIds.has(onCall.escalation_policy.id)) {
          throw new Error(
            `PagerDuty returned an on-call entry for unrequested escalation policy ${onCall.escalation_policy.id}.`
          )
        }
        onCalls.push(onCall)
        identities.push(onCallIdentity(onCall))
      }

      if (!page.more) break
      if (page.nextOffset === undefined) {
        throw new Error("PagerDuty on-call pagination did not advance.")
      }
      offset = page.nextOffset
    }

    const total = expectedTotal ?? 0
    if (processed !== total) {
      throw new Error(
        `PagerDuty current on-call pagination processed ${processed} of ${total} entries.`
      )
    }
    identities.sort()
    return { onCalls, identities, total, pageCount }
  }

  return {
    async fetchIncidentsPage(
      scope: PagerDutyScope,
      query: IncidentPageQuery
    ): Promise<PagerDutyOffsetPage<PagerDutyIncident>> {
      const offset = query.offset ?? 0
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new Error(
          "PagerDuty incident offset must be a non-negative integer."
        )
      }
      const phase = scope.incidentPhase ?? "recent"
      assertDateRange(query.since, query.until)

      const url = new URL("/incidents", API_BASE_URLS[scope.region])
      url.searchParams.set("limit", String(PAGE_SIZE))
      url.searchParams.set("offset", String(offset))
      url.searchParams.set("total", "true")
      if (phase !== "recent") {
        // Open incidents remain operationally relevant regardless of age.
        // PagerDuty ignores date bounds when date_range=all.
        url.searchParams.set("date_range", "all")
        addRepeatedParams(url, "statuses[]", ["triggered", "acknowledged"])
      } else {
        url.searchParams.set("since", query.since)
        url.searchParams.set("until", query.until)
      }
      url.searchParams.set("sort_by", "incident_number:asc")
      addRepeatedParams(url, "service_ids[]", scope.serviceIds)
      addRepeatedParams(url, "team_ids[]", scope.teamIds)
      addRepeatedParams(url, "include[]", [
        "assignees",
        "acknowledgers",
        "priorities",
        "teams",
        "escalation_policies",
        "first_trigger_log_entries",
        "conference_bridge",
      ])

      const page = parseOffsetPage(
        await fetchJson(url),
        "incidents",
        offset,
        validateIncident
      )

      if (page.total > MAX_PAGERDUTY_OFFSET_RECORDS) {
        if (phase !== "recent") {
          throw new Error(
            `PagerDuty returned more than ${MAX_PAGERDUTY_OFFSET_RECORDS.toLocaleString()} open incidents. ` +
              "Narrow PAGERDUTY_SERVICE_IDS or PAGERDUTY_TEAM_IDS before retrying."
          )
        }

        // Do not let an incomplete range contribute replacement rows. The
        // next state transition bisects the pinned window and retries at zero.
        return { ...page, resources: [], requiresWindowSplit: true }
      }

      return page
    },

    async fetchServicesPage(
      scope: PagerDutyScope,
      offset = 0
    ): Promise<PagerDutyOffsetPage<PagerDutyService>> {
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new Error(
          "PagerDuty service offset must be a non-negative integer."
        )
      }

      if (scope.serviceIds.length > 0) {
        const id = scope.serviceIds[offset]
        if (!id) {
          throw new Error(
            "PagerDuty configured service pagination offset is out of range."
          )
        }

        // The collection endpoint has no service_ids filter. Resolve one
        // explicitly configured service per Worker invocation so the shared
        // pacer cannot turn one callback into a long sequential request burst.
        const url = new URL(
          `/services/${encodeURIComponent(id)}`,
          API_BASE_URLS[scope.region]
        )
        addRepeatedParams(url, "include[]", ["teams", "escalation_policies"])
        const body = await fetchJson(url)
        if (!isRecord(body) || !("service" in body)) {
          throw new Error(`PagerDuty response is missing service ${id}.`)
        }
        const service = validateService(body.service, offset)
        if (service.id !== id) {
          throw new Error(
            `PagerDuty returned service ${service.id}; expected ${id}.`
          )
        }

        const total = scope.serviceIds.length
        const more = offset + 1 < total
        return {
          resources: [service],
          offset,
          limit: 1,
          total,
          more,
          nextOffset: more ? offset + 1 : undefined,
        }
      }

      const url = new URL("/services", API_BASE_URLS[scope.region])
      url.searchParams.set("limit", String(PAGE_SIZE))
      url.searchParams.set("offset", String(offset))
      url.searchParams.set("total", "true")
      url.searchParams.set("sort_by", "name:asc")
      addRepeatedParams(url, "include[]", ["teams", "escalation_policies"])

      const page = parseOffsetPage(
        await fetchJson(url),
        "services",
        offset,
        validateService
      )
      if (page.total > MAX_PAGERDUTY_OFFSET_RECORDS) {
        throw new Error(
          `PagerDuty returned more than ${MAX_PAGERDUTY_OFFSET_RECORDS.toLocaleString()} services. ` +
            "Set PAGERDUTY_SERVICE_IDS to the services this Worker should sync."
        )
      }
      return page
    },

    async fetchCurrentOnCalls(
      scope: PagerDutyScope,
      escalationPolicyIds: string[],
      observedAt: string
    ): Promise<PagerDutyOnCall[]> {
      if (
        typeof observedAt !== "string" ||
        !observedAt.trim() ||
        !Number.isFinite(Date.parse(observedAt))
      ) {
        throw new Error(
          "PagerDuty on-call observation time must be a valid ISO 8601 timestamp."
        )
      }

      const policyIds: string[] = []
      const requestedPolicyIds = new Set<string>()
      for (const value of escalationPolicyIds) {
        if (typeof value !== "string" || !value.trim()) {
          throw new Error(
            "PagerDuty on-call escalation policy IDs must be non-empty strings."
          )
        }
        const id = value.trim()
        if (!requestedPolicyIds.has(id)) {
          requestedPolicyIds.add(id)
          policyIds.push(id)
        }
      }
      if (policyIds.length === 0) return []

      const initial = await fetchOnCallTraversal(
        scope,
        policyIds,
        requestedPolicyIds,
        observedAt
      )
      if (initial.pageCount === 1) {
        return deduplicateOnCalls(initial.onCalls)
      }

      const confirmation = await fetchOnCallTraversal(
        scope,
        policyIds,
        requestedPolicyIds,
        observedAt
      )
      if (confirmation.total !== initial.total) {
        throw new Error(
          `PagerDuty current on-call total changed between confirmation traversals (${initial.total} to ${confirmation.total}).`
        )
      }
      if (
        confirmation.identities.length !== initial.identities.length ||
        confirmation.identities.some(
          (identity, index) => identity !== initial.identities[index]
        )
      ) {
        throw new Error(
          "PagerDuty current on-call identities changed between confirmation traversals."
        )
      }

      return deduplicateOnCalls(confirmation.onCalls)
    },
  }
}
