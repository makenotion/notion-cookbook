import type { JSONValue } from "@notionhq/workers/types"
import type { WorkerConfig } from "./config.js"
import { getJson, ProviderError, type FetchLike } from "./api-requests.js"

const RESULT_LIMIT = 10
export type SearchTimeRange = "1h" | "6h" | "24h" | "7d" | "14d"

export interface SentryIssueCandidate extends Record<string, JSONValue> {
  shortId: string
  title: string
  substatus: string | null
  lastSeen: string
  eventCount: number
  htmlUrl: string
}

export interface SentryIssueSnapshot extends Record<string, JSONValue> {
  issueId: string
  shortId: string
  title: string
  projectId: string
  projectSlug: string
  status: string
  substatus: string | null
  htmlUrl: string
}

export interface SentryEventSnapshot extends Record<string, JSONValue> {
  eventId: string
  issueId: string
  projectId: string
  environment: string
  title: string
  observedAt: string
}

export interface SentryInspection extends Record<string, JSONValue> {
  issue: SentryIssueSnapshot
  event: SentryEventSnapshot
}

export class SentryStateError extends Error {
  readonly kind: "blocked" | "conflict"

  constructor(message: string, kind: "blocked" | "conflict" = "blocked") {
    super(message)
    this.name = "SentryStateError"
    this.kind = kind
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError("Sentry", "Sentry returned a malformed response.")
  }
  return value as Record<string, unknown>
}

function string(
  value: unknown,
  maximum: number,
  message = "Sentry returned a malformed response."
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ProviderError("Sentry", message)
  }
  return value
}

function nullableString(value: unknown, maximum: number): string | null {
  if (value === null || value === undefined) return null
  return string(value, maximum)
}

function date(value: unknown): string {
  const raw = string(value, 40)
  const timestamp = Date.parse(raw)
  if (Number.isNaN(timestamp)) {
    throw new ProviderError("Sentry", "Sentry returned an invalid timestamp.")
  }
  return new Date(timestamp).toISOString()
}

function eventCount(value: unknown): number {
  const raw = typeof value === "number" ? value : Number(value)
  if (!Number.isSafeInteger(raw) || raw < 0) {
    throw new ProviderError("Sentry", "Sentry returned an invalid event count.")
  }
  return raw
}

function validateSentryUrl(value: unknown, baseUrl: string): string {
  const raw = string(value, 2_000, "Sentry returned an invalid issue URL.")
  try {
    const url = new URL(raw)
    const base = new URL(baseUrl)
    const cloudBase =
      base.hostname === "sentry.io" || base.hostname.endsWith(".sentry.io")
    const cloudUrl =
      url.hostname === "sentry.io" || url.hostname.endsWith(".sentry.io")
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (!(cloudBase && cloudUrl) && url.origin !== base.origin)
    ) {
      throw new Error("invalid")
    }
    return url.toString()
  } catch {
    throw new ProviderError("Sentry", "Sentry returned an unsafe issue URL.")
  }
}

function parseIssue(value: unknown, config: WorkerConfig): SentryIssueSnapshot {
  const issue = object(value)
  const project = object(issue.project)
  const snapshot: SentryIssueSnapshot = {
    issueId: string(issue.id, 20),
    shortId: string(issue.shortId, 100),
    title: string(issue.title, 300),
    projectId: string(project.id, 20),
    projectSlug: string(project.slug, 100),
    status: string(issue.status, 50),
    substatus: nullableString(issue.substatus, 100),
    htmlUrl: validateSentryUrl(issue.permalink, config.sentryBaseUrl),
  }
  if (snapshot.projectSlug !== config.sentryProjectSlug) {
    throw new SentryStateError(
      "The Sentry issue belongs to a different project.",
      "conflict"
    )
  }
  return snapshot
}

