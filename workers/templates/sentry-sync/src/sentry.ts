// Sentry REST client for issue groups, projects, recent releases, and aggregate
// session health. It does not request raw events; parsers select only the fields
// used by the Notion databases and do not persist unselected personal data.

import { RateLimitError } from "@notionhq/workers"

import type { SentryStats } from "./helpers.js"

const DEFAULT_BASE_URL = "https://sentry.io"
const PAGE_SIZE = 100
const RECENT_RELEASE_LIMIT = 100
// 250 groups × four fields × (seven daily buckets + totals) stays below
// Sentry's documented 10,000-data-point ceiling even if series are computed
// before includeSeries=0 is applied.
const RELEASE_HEALTH_GROUP_LIMIT = 250
const REQUEST_TIMEOUT_MS = 30_000
const ERROR_EXCERPT_CHARACTERS = 500

// API contracts

export type BeforeRequest = () => Promise<void>

export class SentryApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = "SentryApiError"
  }
}

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
  statsPeriod?: "24h" | "14d"
}

export type SentryScope = {
  baseUrl: string
  organization: string
  projects: string[]
  environments: string[]
}

export type SentryIssuePage = {
  resources: SentryIssue[]
  hasMore: boolean
  nextCursor: string | undefined
}

export type SentryProject = {
  id: string
  name: string
  slug: string
  platform: string | null
  platforms: string[]
  teams: Array<{ id: string; name: string; slug: string }>
  dateCreated: string | null
  firstEvent: string | null
  hasSessions: boolean | null
}

export type SentryProjectPage = {
  resources: SentryProject[]
  hasMore: boolean
  nextCursor: string | undefined
}

export type SentryReleaseProject = {
  id: string | null
  name: string
  slug: string
  newGroups: number | null
  platform: string | null
  platforms: string[]
  hasHealthData: boolean | null
}

export type SentryRelease = {
  id: string
  version: string
  shortVersion: string | null
  status: string | null
  ref: string | null
  url: string | null
  dateReleased: string | null
  dateCreated: string | null
  newGroups: number | null
  commitCount: number | null
  deployCount: number | null
  firstEvent: string | null
  lastEvent: string | null
  projects: SentryReleaseProject[]
}

export type SentryReleaseHealth = {
  release: string
  sessions: number | null
  users: number | null
  crashFreeSessions: number | null
  crashFreeUsers: number | null
}

export type SentryReleaseHealthSnapshot = {
  start: string
  end: string
  groups: SentryReleaseHealth[]
}

// Configuration and request construction

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

export function getSentryScope(): SentryScope {
  requireEnv("SENTRY_AUTH_TOKEN")
  return {
    baseUrl: sentryBaseUrl().toString(),
    organization: organizationSlug(requireEnv("SENTRY_ORG_SLUG")),
    projects: commaSeparatedEnv("SENTRY_PROJECTS"),
    environments: commaSeparatedEnv("SENTRY_ENVIRONMENTS"),
  }
}

function validateScopeValues(values: unknown, name: string): string[] {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== "string" || !value.trim())
  ) {
    throw new Error(`Sentry sync state has invalid ${name}`)
  }
  return values.map((value) => value.trim())
}

