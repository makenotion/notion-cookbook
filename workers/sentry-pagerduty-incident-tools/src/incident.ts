import { createHash } from "node:crypto"
import type { JSONValue } from "@notionhq/workers/types"
import type { Severity, WorkerConfig } from "./config.js"
import { ProviderError } from "./api-requests.js"
import type {
  PagerDutyDestination,
  PagerDutyIncident,
  PagerDutyClient,
} from "./pagerduty.js"
import type {
  SentryClient,
  SentryInspection,
  SentryIssueCandidate,
  SearchTimeRange,
} from "./sentry.js"
import { SentryStateError } from "./sentry.js"

const DECLARATION_TIMEOUT_MS = 45_000
const RECONCILIATION_RESERVE_MS = 14_000

export interface IssueView extends Record<string, JSONValue> {
  issueId: string
  shortId: string
  title: string
  projectSlug: string
  status: string
  substatus: string | null
  htmlUrl: string
}

export interface EventView extends Record<string, JSONValue> {
  eventId: string
  title: string
  environment: string
  observedAt: string
}

export interface DestinationView extends Record<string, JSONValue> {
  serviceName: string
  serviceUrl: string | null
  hasOnCall: boolean
  priorities: Array<{
    severity: Severity
    priorityName: string
  }>
}

export interface IncidentView extends Record<string, JSONValue> {
  incidentId: string
  incidentNumber: number
  status: "triggered" | "acknowledged" | "resolved"
  priorityName: string | null
  htmlUrl: string
}

export interface SearchResult extends Record<string, JSONValue> {
  status: "completed" | "blocked"
  projectSlug: string
  environment: string
  issues: SentryIssueCandidate[]
  hasMore: boolean
  message: string
}

export interface InspectionResult extends Record<string, JSONValue> {
  status: "ready" | "already_declared" | "ineligible" | "conflict" | "blocked"
  issue: IssueView | null
  event: EventView | null
  destination: DestinationView | null
  existingIncident: IncidentView | null
  message: string
}

export interface DeclarationResult extends Record<string, JSONValue> {
  ok: boolean
  status: "declared" | "already_declared" | "conflict" | "ambiguous" | "blocked"
  changed: boolean | null
  source: {
    issueId: string
    shortId: string
    eventId: string
    htmlUrl: string
  } | null
  incident: IncidentView | null
  requestId: string | null
  message: string
}

interface Dependencies {
  sentry: Pick<SentryClient, "searchIssues" | "inspectIssue" | "verifyEvent">
  pagerDuty: Pick<
    PagerDutyClient,
    "getDestination" | "findIncident" | "createIncident"
  >
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => number
}

function issueView(inspection: SentryInspection): IssueView {
  return {
    issueId: inspection.issue.issueId,
    shortId: inspection.issue.shortId,
    title: inspection.issue.title,
    projectSlug: inspection.issue.projectSlug,
    status: inspection.issue.status,
    substatus: inspection.issue.substatus,
    htmlUrl: inspection.issue.htmlUrl,
  }
}

function eventView(inspection: SentryInspection): EventView {
  return {
    eventId: inspection.event.eventId,
    title: inspection.event.title,
    environment: inspection.event.environment,
    observedAt: inspection.event.observedAt,
  }
}

function destinationView(destination: PagerDutyDestination): DestinationView {
  return {
    serviceName: destination.serviceName,
    serviceUrl: destination.serviceUrl,
    hasOnCall: destination.hasOnCall,
    priorities: destination.priorities.map(({ severity, priorityName }) => ({
      severity,
      priorityName,
    })),
  }
}

function incidentView(incident: PagerDutyIncident): IncidentView {
  return {
    incidentId: incident.incidentId,
    incidentNumber: incident.incidentNumber,
    status: incident.status,
    priorityName: incident.priorityName,
    htmlUrl: incident.htmlUrl,
  }
}

