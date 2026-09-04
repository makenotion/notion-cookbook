// Typed GitHub REST client for the authenticated user's starred repositories.
// The star media type is required because the default representation omits
// starred_at and returns repository objects without the surrounding envelope.

import { RateLimitError } from "@notionhq/workers"

import type { GetAccessToken, GetExpectedUserId } from "./auth.js"

export const GITHUB_API_BASE_URL = "https://api.github.com"
export const GITHUB_API_VERSION = "2026-03-10"
export const GITHUB_STAR_MEDIA_TYPE = "application/vnd.github.star+json"
export const GITHUB_PAGE_SIZE = 100
export const MAX_STAR_PAGES = 100
export const MAX_GITHUB_RESPONSE_BYTES = 8 * 1024 * 1024
export const GITHUB_REQUEST_TIMEOUT_MS = 30_000

export type BeforeRequest = () => Promise<void>
export type FetchImplementation = typeof fetch

export type GitHubRepositoryLicense = {
  name: string
  spdx_id: string | null
}

export type GitHubRepository = {
  id: number
  name: string
  full_name: string
  owner: {
    login: string
  }
  private: boolean
  html_url: string
  description: string | null
  fork: boolean
  homepage: string | null
  language: string | null
  forks_count: number
  stargazers_count: number
  open_issues_count: number
  default_branch: string
  topics: string[]
  archived: boolean
  disabled: boolean
  visibility: string
  pushed_at: string | null
  created_at: string | null
  license: GitHubRepositoryLicense | null
}

export type GitHubStarredRepository = {
  starred_at: string
  repo: GitHubRepository
}

export type GitHubStarredRepositoriesPage = {
  authenticatedUserId: string
  repositories: GitHubStarredRepository[]
  nextPage: number | undefined
}

export type GitHubStarsClient = {
  fetchPage(page: number): Promise<GitHubStarredRepositoriesPage>
}

export type GitHubStarsClientOptions = {
  beforeRequest: BeforeRequest
  getAccessToken: GetAccessToken
  getExpectedUserId: GetExpectedUserId
  fetchImplementation?: FetchImplementation
  requestTimeoutMs?: number
}

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requiredString(
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean } = {}
): string {
  if (typeof value !== "string" || (!options.allowEmpty && !value.trim())) {
    throw new Error(`GitHub response is missing ${label}.`)
  }
  return value
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null
  if (typeof value !== "string") {
    throw new Error(`GitHub response has an invalid ${label}.`)
  }
  return value
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`GitHub response has an invalid ${label}.`)
  }
  return value
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`GitHub response has an invalid ${label}.`)
  }
  return value as number
}

function positiveInteger(value: unknown, label: string): number {
  const number = nonNegativeInteger(value, label)
  if (number < 1) throw new Error(`GitHub response has an invalid ${label}.`)
  return number
}

function isoTimestamp(value: unknown, label: string): string {
  const timestamp = requiredString(value, label)
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`GitHub response has an invalid ${label}.`)
  }
  return timestamp
}

function nullableTimestamp(value: unknown, label: string): string | null {
  if (value === null) return null
  return isoTimestamp(value, label)
}

function httpUrl(value: unknown, label: string): string {
  const raw = requiredString(value, label)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`GitHub response has an invalid ${label}.`)
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`GitHub response has an invalid ${label}.`)
  }
  return raw
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`GitHub response has an invalid ${label}.`)
  }
  return value as string[]
}

function parseLicense(value: unknown): GitHubRepositoryLicense | null {
  if (value === null) return null
  if (!isObject(value)) {
    throw new Error("GitHub response has an invalid repository license.")
  }
  return {
    name: requiredString(value.name, "repository license name"),
    spdx_id:
      value.spdx_id === null
        ? null
        : requiredString(value.spdx_id, "repository license SPDX ID"),
  }
}

function parseRepository(value: unknown): GitHubRepository {
  if (!isObject(value)) {
    throw new Error("GitHub star response is missing its repository object.")
  }
  if (!isObject(value.owner)) {
    throw new Error("GitHub response is missing repository owner.")
  }

  const isPrivate = requiredBoolean(value.private, "repository private flag")
  return {
    id: positiveInteger(value.id, "repository ID"),
    name: requiredString(value.name, "repository name"),
    full_name: requiredString(value.full_name, "repository full name"),
    owner: {
      login: requiredString(value.owner.login, "repository owner login"),
    },
    private: isPrivate,
    html_url: httpUrl(value.html_url, "repository URL"),
    description: nullableString(value.description, "repository description"),
    fork: requiredBoolean(value.fork, "repository fork flag"),
    homepage: nullableString(value.homepage, "repository homepage"),
    language: nullableString(value.language, "repository language"),
    forks_count: nonNegativeInteger(value.forks_count, "repository fork count"),
    stargazers_count: nonNegativeInteger(
      value.stargazers_count,
      "repository star count"
    ),
    open_issues_count: nonNegativeInteger(
      value.open_issues_count,
      "repository open issue count"
    ),
    default_branch: requiredString(
      value.default_branch,
      "repository default branch"
    ),
    topics:
      value.topics === undefined
        ? []
        : stringArray(value.topics, "repository topics"),
    archived: requiredBoolean(value.archived, "repository archived flag"),
    disabled: requiredBoolean(value.disabled, "repository disabled flag"),
    visibility:
      typeof value.visibility === "string" && value.visibility.trim()
        ? value.visibility
        : isPrivate
          ? "private"
          : "public",
    pushed_at: nullableTimestamp(value.pushed_at, "repository pushed_at"),
    created_at: nullableTimestamp(value.created_at, "repository created_at"),
    license: parseLicense(value.license),
  }
}

