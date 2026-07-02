// Minimal Sentry REST client for organization issue groups. It intentionally
// never requests event payloads, stack traces, breadcrumbs, tags, or user PII.

import { createHash } from "node:crypto"

import { RateLimitError } from "@notionhq/workers"

import type { SentryStats } from "./helpers.js"

const DEFAULT_BASE_URL = "https://sentry.io"
const PAGE_SIZE = 100
const REQUEST_TIMEOUT_MS = 30_000
const ERROR_EXCERPT_CHARACTERS = 500

export type BeforeRequest = () => Promise<void>

export type SentryIssue = {
  id: string
  shortId: string | null
  title: string
  culprit: string | null
  permalink: string | null
  status: string | null
  substatus: string | null
  priority: string | null
  level: string | null
  isUnhandled: boolean | null
  assignedTo: { name: string | null } | null
  project: {
    id: string | null
    name: string | null
    slug: string | null
    platform: string | null
  } | null
  platform: string | null
  issueCategory: string | null
  issueType: string | null
  count: string | number | null
  userCount: string | number | null
  lifetime: {
    count: string | number | null
    userCount: string | number | null
  } | null
  firstSeen: string | null
  lastSeen: string | null
  stats: SentryStats | null
}

export type FetchIssuesOptions = {
  start: string
  end: string
  cursor?: string
}

export type SentryIssueScope = {
  baseUrl: string
  organization: string
  projects: string[]
  environments: string[]
  credentialFingerprint: string
}