function parseEvent(
  value: unknown,
  issue: SentryIssueSnapshot,
  config: WorkerConfig
): SentryEventSnapshot {
  const event = object(value)
  const eventId = string(event.eventID ?? event.id, 64).toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(eventId)) {
    throw new ProviderError("Sentry", "Sentry returned an invalid event ID.")
  }
  const issueId = string(event.groupID, 20)
  const projectId = string(event.projectID, 20)
  const tags = event.tags
  if (!Array.isArray(tags) || tags.length > 200) {
    throw new ProviderError("Sentry", "Sentry returned malformed event tags.")
  }
  const environments = tags
    .map((tag) => object(tag))
    .filter((tag) => tag.key === "environment")
    .map((tag) => tag.value)
  if (
    issueId !== issue.issueId ||
    projectId !== issue.projectId ||
    environments.length !== 1 ||
    environments[0] !== config.sentryEnvironment
  ) {
    throw new SentryStateError(
      "The Sentry event no longer matches the configured issue, project, and environment.",
      "conflict"
    )
  }
  return {
    eventId,
    issueId,
    projectId,
    environment: config.sentryEnvironment,
    title: string(event.title ?? issue.title, 300),
    observedAt: date(event.dateCreated),
  }
}

export class SentryClient {
  private readonly fetch: FetchLike

  constructor(
    private readonly config: WorkerConfig,
    fetchImpl: FetchLike = fetch
  ) {
    this.fetch = fetchImpl
  }

  private headers(): HeadersInit {
    return {
      Accept: "application/json",
      Authorization: `Bearer ${this.config.sentryToken}`,
    }
  }

  private async get(
    url: URL,
    options: { deadlineAtMs?: number } = {}
  ): Promise<unknown> {
    return (
      await getJson({
        provider: "Sentry",
        url,
        headers: this.headers(),
        fetch: this.fetch,
        timeoutMs: this.config.requestTimeoutMs,
        deadlineAtMs: options.deadlineAtMs,
      })
    ).data
  }

  async searchIssues(
    query: string | null,
    timeRange: SearchTimeRange | null
  ): Promise<{ issues: SentryIssueCandidate[]; hasMore: boolean }> {
    const normalized = query?.trim() ?? ""
    if (normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) {
      throw new SentryStateError("The Sentry search query is invalid.")
    }
    const url = new URL(
      `/api/0/organizations/${encodeURIComponent(this.config.sentryOrgSlug)}/issues/`,
      this.config.sentryBaseUrl
    )
    url.searchParams.append("project", this.config.sentryProjectSlug)
    url.searchParams.append("environment", this.config.sentryEnvironment)
    url.searchParams.set(
      "query",
      normalized ? `is:unresolved ${normalized}` : "is:unresolved"
    )
    url.searchParams.set("sort", "date")
    url.searchParams.set("limit", String(RESULT_LIMIT + 1))
    url.searchParams.set("statsPeriod", timeRange ?? "24h")
    url.searchParams.set("shortIdLookup", "0")
    url.searchParams.append("collapse", "stats")

    const raw = await this.get(url)
    if (!Array.isArray(raw) || raw.length > RESULT_LIMIT + 1) {
      throw new ProviderError("Sentry", "Sentry returned too many issues.")
    }
    const parsed = raw.map((value) => {
      const issue = object(value)
      const project = object(issue.project)
      if (string(project.slug, 100) !== this.config.sentryProjectSlug) {
        throw new SentryStateError(
          "Sentry returned an issue outside the configured project.",
          "conflict"
        )
      }
      if (string(issue.status, 50) !== "unresolved") {
        throw new SentryStateError(
          "Sentry returned an issue outside the unresolved search scope.",
          "conflict"
        )
      }
      return {
        shortId: string(issue.shortId, 100),
        title: string(issue.title, 300),
        substatus: nullableString(issue.substatus, 100),
        lastSeen: date(issue.lastSeen),
        eventCount: eventCount(issue.count),
        htmlUrl: validateSentryUrl(issue.permalink, this.config.sentryBaseUrl),
      }
    })
    return {
      issues: parsed.slice(0, RESULT_LIMIT),
      hasMore: parsed.length > RESULT_LIMIT,
    }
  }

  private issueIdFromUrl(reference: string): string | null {
    try {
      const url = new URL(reference)
      validateSentryUrl(url.toString(), this.config.sentryBaseUrl)
      const segments = url.pathname.split("/").filter(Boolean)
      const issueIndex = segments.indexOf("issues")
      const candidate = issueIndex >= 0 ? segments[issueIndex + 1] : undefined
      return candidate && /^[1-9][0-9]{0,19}$/.test(candidate)
        ? candidate
        : null
    } catch {
      return null
    }
  }