export function parseStarredRepositories(
  value: unknown
): GitHubStarredRepository[] {
  if (!Array.isArray(value)) {
    throw new Error("GitHub starred repositories response is not an array.")
  }

  const repositoryIds = new Set<number>()
  return value.map((item, index) => {
    if (!isObject(item) || !("starred_at" in item) || !("repo" in item)) {
      throw new Error(
        `GitHub star response item ${index + 1} is missing the star media-type envelope.`
      )
    }
    const repository = parseRepository(item.repo)
    if (repositoryIds.has(repository.id)) {
      throw new Error(
        `GitHub starred repositories page contains duplicate repository ID ${repository.id}.`
      )
    }
    repositoryIds.add(repository.id)

    return {
      starred_at: isoTimestamp(item.starred_at, "starred_at"),
      repo: repository,
    }
  })
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value?.trim()) return undefined

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)

  const retryAt = Date.parse(value)
  if (Number.isNaN(retryAt)) return undefined
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000))
}

function retryAfterSeconds(response: Response): number {
  const retryAfter = parseRetryAfter(response.headers.get("Retry-After"))
  if (retryAfter !== undefined) return retryAfter

  if (response.headers.get("X-RateLimit-Remaining") === "0") {
    const resetHeader = response.headers.get("X-RateLimit-Reset")
    if (resetHeader?.trim()) {
      const resetAt = Number(resetHeader)
      if (Number.isFinite(resetAt) && resetAt >= 0) {
        return Math.max(0, Math.ceil(resetAt - Date.now() / 1_000))
      }
    }
  }

  // GitHub recommends waiting at least one minute for a secondary limit that
  // does not include Retry-After.
  return 60
}

function isRateLimitResponse(response: Response, body: string): boolean {
  if (response.status === 429) return true
  if (response.status !== 403) return false

  return (
    response.headers.has("Retry-After") ||
    response.headers.get("X-RateLimit-Remaining") === "0" ||
    /(?:secondary |api )?rate limit|abuse detection/i.test(body)
  )
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get("Content-Length")
  if (/^\d+$/.test(contentLength ?? "")) {
    const declaredBytes = Number(contentLength)
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes > MAX_GITHUB_RESPONSE_BYTES
    ) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(
        `GitHub API response exceeds the ${MAX_GITHUB_RESPONSE_BYTES}-byte safety limit.`
      )
    }
  }

  if (!response.body) return ""

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let bytesRead = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      bytesRead += value.byteLength
      if (bytesRead > MAX_GITHUB_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error(
          `GitHub API response exceeds the ${MAX_GITHUB_RESPONSE_BYTES}-byte safety limit.`
        )
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join("")
  } finally {
    reader.releaseLock()
  }
}

function sanitizeProviderText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500)
}

function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown
    if (isObject(parsed) && typeof parsed.message === "string") {
      return sanitizeProviderText(parsed.message) || "No response message"
    }
  } catch {
    // A status code is still actionable when GitHub sends a non-JSON body.
  }
  return body.trim() ? "Unexpected response body" : "No response body"
}

function parseAuthenticatedUserId(value: unknown): string {
  if (!isObject(value)) {
    throw new Error("GitHub authenticated-user response is not an object.")
  }
  return String(positiveInteger(value.id, "authenticated user ID"))
}

function requestTimeoutMilliseconds(options: GitHubStarsClientOptions): number {
  const value = options.requestTimeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("GitHub request timeout must be a positive integer.")
  }
  return value
}

function requestTimeoutError(timeoutMs: number): Error {
  return new Error(
    `GitHub API request timed out after ${timeoutMs} milliseconds.`
  )
}