export type SentryPage = {
  resources: SentryIssue[]
  hasMore: boolean
  nextCursor: string | undefined
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is not set.`)
  return value
}

function commaSeparatedEnv(name: string): string[] {
  const values = process.env[name]?.split(",") ?? []
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function organizationSlug(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(
      "SENTRY_ORG_SLUG must contain only letters, numbers, hyphens, or underscores."
    )
  }
  return value
}

function sentryBaseUrl(
  raw = process.env.SENTRY_BASE_URL?.trim() || DEFAULT_BASE_URL
): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("SENTRY_BASE_URL must be a valid absolute URL.")
  }

  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])
  const isLoopbackHttp =
    url.protocol === "http:" && loopbackHosts.has(url.hostname.toLowerCase())
  if (url.protocol !== "https:" && !isLoopbackHttp) {
    throw new Error(
      "SENTRY_BASE_URL must use HTTPS (HTTP is allowed only for a loopback development server)."
    )
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "SENTRY_BASE_URL cannot contain credentials, query parameters, or a fragment."
    )
  }
  if (url.pathname.replace(/\/+$/, "").endsWith("/api/0")) {
    throw new Error("SENTRY_BASE_URL must be the server root, without /api/0.")
  }

  url.pathname = url.pathname.replace(/\/+$/, "")
  return url
}

export function getIssueScope(): SentryIssueScope {
  const token = requireEnv("SENTRY_AUTH_TOKEN")
  return {
    baseUrl: sentryBaseUrl().toString(),
    organization: organizationSlug(requireEnv("SENTRY_ORG_SLUG")),
    projects: commaSeparatedEnv("SENTRY_PROJECTS"),
    environments: commaSeparatedEnv("SENTRY_ENVIRONMENTS"),
    credentialFingerprint: tokenFingerprint(token),
  }
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

function validateScopeValues(values: unknown, name: string): string[] {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== "string" || !value.trim())
  ) {
    throw new Error(`Sentry issue sync state has invalid ${name}`)
  }
  return values.map((value) => value.trim())
}

export function buildIssuesUrl(
  options: FetchIssuesOptions,
  scope = getIssueScope()
): URL {
  const organization = organizationSlug(scope.organization)
  const projects = validateScopeValues(scope.projects, "project filters")
  const environments = validateScopeValues(
    scope.environments,
    "environment filters"
  )
  const base = sentryBaseUrl(scope.baseUrl)
  const prefix = base.pathname.replace(/\/+$/, "")
  base.pathname = `${prefix}/api/0/organizations/${encodeURIComponent(
    organization
  )}/issues/`

  // Sentry defaults this endpoint to unresolved issues. An explicit empty
  // query is required for the rolling database to include resolved/ignored
  // issues as well as active ones.
  base.searchParams.set("query", "")
  base.searchParams.set("start", options.start)
  base.searchParams.set("end", options.end)
  base.searchParams.set("sort", "new")
  base.searchParams.set("groupStatsPeriod", "24h")
  base.searchParams.set("limit", String(PAGE_SIZE))

  for (const project of projects) {
    base.searchParams.append("project", project)
  }
  for (const environment of environments) {
    base.searchParams.append("environment", environment)
  }
  if (options.cursor) base.searchParams.set("cursor", options.cursor)

  return base
}

export function parseRetryAfterSeconds(
  value: string | null,
  now = Date.now()
): number | undefined {
  if (!value?.trim()) return undefined

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)

  const retryAt = Date.parse(value)
  if (!Number.isFinite(retryAt)) return undefined
  return Math.max(0, Math.ceil((retryAt - now) / 1_000))
}

/** Calculate the longest usable delay from Sentry's rate-limit headers. */
export function rateLimitRetryAfterSeconds(
  headers: Headers,
  now = Date.now()
): number | undefined {
  const delays: number[] = []
  const retryAfter = parseRetryAfterSeconds(headers.get("retry-after"), now)
  if (retryAfter !== undefined) delays.push(retryAfter)

  const remainingHeader = headers.get("x-sentry-rate-limit-remaining")
  const resetHeader = headers.get("x-sentry-rate-limit-reset")
  const remaining = remainingHeader === null ? NaN : Number(remainingHeader)
  const reset = resetHeader === null ? NaN : Number(resetHeader)
  if (Number.isFinite(remaining) && remaining <= 0 && Number.isFinite(reset)) {
    const resetMs = reset > 10_000_000_000 ? reset : reset * 1_000
    delays.push(Math.max(0, Math.ceil((resetMs - now) / 1_000)))
  }

  return delays.length > 0 ? Math.max(...delays) : undefined
}

function splitLinkHeader(header: string): string[] {
  const entries: string[] = []
  let start = 0
  let inAngle = false
  let inQuote = false
  let escaped = false

  for (let index = 0; index < header.length; index += 1) {
    const character = header[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (inQuote && character === "\\") {
      escaped = true
      continue
    }
    if (character === '"' && !inAngle) inQuote = !inQuote
    if (!inQuote && character === "<") inAngle = true
    if (!inQuote && character === ">") inAngle = false
    if (character === "," && !inAngle && !inQuote) {
      entries.push(header.slice(start, index).trim())
      start = index + 1
    }
  }
  entries.push(header.slice(start).trim())
  return entries.filter(Boolean)
}

function linkAttributes(value: string): Map<string, string> {
  const attributes = new Map<string, string>()
  const pattern = /;\s*([^\s=;]+)\s*=\s*(?:"((?:\\.|[^"])*)"|([^\s;,]+))/g
  for (const match of value.matchAll(pattern)) {
    attributes.set(
      match[1].toLowerCase(),
      (match[2] ?? match[3] ?? "").replace(/\\"/g, '"')
    )
  }
  return attributes
}

/** Parse Sentry's RFC-style Link header; page length is never authoritative. */
export function nextCursorFromLink(
  linkHeader: string | null,
  expectedRequestUrl: URL
): string | undefined {
  if (!linkHeader?.trim()) {
    throw new Error("Sentry issue pagination is missing its Link header")
  }

  const nextEntries = splitLinkHeader(linkHeader).filter((entry) => {
    const attributes = linkAttributes(entry)
    return (attributes.get("rel") ?? "").split(/\s+/).includes("next")
  })
  if (nextEntries.length !== 1) {
    throw new Error("Sentry issue pagination must contain one next Link entry")
  }

  const entry = nextEntries[0]
  const attributes = linkAttributes(entry)
  const results = attributes.get("results")
  if (results !== "true" && results !== "false") {
    throw new Error("Sentry issue pagination has an invalid results flag")
  }
  if (results === "false") return undefined

  const targetMatch = entry.match(/^\s*<([^>]+)>/)
  if (!targetMatch) {
    throw new Error("Sentry issue pagination has an invalid next URL")
  }

  let target: URL
  try {
    target = new URL(targetMatch[1], expectedRequestUrl)
  } catch {
    throw new Error("Sentry issue pagination has an invalid next URL")
  }
  if (
    target.origin !== expectedRequestUrl.origin ||
    target.pathname !== expectedRequestUrl.pathname
  ) {
    throw new Error("Sentry issue pagination returned an untrusted next URL")
  }

  const cursors = target.searchParams.getAll("cursor")
  const cursor = cursors.length === 1 ? cursors[0].trim() : ""
  if (!cursor) {
    throw new Error("Sentry issue pagination is missing its next cursor")
  }
  return cursor
}

function nullableString(
  record: Record<string, unknown>,
  key: string,
  index: number
): string | null {
  const value = record[key]
  if (value === null || value === undefined) return null
  if (typeof value !== "string") {
    throw new Error(`Sentry issue ${index} has an invalid ${key}`)
  }
  return value
}

function nullableCount(
  record: Record<string, unknown>,
  key: string,
  index: number
): string | number | null {
  const value = record[key]
  if (value === null || value === undefined) return null
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`Sentry issue ${index} has an invalid ${key}`)
  }
  return value
}

function nullableBoolean(
  record: Record<string, unknown>,
  key: string,
  index: number
): boolean | null {
  const value = record[key]
  if (value === null || value === undefined) return null
  if (typeof value !== "boolean") {
    throw new Error(`Sentry issue ${index} has an invalid ${key}`)
  }
  return value
}

function nullableRecord(
  record: Record<string, unknown>,
  key: string,
  index: number
): Record<string, unknown> | null {
  const value = record[key]
  if (value === null || value === undefined) return null
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Sentry issue ${index} has an invalid ${key}`)
  }
  return value as Record<string, unknown>
}

