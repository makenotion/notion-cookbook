import type { JSONValue } from "@notionhq/workers/types"
import type { Severity, WorkerConfig } from "./config.js"
import {
  getJson,
  postJsonOnce,
  ProviderError,
  type FetchLike,
} from "./api-requests.js"

export interface PagerDutyPriority extends Record<string, JSONValue> {
  severity: Severity
  priorityId: string
  priorityName: string
}

export interface PagerDutyDestination extends Record<string, JSONValue> {
  serviceId: string
  serviceName: string
  serviceUrl: string | null
  hasOnCall: boolean
  priorities: PagerDutyPriority[]
}

export interface PagerDutyIncident extends Record<string, JSONValue> {
  incidentId: string
  incidentNumber: number
  status: "triggered" | "acknowledged" | "resolved"
  incidentKey: string
  serviceId: string
  priorityId: string | null
  priorityName: string | null
  htmlUrl: string
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError(
      "PagerDuty",
      "PagerDuty returned a malformed response."
    )
  }
  return value as Record<string, unknown>
}

function string(value: unknown, maximum = 200): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ProviderError(
      "PagerDuty",
      "PagerDuty returned a malformed response."
    )
  }
  return value
}

function pagerDutyUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const raw = string(value, 2_000)
  try {
    const url = new URL(raw)
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !(
        url.hostname === "pagerduty.com" ||
        url.hostname.endsWith(".pagerduty.com")
      )
    ) {
      throw new Error("invalid")
    }
    return url.toString()
  } catch {
    throw new ProviderError("PagerDuty", "PagerDuty returned an unsafe URL.")
  }
}

function parseIncident(
  value: unknown,
  expectedServiceId: string,
  expectedIncidentKey: string
): PagerDutyIncident {
  const incident = object(value)
  const service = object(incident.service)
  const priority =
    incident.priority === null || incident.priority === undefined
      ? null
      : object(incident.priority)
  const status = string(incident.status, 30)
  if (
    status !== "triggered" &&
    status !== "acknowledged" &&
    status !== "resolved"
  ) {
    throw new ProviderError(
      "PagerDuty",
      "PagerDuty returned an invalid incident status."
    )
  }
  const serviceId = string(service.id, 100)
  const incidentKey = string(incident.incident_key, 255)
  if (serviceId !== expectedServiceId || incidentKey !== expectedIncidentKey) {
    throw new ProviderError(
      "PagerDuty",
      "PagerDuty returned an incident outside the configured identity."
    )
  }
  if (
    !Number.isSafeInteger(incident.incident_number) ||
    Number(incident.incident_number) < 1
  ) {
    throw new ProviderError(
      "PagerDuty",
      "PagerDuty returned an invalid incident number."
    )
  }
  const htmlUrl = pagerDutyUrl(incident.html_url)
  if (!htmlUrl) {
    throw new ProviderError("PagerDuty", "PagerDuty omitted the incident URL.")
  }
  return {
    incidentId: string(incident.id, 100),
    incidentNumber: Number(incident.incident_number),
    status,
    incidentKey,
    serviceId,
    priorityId: priority ? string(priority.id, 100) : null,
    priorityName: priority
      ? string(priority.summary ?? priority.name, 200)
      : null,
    htmlUrl,
  }
}

export class PagerDutyClient {
  private readonly fetch: FetchLike
  private readonly now: () => Date

  constructor(
    private readonly config: WorkerConfig,
    options: { fetch?: FetchLike; now?: () => Date } = {}
  ) {
    this.fetch = options.fetch ?? fetch
    this.now = options.now ?? (() => new Date())
  }

  private headers(includeFrom = false): HeadersInit {
    return {
      Accept: "application/vnd.pagerduty+json;version=2",
      Authorization: `Token token=${this.config.pagerDutyToken}`,
      "Content-Type": "application/json",
      ...(includeFrom ? { From: this.config.pagerDutyFromEmail } : {}),
    }
  }

  private async get(
    url: URL,
    options: {
      attempts?: number
      timeoutMs?: number
      deadlineAtMs?: number
    } = {}
  ): Promise<unknown> {
    return (
      await getJson({
        provider: "PagerDuty",
        url,
        headers: this.headers(),
        fetch: this.fetch,
        timeoutMs: options.timeoutMs ?? this.config.requestTimeoutMs,
        attempts: options.attempts,
        deadlineAtMs: options.deadlineAtMs,
        now: this.now,
      })
    ).data
  }