function source(inspection: SentryInspection): DeclarationResult["source"] {
  return {
    issueId: inspection.issue.issueId,
    shortId: inspection.issue.shortId,
    eventId: inspection.event.eventId,
    htmlUrl: inspection.issue.htmlUrl,
  }
}

export function incidentKey(
  config: WorkerConfig,
  identity: { issueId: string; eventId: string }
): string {
  const sentryUrl = new URL(config.sentryBaseUrl)
  const sentryInstance =
    sentryUrl.hostname === "sentry.io" ||
    sentryUrl.hostname.endsWith(".sentry.io")
      ? "sentry-cloud"
      : sentryUrl.origin
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        version: 2,
        sentryInstance,
        issueId: identity.issueId,
        eventId: identity.eventId.toLowerCase(),
        pagerDutyBaseUrl: config.pagerDutyBaseUrl,
        pagerDutyServiceId: config.pagerDutyServiceId,
      })
    )
    .digest("hex")
  return `notion-sentry-${digest.slice(0, 48)}`
}

async function reconcileIncident(
  dependencies: Dependencies,
  key: string,
  attempts: number,
  deadlineAtMs: number
): Promise<PagerDutyIncident | null> {
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const delays = [0, 500, 1_500]
  const now = dependencies.now ?? Date.now
  let providerDelay = 0
  for (let attempt = 0; attempt < attempts; attempt++) {
    const delay = Math.max(delays[attempt] ?? 0, providerDelay)
    if (now() + delay >= deadlineAtMs) return null
    if (delay > 0) await sleep(delay)
    providerDelay = 0
    try {
      const incident = await dependencies.pagerDuty.findIncident(key, {
        attempts: 1,
        timeoutMs: 3_000,
        deadlineAtMs,
      })
      if (incident) return incident
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error
      if (!error.retryable) return null
      providerDelay = (error.retryAfterSeconds ?? 0) * 1_000
      if (providerDelay > 2_000) return null
      // A later bounded read may still establish the exact incident.
    }
  }
  return null
}

function knownReadFailure(error: unknown): string | null {
  if (error instanceof SentryStateError || error instanceof ProviderError) {
    return error.message
  }
  return null
}

export async function searchSentryIssues(
  query: string | null,
  timeRange: SearchTimeRange | null,
  config: WorkerConfig,
  dependencies: Dependencies
): Promise<SearchResult> {
  try {
    const result = await dependencies.sentry.searchIssues(query, timeRange)
    return {
      status: "completed",
      projectSlug: config.sentryProjectSlug,
      environment: config.sentryEnvironment,
      issues: result.issues,
      hasMore: result.hasMore,
      message:
        result.issues.length === 0
          ? "No matching unresolved Sentry issues were found."
          : result.hasMore
            ? "Showing the first 10 matches; refine the search before choosing an issue."
            : `Found ${result.issues.length} matching unresolved Sentry issue${result.issues.length === 1 ? "" : "s"}.`,
    }
  } catch (error) {
    const message = knownReadFailure(error)
    if (!message) throw error
    return {
      status: "blocked",
      projectSlug: config.sentryProjectSlug,
      environment: config.sentryEnvironment,
      issues: [],
      hasMore: false,
      message,
    }
  }
}

