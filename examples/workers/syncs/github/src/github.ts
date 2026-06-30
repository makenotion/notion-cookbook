// GitHub REST API client. Handles authenticated requests and pagination
// for issues, pull requests, reviews, check runs, and commit statuses.
//
// To add a new resource (e.g. releases, actions runs):
//   1. Add a type for the API response shape
//   2. Add a fetchXxxPage() function using fetchPage()
//   3. Wire it into index.ts

import { RateLimitError } from "@notionhq/workers"

import type { GetAccessToken } from "./auth.js"

const API_BASE_URL = "https://api.github.com"
const API_VERSION = "2026-03-10"
const PER_PAGE = 100

export type BeforeRequest = () => Promise<void>

export type GitHubClientOptions = {
  beforeRequest: BeforeRequest
  getAccessToken: GetAccessToken
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is not set.`)
  }
  return value
}

function isOwnerRepo(value: string): boolean {
  const [owner, repo, extra] = value.split("/")
  return (
    extra === undefined &&
    repo !== undefined &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner) &&
    repo !== "." &&
    repo !== ".." &&
    /^[A-Za-z0-9._-]+$/.test(repo)
  )
}

export function getRepos(): string[] {
  const raw = requireEnv("GITHUB_REPOS")
  const repos: string[] = []
  const seen = new Set<string>()

  for (const value of raw.split(",")) {
    const repo = value.trim()
    if (!repo) continue
    if (!isOwnerRepo(repo)) {
      throw new Error(
        `Invalid GITHUB_REPOS entry "${repo}". Expected owner/repo.`
      )
    }

    const key = repo.toLowerCase()
    if (!seen.has(key)) {
      repos.push(repo)
      seen.add(key)
    }
  }

  if (repos.length === 0) {
    throw new Error("GITHUB_REPOS must contain at least one owner/repo.")
  }

  return repos
}

export function createGitHubClient(options: GitHubClientOptions) {
  return {
    fetchIssuesPage: (repo: string, page: number | undefined) =>
      fetchIssuesPage(repo, page, options),
    fetchPullRequestsPage: (
      repo: string,
      page: number | undefined,
      state: string | undefined
    ) => fetchPullRequestsPage(repo, page, state, options),
    fetchReviews: (repo: string, prNumber: number) =>
      fetchReviews(repo, prNumber, options),
    fetchCheckRuns: (repo: string, sha: string) =>
      fetchCheckRuns(repo, sha, options),
    fetchCombinedStatus: (repo: string, sha: string) =>
      fetchCombinedStatus(repo, sha, options),
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value?.trim()) return undefined

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds)
  }

  const retryAt = Date.parse(value)
  if (Number.isNaN(retryAt)) return undefined
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000))
}

function retryAfterSeconds(response: Response): number {
  const retryAfter = parseRetryAfter(response.headers.get("Retry-After"))
  if (retryAfter !== undefined) return retryAfter

  if (response.headers.get("X-RateLimit-Remaining") === "0") {
    const resetHeader = response.headers.get("X-RateLimit-Reset")
    if (resetHeader !== null) {
      const resetAt = Number(resetHeader)
      if (Number.isFinite(resetAt) && resetAt >= 0) {
        return Math.max(0, Math.ceil(resetAt - Date.now() / 1_000))
      }
    }
  }

  // GitHub recommends waiting at least one minute before retrying a secondary
  // rate limit response that does not include Retry-After.
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

type JsonResponse<T> = {
  data: T
  headers: Headers
}

async function fetchJson<T>(
  url: URL,
  repo: string,
  options: GitHubClientOptions
): Promise<JsonResponse<T>> {
  await options.beforeRequest()
  const accessToken = await options.getAccessToken(repo)

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "notion-cookbook-github-sync",
    },
  })

  const text = await response.text()
  if (isRateLimitResponse(response, text)) {
    throw new RateLimitError({ retryAfter: retryAfterSeconds(response) })
  }
  if (!response.ok) {
    throw new Error(
      `GitHub API error (${response.status}): ${text || "No response body"}`
    )
  }

  return {
    data: JSON.parse(text) as T,
    headers: response.headers,
  }
}

function nextPageFromLink(link: string | null): number | undefined {
  if (!link) return undefined

  const entryPattern = /<([^>]+)>\s*;\s*rel="([^"]+)"/g
  for (const match of link.matchAll(entryPattern)) {
    if (!match[2].split(/\s+/).includes("next")) continue

    const page = Number(
      new URL(match[1], API_BASE_URL).searchParams.get("page")
    )
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new Error("GitHub pagination response has an invalid next page")
    }
    return page
  }

  return undefined
}

// Generic paginated fetch for GitHub endpoints whose response is a JSON array.
// GitHub's Link header is authoritative; a full final page has no next link.
async function fetchPage<T>(
  repo: string,
  path: string,
  params: Record<string, string> | undefined,
  page: number | undefined,
  options: GitHubClientOptions
): Promise<{ items: T[]; nextPage: number | undefined }> {
  const url = new URL(path, API_BASE_URL)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }
  }
  url.searchParams.set("per_page", String(PER_PAGE))
  url.searchParams.set("page", String(page ?? 1))

  const { data, headers } = await fetchJson<T[]>(url, repo, options)
  return {
    items: data,
    nextPage: nextPageFromLink(headers.get("Link")),
  }
}

// ---------------------------------------------------------------------------
// Issues
// https://docs.github.com/en/rest/issues/issues#list-repository-issues
// ---------------------------------------------------------------------------

export type GitHubIssue = {
  number: number
  title: string
  body: string | null
  state: string
  state_reason: string | null
  user: { login: string } | null
  assignees: { login: string }[]
  labels: { name: string }[]
  milestone: { title: string } | null
  comments: number
  reactions: { total_count: number }
  html_url: string
  pull_request?: unknown
  created_at: string
  updated_at: string
  closed_at: string | null
}

// The /issues endpoint returns both issues and PRs. We filter out PRs here.
async function fetchIssuesPage(
  repo: string,
  page: number | undefined,
  options: GitHubClientOptions
): Promise<{ issues: GitHubIssue[]; nextPage: number | undefined }> {
  const { items, nextPage } = await fetchPage<GitHubIssue>(
    repo,
    `/repos/${repo}/issues`,
    { state: "all", sort: "created", direction: "asc" },
    page,
    options
  )

  const issues = items.filter((issue) => !issue.pull_request)
  return { issues, nextPage }
}

// ---------------------------------------------------------------------------
// Pull Requests
// https://docs.github.com/en/rest/pulls/pulls#list-pull-requests
// ---------------------------------------------------------------------------

export type GitHubPullRequest = {
  number: number
  title: string
  body: string | null
  state: string
  draft: boolean
  user: { login: string } | null
  assignees: { login: string }[]
  requested_reviewers: { login: string }[]
  labels: { name: string }[]
  milestone: { title: string } | null
  base: { ref: string }
  head: { ref: string; sha: string }
  html_url: string
  closed_at: string | null
  merged_at: string | null
  created_at: string
  updated_at: string
}

async function fetchPullRequestsPage(
  repo: string,
  page: number | undefined,
  state: string | undefined,
  options: GitHubClientOptions
): Promise<{
  pullRequests: GitHubPullRequest[]
  nextPage: number | undefined
}> {
  const { items, nextPage } = await fetchPage<GitHubPullRequest>(
    repo,
    `/repos/${repo}/pulls`,
    { state: state ?? "all", sort: "created", direction: "asc" },
    page,
    options
  )

  return { pullRequests: items, nextPage }
}

// ---------------------------------------------------------------------------
// Pull Request Reviews
// https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request
// ---------------------------------------------------------------------------

export type GitHubReview = {
  id: number
  state: string
  user: { login: string } | null
  submitted_at: string | null
}

async function fetchReviews(
  repo: string,
  prNumber: number,
  options: GitHubClientOptions
): Promise<GitHubReview[]> {
  const reviews: GitHubReview[] = []
  let page: number | undefined = 1

  while (page !== undefined) {
    const result: {
      items: GitHubReview[]
      nextPage: number | undefined
    } = await fetchPage<GitHubReview>(
      repo,
      `/repos/${repo}/pulls/${prNumber}/reviews`,
      undefined,
      page,
      options
    )
    reviews.push(...result.items)
    page = result.nextPage
  }

  return reviews
}

// ---------------------------------------------------------------------------
// Check Runs (CI status)
// https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference
// ---------------------------------------------------------------------------

export type GitHubCheckRun = {
  name: string
  status: string
  conclusion: string | null
}

type CheckRunsResponse = {
  total_count: number
  check_runs: GitHubCheckRun[]
}

async function fetchCheckRuns(
  repo: string,
  sha: string,
  options: GitHubClientOptions
): Promise<GitHubCheckRun[]> {
  const checkRuns: GitHubCheckRun[] = []
  let page: number | undefined = 1

  while (page !== undefined) {
    const url = new URL(
      `/repos/${repo}/commits/${sha}/check-runs`,
      API_BASE_URL
    )
    url.searchParams.set("per_page", String(PER_PAGE))
    url.searchParams.set("page", String(page))

    const { data, headers } = await fetchJson<CheckRunsResponse>(
      url,
      repo,
      options
    )
    checkRuns.push(...data.check_runs)
    page = nextPageFromLink(headers.get("Link"))
  }

  return checkRuns
}

// ---------------------------------------------------------------------------
// Combined Commit Status (classic status contexts)
// https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference
// ---------------------------------------------------------------------------

export type GitHubCombinedStatus = {
  state: string
  total_count: number
}

type CombinedStatusResponse = GitHubCombinedStatus & {
  statuses: unknown[]
}

async function fetchCombinedStatus(
  repo: string,
  sha: string,
  options: GitHubClientOptions
): Promise<GitHubCombinedStatus> {
  const url = new URL(`/repos/${repo}/commits/${sha}/status`, API_BASE_URL)
  url.searchParams.set("per_page", String(PER_PAGE))

  const { data } = await fetchJson<CombinedStatusResponse>(url, repo, options)
  return { state: data.state, total_count: data.total_count }
}