  async getDestination(
    options: { deadlineAtMs?: number } = {}
  ): Promise<PagerDutyDestination> {
    const serviceUrl = new URL(
      `/services/${encodeURIComponent(this.config.pagerDutyServiceId)}`,
      this.config.pagerDutyBaseUrl
    )
    const serviceResponse = object(await this.get(serviceUrl, options))
    const service = object(serviceResponse.service)
    const escalationPolicy = object(service.escalation_policy)
    const serviceId = string(service.id, 100)
    const serviceName = string(service.name, 200)
    const serviceStatus = string(service.status, 50)
    if (serviceId !== this.config.pagerDutyServiceId) {
      throw new ProviderError(
        "PagerDuty",
        "PagerDuty returned a different service than the one configured."
      )
    }
    if (!new Set(["active", "warning", "critical"]).has(serviceStatus)) {
      throw new ProviderError(
        "PagerDuty",
        "The configured PagerDuty service is not currently available for incidents."
      )
    }

    const prioritiesUrl = new URL("/priorities", this.config.pagerDutyBaseUrl)
    prioritiesUrl.searchParams.set("limit", "100")
    prioritiesUrl.searchParams.set("offset", "0")
    const priorityResponse = object(await this.get(prioritiesUrl, options))
    if (
      !Array.isArray(priorityResponse.priorities) ||
      priorityResponse.priorities.length > 100 ||
      priorityResponse.more !== false
    ) {
      throw new ProviderError(
        "PagerDuty",
        "PagerDuty returned an incomplete priority list."
      )
    }
    const prioritiesById = new Map<string, string>()
    for (const value of priorityResponse.priorities) {
      const priority = object(value)
      prioritiesById.set(
        string(priority.id, 100),
        string(priority.name ?? priority.summary, 200)
      )
    }
    const priorities = (["sev1", "sev2", "sev3"] as const).map((severity) => {
      const priorityId = this.config.pagerDutyPriorityIds[severity]
      const priorityName = prioritiesById.get(priorityId)
      if (!priorityName) {
        throw new ProviderError(
          "PagerDuty",
          `The configured ${severity.toUpperCase()} priority is unavailable.`
        )
      }
      return { severity, priorityId, priorityName }
    })

    const observedAt = this.now().toISOString()
    const onCallsUrl = new URL("/oncalls", this.config.pagerDutyBaseUrl)
    onCallsUrl.searchParams.set("limit", "1")
    onCallsUrl.searchParams.set("since", observedAt)
    onCallsUrl.searchParams.set("until", observedAt)
    onCallsUrl.searchParams.append(
      "escalation_policy_ids[]",
      string(escalationPolicy.id, 100)
    )
    const onCallsResponse = object(await this.get(onCallsUrl, options))
    if (
      !Array.isArray(onCallsResponse.oncalls) ||
      onCallsResponse.oncalls.length > 1
    ) {
      throw new ProviderError(
        "PagerDuty",
        "PagerDuty returned malformed on-call data."
      )
    }
    if (onCallsResponse.oncalls.length === 1) {
      const onCall = object(onCallsResponse.oncalls[0])
      const returnedPolicy = object(onCall.escalation_policy)
      if (returnedPolicy.id !== escalationPolicy.id) {
        throw new ProviderError(
          "PagerDuty",
          "PagerDuty returned on-call coverage for a different escalation policy."
        )
      }
    }

    return {
      serviceId,
      serviceName,
      serviceUrl: pagerDutyUrl(service.html_url),
      hasOnCall: onCallsResponse.oncalls.length === 1,
      priorities,
    }
  }

  async findIncident(
    incidentKey: string,
    options: {
      attempts?: number
      timeoutMs?: number
      deadlineAtMs?: number
    } = {}
  ): Promise<PagerDutyIncident | null> {
    const url = new URL("/incidents", this.config.pagerDutyBaseUrl)
    url.searchParams.set("date_range", "all")
    url.searchParams.set("incident_key", incidentKey)
    url.searchParams.append("service_ids[]", this.config.pagerDutyServiceId)
    url.searchParams.append("statuses[]", "triggered")
    url.searchParams.append("statuses[]", "acknowledged")
    url.searchParams.append("statuses[]", "resolved")
    url.searchParams.append("include[]", "priorities")
    url.searchParams.append("include[]", "services")
    url.searchParams.set("limit", "2")
    const response = object(await this.get(url, options))
    if (
      !Array.isArray(response.incidents) ||
      response.incidents.length > 1 ||
      response.more !== false
    ) {
      throw new ProviderError(
        "PagerDuty",
        "PagerDuty returned more than one incident for the exact declaration."
      )
    }
    return response.incidents.length === 0
      ? null
      : parseIncident(
          response.incidents[0],
          this.config.pagerDutyServiceId,
          incidentKey
        )
  }

  async createIncident(
    input: {
      incidentKey: string
      priorityId: string
      title: string
      details: string
    },
    options: { deadlineAtMs?: number } = {}
  ): Promise<{
    incident: PagerDutyIncident
    requestId: string | null
  }> {
    const url = new URL("/incidents", this.config.pagerDutyBaseUrl)
    const response = await postJsonOnce({
      provider: "PagerDuty",
      url,
      headers: this.headers(true),
      body: {
        incident: {
          type: "incident",
          title: input.title,
          service: {
            id: this.config.pagerDutyServiceId,
            type: "service_reference",
          },
          priority: { id: input.priorityId, type: "priority_reference" },
          incident_key: input.incidentKey,
          body: { type: "incident_body", details: input.details },
        },
      },
      fetch: this.fetch,
      timeoutMs: this.config.requestTimeoutMs,
      now: this.now,
      deadlineAtMs: options.deadlineAtMs,
    })
    try {
      const envelope = object(response.data)
      const incident = parseIncident(
        envelope.incident,
        this.config.pagerDutyServiceId,
        input.incidentKey
      )
      if (incident.priorityId !== input.priorityId) {
        throw new Error("priority mismatch")
      }
      return { incident, requestId: response.requestId }
    } catch {
      throw new ProviderError(
        "PagerDuty",
        "PagerDuty accepted the incident without a trustworthy exact response.",
        { requestId: response.requestId, mutationOutcome: "unknown" }
      )
    }
  }
}