export async function inspectSentryIssue(
  reference: string,
  config: WorkerConfig,
  dependencies: Dependencies
): Promise<InspectionResult> {
  let inspection: SentryInspection | null = null
  let destination: PagerDutyDestination | null = null
  try {
    inspection = await dependencies.sentry.inspectIssue(reference)
    const existing = await dependencies.pagerDuty.findIncident(
      incidentKey(config, {
        issueId: inspection.issue.issueId,
        eventId: inspection.event.eventId,
      })
    )
    if (existing) {
      return {
        status: "already_declared",
        issue: issueView(inspection),
        event: eventView(inspection),
        destination: null,
        existingIncident: incidentView(existing),
        message: `This exact Sentry occurrence already has PagerDuty incident #${existing.incidentNumber}.`,
      }
    }
    destination = await dependencies.pagerDuty.getDestination()
    if (inspection.issue.status !== "unresolved") {
      return {
        status: "ineligible",
        issue: issueView(inspection),
        event: eventView(inspection),
        destination: destinationView(destination),
        existingIncident: null,
        message: "The Sentry issue is no longer unresolved.",
      }
    }
    if (!destination.hasOnCall) {
      return {
        status: "ineligible",
        issue: issueView(inspection),
        event: eventView(inspection),
        destination: destinationView(destination),
        existingIncident: null,
        message:
          "The configured PagerDuty service has no current on-call coverage, so it cannot receive this incident.",
      }
    }
    return {
      status: "ready",
      issue: issueView(inspection),
      event: eventView(inspection),
      destination: destinationView(destination),
      existingIncident: null,
      message:
        "Review the exact Sentry occurrence, PagerDuty service, and priority before declaring the incident.",
    }
  } catch (error) {
    const message = knownReadFailure(error)
    if (!message) throw error
    return {
      status:
        error instanceof SentryStateError && error.kind === "conflict"
          ? "conflict"
          : "blocked",
      issue: inspection ? issueView(inspection) : null,
      event: inspection ? eventView(inspection) : null,
      destination: destination ? destinationView(destination) : null,
      existingIncident: null,
      message,
    }
  }
}

function declarationFailure(
  status: "conflict" | "blocked",
  message: string,
  inspection: SentryInspection | null = null
): DeclarationResult {
  return {
    ok: false,
    status,
    changed: false,
    source: inspection ? source(inspection) : null,
    incident: null,
    requestId: null,
    message,
  }
}