async function fetchGitHubJson(
  url: URL,
  accessToken: string,
  accept: string,
  options: GitHubStarsClientOptions
): Promise<{ response: Response; parsed: unknown }> {
  const timeoutMs = requestTimeoutMilliseconds(options)
  await options.beforeRequest()

  const fetchImplementation = options.fetchImplementation ?? fetch
  const signal = AbortSignal.timeout(timeoutMs)
  let response: Response
  try {
    response = await fetchImplementation(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: accept,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": "notion-cookbook-github-stars-sync",
      },
      redirect: "error",
      signal,
    })
  } catch (error) {
    if (signal.aborted) {
      throw requestTimeoutError(timeoutMs)
    }
    throw error
  }

  if (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.has("Retry-After") ||
        response.headers.get("X-RateLimit-Remaining") === "0"))
  ) {
    throw new RateLimitError({ retryAfter: retryAfterSeconds(response) })
  }

  let body: string
  try {
    body = await readBoundedResponseText(response)
  } catch (error) {
    if (signal.aborted) throw requestTimeoutError(timeoutMs)
    throw error
  }
  if (isRateLimitResponse(response, body)) {
    throw new RateLimitError({ retryAfter: retryAfterSeconds(response) })
  }
  if (!response.ok) {
    throw new Error(
      `GitHub API error (${response.status}): ${errorMessage(body)}`
    )
  }

  try {
    return { response, parsed: JSON.parse(body) as unknown }
  } catch {
    throw new Error("GitHub API response is not valid JSON.")
  }
}

export function nextPageFromLink(
  link: string | null,
  currentPage: number
): number | undefined {
  if (!link) return undefined

  let nextPage: number | undefined

  for (const rawEntry of link.split(",")) {
    const entry = /^\s*<([^>]+)>\s*;\s*rel="([^"]+)"\s*$/.exec(rawEntry)
    if (!entry) {
      throw new Error("GitHub pagination response has an invalid Link header.")
    }
    if (!entry[2].split(/\s+/).includes("next")) continue

    let url: URL
    try {
      url = new URL(entry[1], GITHUB_API_BASE_URL)
    } catch {
      throw new Error("GitHub pagination response has an invalid next link.")
    }
    if (
      url.origin !== GITHUB_API_BASE_URL ||
      url.pathname !== "/user/starred"
    ) {
      throw new Error("GitHub pagination response has an invalid next link.")
    }

    const page = Number(url.searchParams.get("page"))
    if (
      !Number.isSafeInteger(page) ||
      page !== currentPage + 1 ||
      page > MAX_STAR_PAGES
    ) {
      throw new Error("GitHub pagination response has an invalid next page.")
    }
    if (nextPage !== undefined && nextPage !== page) {
      throw new Error("GitHub pagination response has multiple next pages.")
    }
    nextPage = page
  }

  return nextPage
}

async function fetchStarredRepositoriesPage(
  page: number,
  options: GitHubStarsClientOptions
): Promise<GitHubStarredRepositoriesPage> {
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_STAR_PAGES) {
    throw new Error(
      `GitHub stars page must be between 1 and ${MAX_STAR_PAGES}.`
    )
  }

  const expectedUserId = options.getExpectedUserId().trim()
  if (
    !/^[1-9]\d{0,15}$/.test(expectedUserId) ||
    !Number.isSafeInteger(Number(expectedUserId))
  ) {
    throw new Error("GITHUB_USER_ID must be a positive numeric GitHub user ID.")
  }
  const accessToken = (await options.getAccessToken()).trim()
  if (!accessToken) throw new Error("GitHub access token is empty.")

  // Use one token for both requests so the identity check applies to the
  // exact credential that reads this page of stars.
  const userUrl = new URL("/user", GITHUB_API_BASE_URL)
  const userResult = await fetchGitHubJson(
    userUrl,
    accessToken,
    "application/vnd.github+json",
    options
  )
  const authenticatedUserId = parseAuthenticatedUserId(userResult.parsed)
  if (authenticatedUserId !== expectedUserId) {
    throw new Error(
      "The GitHub credential does not belong to GITHUB_USER_ID; no stars were read."
    )
  }

  const starsUrl = new URL("/user/starred", GITHUB_API_BASE_URL)
  starsUrl.searchParams.set("sort", "created")
  starsUrl.searchParams.set("direction", "asc")
  starsUrl.searchParams.set("per_page", String(GITHUB_PAGE_SIZE))
  starsUrl.searchParams.set("page", String(page))
  const starsResult = await fetchGitHubJson(
    starsUrl,
    accessToken,
    GITHUB_STAR_MEDIA_TYPE,
    options
  )

  return {
    authenticatedUserId,
    repositories: parseStarredRepositories(starsResult.parsed),
    nextPage: nextPageFromLink(starsResult.response.headers.get("Link"), page),
  }
}

export function createGitHubStarsClient(
  options: GitHubStarsClientOptions
): GitHubStarsClient {
  return {
    fetchPage: (page) => fetchStarredRepositoriesPage(page, options),
  }
}