export function buildIssuesUrl(
  options: FetchIssuesOptions,
  scope = getSentryScope()
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
  base.searchParams.set("groupStatsPeriod", options.statsPeriod ?? "24h")
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

function organizationResourceUrl(
  scope: SentryScope,
  resource: "projects" | "releases" | "sessions"
): URL {
  const organization = organizationSlug(scope.organization)
  const base = sentryBaseUrl(scope.baseUrl)
  const prefix = base.pathname.replace(/\/+$/, "")
  base.pathname = `${prefix}/api/0/organizations/${encodeURIComponent(
    organization
  )}/${resource}/`
  return base
}

export function buildProjectsUrl(
  cursor: string | undefined,
  scope = getSentryScope()
): URL {
  const url = organizationResourceUrl(scope, "projects")
  url.searchParams.set("per_page", String(PAGE_SIZE))
  if (cursor) url.searchParams.set("cursor", cursor)
  return url
}

/** The newest 100 releases are a deliberate product boundary, not truncation. */
export function buildReleasesUrl(scope = getSentryScope()): URL {
  const url = organizationResourceUrl(scope, "releases")
  url.searchParams.set("per_page", String(RECENT_RELEASE_LIMIT))
  for (const project of validateScopeValues(
    scope.projects,
    "project filters"
  )) {
    url.searchParams.append("project", project)
  }
  for (const environment of validateScopeValues(
    scope.environments,
    "environment filters"
  )) {
    url.searchParams.append("environment", environment)
  }
  return url
}

export function buildReleaseHealthUrl(
  start: string,
  end: string,
  scope = getSentryScope()
): URL {
  const url = organizationResourceUrl(scope, "sessions")
  url.searchParams.set("start", start)
  url.searchParams.set("end", end)
  url.searchParams.set("interval", "1d")
  for (const field of [
    "sum(session)",
    "count_unique(user)",
    "crash_free_rate(session)",
    "crash_free_rate(user)",
  ]) {
    url.searchParams.append("field", field)
  }
  url.searchParams.append("groupBy", "release")
  url.searchParams.set("orderBy", "-sum(session)")
  url.searchParams.set("includeTotals", "1")
  url.searchParams.set("includeSeries", "0")
  url.searchParams.set("per_page", String(RELEASE_HEALTH_GROUP_LIMIT))
  for (const project of validateScopeValues(
    scope.projects,
    "project filters"
  )) {
    url.searchParams.append("project", project)
  }
  for (const environment of validateScopeValues(
    scope.environments,
    "environment filters"
  )) {
    url.searchParams.append("environment", environment)
  }
  return url
}

// Rate limits and pagination

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
  expectedRequestUrl: URL,
  resource = "issue"
): string | undefined {
  if (!linkHeader?.trim()) {
    throw new Error(`Sentry ${resource} pagination is missing its Link header`)
  }

  const nextEntries = splitLinkHeader(linkHeader).filter((entry) => {
    const attributes = linkAttributes(entry)
    return (attributes.get("rel") ?? "").split(/\s+/).includes("next")
  })
  if (nextEntries.length !== 1) {
    throw new Error(
      `Sentry ${resource} pagination must contain one next Link entry`
    )
  }

  const entry = nextEntries[0]
  const attributes = linkAttributes(entry)
  const results = attributes.get("results")
  if (results !== "true" && results !== "false") {
    throw new Error(`Sentry ${resource} pagination has an invalid results flag`)
  }
  if (results === "false") return undefined

  const targetMatch = entry.match(/^\s*<([^>]+)>/)
  if (!targetMatch) {
    throw new Error(`Sentry ${resource} pagination has an invalid next URL`)
  }

  let target: URL
  try {
    target = new URL(targetMatch[1], expectedRequestUrl)
  } catch {
    throw new Error(`Sentry ${resource} pagination has an invalid next URL`)
  }
  if (
    target.origin !== expectedRequestUrl.origin ||
    target.pathname !== expectedRequestUrl.pathname
  ) {
    throw new Error(
      `Sentry ${resource} pagination returned an untrusted next URL`
    )
  }

  const cursors = target.searchParams.getAll("cursor")
  const cursor = cursors.length === 1 ? cursors[0].trim() : ""
  if (!cursor) {
    throw new Error(`Sentry ${resource} pagination is missing its next cursor`)
  }
  return cursor
}

// Issue response parsing

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
  index: number,
  period: "24h" | "14d"
): SentryStats | null {
  const stats = nullableRecord(record, "stats", index)
  if (!stats || stats[period] === null || stats[period] === undefined) {
    return null
  }
  if (!Array.isArray(stats[period])) {
    throw new Error(`Sentry issue ${index} has invalid ${period} stats`)
  }

  const points: Array<[number, number]> = stats[period].map(
    (point, pointIndex) => {
      if (!Array.isArray(point) || point.length < 2) {
        throw new Error(
          `Sentry issue ${index} has an invalid ${period} stats point ${pointIndex}`
        )
      }
      const timestamp = Number(point[0])
      const count = Number(point[1])
      if (!Number.isFinite(timestamp) || !Number.isFinite(count) || count < 0) {
        throw new Error(
          `Sentry issue ${index} has an invalid ${period} stats point ${pointIndex}`
        )
      }
      return [timestamp, count]
    }
  )
  return { [period]: points }
}