export async function declareProductionIncident(
  input: { issueId: string; eventId: string; severity: Severity },
  config: WorkerConfig,
  dependencies: Dependencies
): Promise<DeclarationResult> {
  if (
    !/^[1-9][0-9]{0,19}$/.test(input.issueId) ||
    !/^[0-9a-f]{32}$/i.test(input.eventId)
  ) {
    return declarationFailure(
      "blocked",
      "Use the exact issue and event IDs returned by inspectSentryIssue."
    )
  }

  const now = dependencies.now ?? Date.now
  const deadlineAtMs = now() + DECLARATION_TIMEOUT_MS
  const writeDeadlineAtMs = deadlineAtMs - RECONCILIATION_RESERVE_MS
  const preflightDeadlineAtMs = writeDeadlineAtMs - config.requestTimeoutMs
  const key = incidentKey(config, input)
  const requestedPriorityId = config.pagerDutyPriorityIds[input.severity]

  let existing: PagerDutyIncident | null
  try {
    existing = await dependencies.pagerDuty.findIncident(key, {
      deadlineAtMs: preflightDeadlineAtMs,
    })
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error
    return declarationFailure("blocked", error.message)
  }
  if (existing) {
    if (existing.priorityId !== requestedPriorityId) {
      return {
        ok: false,
        status: "conflict",
        changed: false,
        source: null,
        incident: incidentView(existing),
        requestId: null,
        message:
          "This exact Sentry occurrence was already declared with a different PagerDuty priority.",
      }
    }
    return {
      ok: true,
      status: "already_declared",
      changed: false,
      source: null,
      incident: incidentView(existing),
      requestId: null,
      message: `PagerDuty incident #${existing.incidentNumber} already represents this exact Sentry occurrence.`,
    }
  }

  if (now() >= preflightDeadlineAtMs) {
    return declarationFailure(
      "blocked",
      "The declaration safety checks did not finish in time. No PagerDuty write was attempted."
    )
  }

  let destination: PagerDutyDestination
  try {
    destination = await dependencies.pagerDuty.getDestination({
      deadlineAtMs: preflightDeadlineAtMs,
    })
  } catch (error) {
    const message = knownReadFailure(error)
    if (!message) throw error
    return declarationFailure("blocked", message)
  }

  if (!destination.hasOnCall) {
    return declarationFailure(
      "blocked",
      "The configured PagerDuty service has no current on-call coverage."
    )
  }
  const priority = destination.priorities.find(
    (candidate) => candidate.severity === input.severity
  )
  if (!priority) {
    return declarationFailure(
      "blocked",
      "The requested severity is not configured in PagerDuty."
    )
  }

  if (now() >= preflightDeadlineAtMs) {
    return declarationFailure(
      "blocked",
      "The declaration safety checks did not finish in time. No PagerDuty write was attempted."
    )
  }

  let inspection: SentryInspection
  try {
    inspection = await dependencies.sentry.verifyEvent(
      input.issueId,
      input.eventId,
      { deadlineAtMs: preflightDeadlineAtMs }
    )
  } catch (error) {
    const message = knownReadFailure(error)
    if (!message) throw error
    return declarationFailure(
      error instanceof SentryStateError && error.kind === "conflict"
        ? "conflict"
        : "blocked",
      message
    )
  }

  if (now() >= preflightDeadlineAtMs) {
    return declarationFailure(
      "blocked",
      "The final Sentry check did not finish in time. No PagerDuty write was attempted.",
      inspection
    )
  }

  const severityLabel = input.severity.replace("sev", "SEV-")
  const title =
    `[${severityLabel}] ${inspection.issue.shortId}: ${inspection.issue.title}`.slice(
      0,
      300
    )
  const details = [
    `Sentry issue: ${inspection.issue.htmlUrl}`,
    `Environment: ${inspection.event.environment}`,
    `Event ID: ${inspection.event.eventId}`,
    `Observed at: ${inspection.event.observedAt}`,
  ].join("\n")

  try {
    const created = await dependencies.pagerDuty.createIncident(
      {
        incidentKey: key,
        priorityId: priority.priorityId,
        title,
        details,
      },
      { deadlineAtMs: writeDeadlineAtMs }
    )
    return {
      ok: true,
      status: "declared",
      changed: true,
      source: source(inspection),
      incident: incidentView(created.incident),
      requestId: created.requestId,
      message: `Declared PagerDuty incident #${created.incident.incidentNumber} as ${priority.priorityName}.`,
    }
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error
    const reconciled = await reconcileIncident(
      dependencies,
      key,
      error.mutationOutcome === "unknown" ? 3 : 1,
      deadlineAtMs
    )
    if (reconciled) {
      if (reconciled.priorityId !== priority.priorityId) {
        return {
          ok: false,
          status: "conflict",
          changed: error.mutationOutcome === "unknown" ? null : false,
          source: source(inspection),
          incident: incidentView(reconciled),
          requestId: error.requestId,
          message:
            "PagerDuty shows the exact incident with a different priority; inspect it before any further action.",
        }
      }
      return {
        ok: true,
        status:
          error.mutationOutcome === "unknown" ? "declared" : "already_declared",
        changed: error.mutationOutcome === "unknown" ? null : false,
        source: source(inspection),
        incident: incidentView(reconciled),
        requestId: error.requestId,
        message:
          error.mutationOutcome === "unknown"
            ? "PagerDuty shows the exact incident, but this call's causal effect is unknown. Do not submit a different declaration."
            : "Another request already created the exact PagerDuty incident.",
      }
    }
    if (error.mutationOutcome === "unknown") {
      return {
        ok: false,
        status: "ambiguous",
        changed: null,
        source: source(inspection),
        incident: null,
        requestId: error.requestId,
        message:
          "PagerDuty may have created the incident, but it is not observable yet. Retry only this identical declaration so it can reconcile the same incident key.",
      }
    }
    return {
      ok: false,
      status: "blocked",
      changed: false,
      source: source(inspection),
      incident: null,
      requestId: error.requestId,
      message: error.message,
    }
  }
}