  private async resolveIssueReference(reference: string): Promise<string> {
    const normalized = reference.trim()
    if (
      normalized.length < 1 ||
      normalized.length > 2_000 ||
      /[\u0000-\u001f\u007f]/.test(normalized)
    ) {
      throw new SentryStateError("The Sentry issue reference is invalid.")
    }
    if (/^[1-9][0-9]{0,19}$/.test(normalized)) return normalized
    const fromUrl = this.issueIdFromUrl(normalized)
    if (fromUrl) return fromUrl
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(normalized)) {
      throw new SentryStateError(
        "Use a Sentry short ID, issue URL, or numeric ID returned by search."
      )
    }
    const url = new URL(
      `/api/0/organizations/${encodeURIComponent(this.config.sentryOrgSlug)}/shortids/${encodeURIComponent(normalized)}/`,
      this.config.sentryBaseUrl
    )
    const resolved = object(await this.get(url))
    const group = object(resolved.group)
    if (
      string(resolved.organizationSlug, 100) !== this.config.sentryOrgSlug ||
      string(resolved.projectSlug, 100) !== this.config.sentryProjectSlug ||
      string(resolved.shortId, 100).toLowerCase() !== normalized.toLowerCase()
    ) {
      throw new SentryStateError(
        "The Sentry short ID resolved outside the configured project.",
        "conflict"
      )
    }
    return string(group.id, 20)
  }

  private async readIssue(
    issueId: string,
    options: { deadlineAtMs?: number } = {}
  ): Promise<SentryIssueSnapshot> {
    if (!/^[1-9][0-9]{0,19}$/.test(issueId)) {
      throw new SentryStateError("The Sentry issue ID is invalid.")
    }
    const url = new URL(
      `/api/0/organizations/${encodeURIComponent(this.config.sentryOrgSlug)}/issues/${encodeURIComponent(issueId)}/`,
      this.config.sentryBaseUrl
    )
    url.searchParams.append("environment", this.config.sentryEnvironment)
    url.searchParams.append("collapse", "stats")
    url.searchParams.append("collapse", "tags")
    const issue = parseIssue(await this.get(url, options), this.config)
    if (issue.issueId !== issueId) {
      throw new SentryStateError(
        "The Sentry issue identity changed.",
        "conflict"
      )
    }
    return issue
  }

  private async readEvent(
    issue: SentryIssueSnapshot,
    eventId: string,
    options: { deadlineAtMs?: number } = {}
  ): Promise<SentryEventSnapshot> {
    if (eventId !== "latest" && !/^[0-9a-f]{32}$/i.test(eventId)) {
      throw new SentryStateError("The Sentry event ID is invalid.")
    }
    const url = new URL(
      `/api/0/organizations/${encodeURIComponent(this.config.sentryOrgSlug)}/issues/${encodeURIComponent(issue.issueId)}/events/${encodeURIComponent(eventId)}/`,
      this.config.sentryBaseUrl
    )
    url.searchParams.append("environment", this.config.sentryEnvironment)
    let raw: unknown
    try {
      raw = await this.get(url, options)
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) {
        throw new SentryStateError(
          "The Sentry issue has no matching event in the configured environment.",
          "conflict"
        )
      }
      throw error
    }
    const event = parseEvent(raw, issue, this.config)
    if (
      eventId !== "latest" &&
      event.eventId.toLowerCase() !== eventId.toLowerCase()
    ) {
      throw new SentryStateError(
        "The Sentry event identity changed.",
        "conflict"
      )
    }
    return event
  }

  async inspectIssue(reference: string): Promise<SentryInspection> {
    const issueId = await this.resolveIssueReference(reference)
    const issue = await this.readIssue(issueId)
    const event = await this.readEvent(issue, "latest")
    return { issue, event }
  }

  async verifyEvent(
    issueId: string,
    eventId: string,
    options: { deadlineAtMs?: number } = {}
  ): Promise<SentryInspection> {
    const initialIssue = await this.readIssue(issueId, options)
    if (initialIssue.status !== "unresolved") {
      throw new SentryStateError(
        "The Sentry issue is no longer unresolved.",
        "conflict"
      )
    }
    const event = await this.readEvent(initialIssue, eventId, options)
    const issue = await this.readIssue(issueId, options)
    if (
      issue.status !== "unresolved" ||
      issue.projectId !== event.projectId ||
      issue.issueId !== event.issueId
    ) {
      throw new SentryStateError(
        "The Sentry issue is no longer unresolved or its identity changed.",
        "conflict"
      )
    }
    return { issue, event }
  }
}