function parseIssue(
  value: unknown,
  index: number,
  statsPeriod: "24h" | "14d"
): SentryIssue {
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
    stats: selectedStats(record, index, statsPeriod),
  }
}

// Authenticated transport

function errorExcerpt(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim()
  return Array.from(compact).slice(0, ERROR_EXCERPT_CHARACTERS).join("")
}

async function fetchSentryJson(
  beforeRequest: BeforeRequest,
  url: URL,
  scope: SentryScope,
  activity: string
): Promise<{ body: unknown; headers: Headers }> {
  const token = requireEnv("SENTRY_AUTH_TOKEN")

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
      throw new Error(`Sentry ${activity} timed out after 30 seconds`)
    }
    throw new Error(
      `Sentry ${activity} request failed: ${
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
    throw new SentryApiError(
      response.status,
      `Sentry API error (${response.status}) during ${activity}${
        detail ? `: ${detail}` : ""
      }`
    )
  }

  try {
    return { body: JSON.parse(text), headers: response.headers }
  } catch {
    throw new Error(
      `Sentry ${activity} returned invalid JSON (${response.status}): ${errorExcerpt(text)}`
    )
  }
}

// Project and release response parsing

function resourceRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function resourceString(
  record: Record<string, unknown>,
  key: string,
  label: string,
  required = false
): string | null {
  const value = record[key]
  if (value === null || value === undefined) {
    if (required) throw new Error(`${label} is missing ${key}`)
    return null
  }
  if (typeof value !== "string") {
    throw new Error(`${label} has an invalid ${key}`)
  }
  if (required && !value.trim()) throw new Error(`${label} is missing ${key}`)
  return value
}

function resourceId(
  record: Record<string, unknown>,
  key: string,
  label: string
): string {
  const value = record[key]
  const text =
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
      ? String(value).trim()
      : ""
  if (!text) throw new Error(`${label} is missing its immutable ${key}`)
  return text
}

function optionalResourceId(
  record: Record<string, unknown>,
  key: string,
  label: string
): string | null {
  const value = record[key]
  if (value === null || value === undefined) return null
  const text =
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
      ? String(value).trim()
      : ""
  if (!text) throw new Error(`${label} has an invalid ${key}`)
  return text
}

function resourceNumber(
  record: Record<string, unknown>,
  key: string,
  label: string
): number | null {
  const value = record[key]
  if (value === null || value === undefined) return null
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} has an invalid ${key}`)
  }
  return value
}

function resourceBoolean(
  record: Record<string, unknown>,
  key: string,
  label: string
): boolean | null {
  const value = record[key]
  if (value === null || value === undefined) return null
  if (typeof value !== "boolean") {
    throw new Error(`${label} has an invalid ${key}`)
  }
  return value
}