function selectedStats(
  record: Record<string, unknown>,
  index: number
): SentryStats | null {
  const stats = nullableRecord(record, "stats", index)
  if (!stats || stats["24h"] === null || stats["24h"] === undefined) {
    return null
  }
  if (!Array.isArray(stats["24h"])) {
    throw new Error(`Sentry issue ${index} has invalid 24h stats`)
  }

  const points: Array<[number, number]> = stats["24h"].map(
    (point, pointIndex) => {
      if (!Array.isArray(point) || point.length < 2) {
        throw new Error(
          `Sentry issue ${index} has an invalid 24h stats point ${pointIndex}`
        )
      }
      const timestamp = Number(point[0])
      const count = Number(point[1])
      if (!Number.isFinite(timestamp) || !Number.isFinite(count) || count < 0) {
        throw new Error(
          `Sentry issue ${index} has an invalid 24h stats point ${pointIndex}`
        )
      }
      return [timestamp, count]
    }
  )
  return { "24h": points }
}

function parseIssue(value: unknown, index: number): SentryIssue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Sentry issue ${index} is not an object`)
  }
  const record = value as Record<string, unknown>
  const id = nullableString(record, "id", index)?.trim()
  const title = nullableString(record, "title", index)
  if (!id) throw new Error(`Sentry issue ${index} is missing its immutable id`)
  if (title === null)
    throw new Error(`Sentry issue ${index} is missing its title`)

  const assignedTo = nullableRecord(record, "assignedTo", index)
  const project = nullableRecord(record, "project", index)
  const lifetime = nullableRecord(record, "lifetime", index)

  return {
    id,
    title,
    shortId: nullableString(record, "shortId", index),
    culprit: nullableString(record, "culprit", index),
    permalink: nullableString(record, "permalink", index),
    status: nullableString(record, "status", index),
    substatus: nullableString(record, "substatus", index),
    priority: nullableString(record, "priority", index),
    level: nullableString(record, "level", index),
    isUnhandled: nullableBoolean(record, "isUnhandled", index),
    assignedTo: assignedTo
      ? { name: nullableString(assignedTo, "name", index) }
      : null,
    project: project
      ? {
          id: nullableString(project, "id", index),
          name: nullableString(project, "name", index),
          slug: nullableString(project, "slug", index),
          platform: nullableString(project, "platform", index),
        }
      : null,
    platform:
      nullableString(record, "platform", index) ??
      (project ? nullableString(project, "platform", index) : null),
    issueCategory: nullableString(record, "issueCategory", index),
    issueType: nullableString(record, "issueType", index),
    count: nullableCount(record, "count", index),
    userCount: nullableCount(record, "userCount", index),
    lifetime: lifetime
      ? {
          count: nullableCount(lifetime, "count", index),
          userCount: nullableCount(lifetime, "userCount", index),
        }
      : null,
    firstSeen: nullableString(record, "firstSeen", index),
    lastSeen: nullableString(record, "lastSeen", index),
    stats: selectedStats(record, index),
  }
}

function errorExcerpt(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim()
  return Array.from(compact).slice(0, ERROR_EXCERPT_CHARACTERS).join("")
}

export async function fetchIssuesPage(
  beforeRequest: BeforeRequest,
  options: FetchIssuesOptions,
  scope = getIssueScope()
): Promise<SentryPage> {
  const token = requireEnv("SENTRY_AUTH_TOKEN")
  if (tokenFingerprint(token) !== scope.credentialFingerprint) {
    throw new Error(
      "SENTRY_AUTH_TOKEN changed during Sentry issue pagination; restart the full refresh with one credential."
    )
  }
  const url = buildIssuesUrl(options, scope)

  await beforeRequest()
  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "notion-cookbook-sentry-sync",
      },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("Sentry API request timed out after 30 seconds")
    }
    throw new Error(
      `Sentry API request failed: ${
        error instanceof Error ? error.message : "unknown network error"
      }`
    )
  }

  const text = await response.text()
  if (response.status === 429) {
    throw new RateLimitError({
      retryAfter: rateLimitRetryAfterSeconds(response.headers),
    })
  }
  if (!response.ok) {
    const detail = errorExcerpt(text)
    throw new Error(
      `Sentry API error (${response.status})${detail ? `: ${detail}` : ""}`
    )
  }

  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(
      `Sentry API returned invalid JSON (${response.status}): ${errorExcerpt(
        text
      )}`
    )
  }
  if (!Array.isArray(body)) {
    throw new Error("Sentry issue response must be a JSON array")
  }

  const nextCursor = nextCursorFromLink(response.headers.get("link"), url)
  return {
    resources: body.map(parseIssue),
    hasMore: nextCursor !== undefined,
    nextCursor,
  }
}