function resourceArray(
  record: Record<string, unknown>,
  key: string,
  label: string
): unknown[] {
  const value = record[key]
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} has an invalid ${key}`)
  return value
}

function requiredResourceArray(
  record: Record<string, unknown>,
  key: string,
  label: string
): unknown[] {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    throw new Error(`${label} is missing ${key}`)
  }
  const value = record[key]
  if (!Array.isArray(value)) throw new Error(`${label} has an invalid ${key}`)
  return value
}

function resourceStrings(
  record: Record<string, unknown>,
  key: string,
  label: string
): string[] {
  return resourceArray(record, key, label).map((value, index) => {
    if (typeof value !== "string") {
      throw new Error(`${label} has an invalid ${key} value ${index}`)
    }
    return value
  })
}

function parseProject(value: unknown, index: number): SentryProject {
  const label = `Sentry project ${index}`
  const record = resourceRecord(value, label)
  const teams = resourceArray(record, "teams", label).map((team, teamIndex) => {
    const teamLabel = `${label} team ${teamIndex}`
    const teamRecord = resourceRecord(team, teamLabel)
    return {
      id: resourceId(teamRecord, "id", teamLabel),
      name: resourceString(teamRecord, "name", teamLabel, true) as string,
      slug: resourceString(teamRecord, "slug", teamLabel, true) as string,
    }
  })

  return {
    id: resourceId(record, "id", label),
    name: resourceString(record, "name", label, true) as string,
    slug: resourceString(record, "slug", label, true) as string,
    platform: resourceString(record, "platform", label),
    platforms: resourceStrings(record, "platforms", label),
    teams,
    dateCreated: resourceString(record, "dateCreated", label),
    firstEvent: resourceString(record, "firstEvent", label),
    hasSessions: resourceBoolean(record, "hasSessions", label),
  }
}

function parseReleaseProject(
  value: unknown,
  releaseIndex: number,
  projectIndex: number
): SentryReleaseProject {
  const label = `Sentry release ${releaseIndex} project ${projectIndex}`
  const record = resourceRecord(value, label)
  return {
    id: optionalResourceId(record, "id", label),
    name: resourceString(record, "name", label, true) as string,
    slug: resourceString(record, "slug", label, true) as string,
    newGroups: resourceNumber(record, "newGroups", label),
    platform: resourceString(record, "platform", label),
    platforms: resourceStrings(record, "platforms", label),
    hasHealthData: resourceBoolean(record, "hasHealthData", label),
  }
}

function parseRelease(value: unknown, index: number): SentryRelease {
  const label = `Sentry release ${index}`
  const record = resourceRecord(value, label)
  const projects = requiredResourceArray(record, "projects", label).map(
    (project, projectIndex) => parseReleaseProject(project, index, projectIndex)
  )
  if (
    new Set(projects.map((project) => project.slug)).size !== projects.length
  ) {
    throw new Error(`${label} contains duplicate project slugs`)
  }
  return {
    id: resourceId(record, "id", label),
    version: resourceString(record, "version", label, true) as string,
    shortVersion: resourceString(record, "shortVersion", label),
    status: resourceString(record, "status", label),
    ref: resourceString(record, "ref", label),
    url: resourceString(record, "url", label),
    dateReleased: resourceString(record, "dateReleased", label),
    dateCreated: resourceString(record, "dateCreated", label),
    newGroups: resourceNumber(record, "newGroups", label),
    commitCount: resourceNumber(record, "commitCount", label),
    deployCount: resourceNumber(record, "deployCount", label),
    firstEvent: resourceString(record, "firstEvent", label),
    lastEvent: resourceString(record, "lastEvent", label),
    projects,
  }
}

function releaseHealthNumber(
  totals: Record<string, unknown>,
  key: string,
  label: string
): number | null {
  const value = totals[key]
  if (value === null || value === undefined) return null
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} has an invalid ${key}`)
  }
  return value
}

function parseReleaseHealthGroup(
  value: unknown,
  index: number
): SentryReleaseHealth {
  const label = `Sentry release health group ${index}`
  const record = resourceRecord(value, label)
  const by = resourceRecord(record.by, `${label} by`)
  const totals = resourceRecord(record.totals, `${label} totals`)
  const release = resourceString(by, "release", label, true) as string
  return {
    release,
    sessions: releaseHealthNumber(totals, "sum(session)", label),
    users: releaseHealthNumber(totals, "count_unique(user)", label),
    crashFreeSessions: releaseHealthNumber(
      totals,
      "crash_free_rate(session)",
      label
    ),
    crashFreeUsers: releaseHealthNumber(totals, "crash_free_rate(user)", label),
  }
}

// Resource fetchers

export async function fetchIssuesPage(
  beforeRequest: BeforeRequest,
  options: FetchIssuesOptions,
  scope = getSentryScope()
): Promise<SentryIssuePage> {
  const url = buildIssuesUrl(options, scope)
  const { body, headers } = await fetchSentryJson(
    beforeRequest,
    url,
    scope,
    "issue pagination"
  )
  if (!Array.isArray(body)) {
    throw new Error("Sentry issue response must be a JSON array")
  }

  const nextCursor = nextCursorFromLink(headers.get("link"), url)
  const statsPeriod = options.statsPeriod ?? "24h"
  return {
    resources: body.map((issue, index) =>
      parseIssue(issue, index, statsPeriod)
    ),
    hasMore: nextCursor !== undefined,
    nextCursor,
  }
}

export async function fetchProjectsPage(
  beforeRequest: BeforeRequest,
  cursor: string | undefined,
  scope = getSentryScope()
): Promise<SentryProjectPage> {
  const url = buildProjectsUrl(cursor, scope)
  const { body, headers } = await fetchSentryJson(
    beforeRequest,
    url,
    scope,
    "project pagination"
  )
  if (!Array.isArray(body)) {
    throw new Error("Sentry project response must be a JSON array")
  }
  const nextCursor = nextCursorFromLink(headers.get("link"), url, "project")
  return {
    resources: body.map(parseProject),
    hasMore: nextCursor !== undefined,
    nextCursor,
  }
}

export async function fetchRecentReleases(
  beforeRequest: BeforeRequest,
  scope = getSentryScope()
): Promise<SentryRelease[]> {
  const url = buildReleasesUrl(scope)
  const { body } = await fetchSentryJson(
    beforeRequest,
    url,
    scope,
    "recent release loading"
  )
  if (!Array.isArray(body)) {
    throw new Error("Sentry release response must be a JSON array")
  }
  if (body.length > RECENT_RELEASE_LIMIT) {
    throw new Error(
      `Sentry returned more than the requested ${RECENT_RELEASE_LIMIT} recent releases`
    )
  }
  const releases = body.map(parseRelease)
  if (new Set(releases.map((release) => release.id)).size !== releases.length) {
    throw new Error("Sentry release response contains duplicate release IDs")
  }
  return releases
}

export async function fetchReleaseHealth(
  beforeRequest: BeforeRequest,
  start: string,
  end: string,
  scope = getSentryScope()
): Promise<SentryReleaseHealthSnapshot> {
  const url = buildReleaseHealthUrl(start, end, scope)
  const { body, headers } = await fetchSentryJson(
    beforeRequest,
    url,
    scope,
    "release health loading"
  )
  const record = resourceRecord(body, "Sentry release health response")
  const groups = requiredResourceArray(
    record,
    "groups",
    "Sentry release health response"
  )
  if (groups.length >= RELEASE_HEALTH_GROUP_LIMIT) {
    throw new Error(
      `Sentry release health reached the ${RELEASE_HEALTH_GROUP_LIMIT}-group safety limit; narrow SENTRY_PROJECTS or SENTRY_ENVIRONMENTS to avoid an incomplete refresh.`
    )
  }
  const link = headers.get("link")
  if (link) {
    const nextCursor = nextCursorFromLink(link, url, "release health")
    if (nextCursor) {
      throw new Error(
        "Sentry release health returned another page; narrow SENTRY_PROJECTS or SENTRY_ENVIRONMENTS so the aggregate refresh is complete."
      )
    }
  }
  const responseStart = resourceString(
    record,
    "start",
    "Sentry release health response",
    true
  ) as string
  const responseEnd = resourceString(
    record,
    "end",
    "Sentry release health response",
    true
  ) as string
  if (
    !Number.isFinite(Date.parse(responseStart)) ||
    !Number.isFinite(Date.parse(responseEnd)) ||
    Date.parse(responseStart) >= Date.parse(responseEnd)
  ) {
    throw new Error("Sentry release health response has an invalid time window")
  }
  return {
    start: responseStart,
    end: responseEnd,
    groups: groups.map(parseReleaseHealthGroup),
  }
}
