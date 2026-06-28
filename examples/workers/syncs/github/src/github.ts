// GitHub REST API client. Handles authentication and paginated fetching
// for issues and pull requests across multiple repositories.
//
// To add a new resource (e.g. releases, actions runs):
//   1. Add a type for the API response shape
//   2. Add a fetchXxxPage() function using fetchPage()
//   3. Wire it into index.ts

const PER_PAGE = 100

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is not set.`)
  }
  return value
}

export function getRepos(): string[] {
  const raw = requireEnv("GITHUB_REPOS")
  return raw
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
}

// Generic paginated fetch for any GitHub list endpoint.
// GitHub uses page-based pagination; hasMore is true when a full page is returned.
async function fetchPage<T>(
  path: string,
  params?: Record<string, string>,
  page?: number
): Promise<{ items: T[]; hasMore: boolean }> {
  const token = requireEnv("GITHUB_TOKEN")
  const p = page ?? 1
  const url = new URL(`https://api.github.com${path}`)
  url.searchParams.set("per_page", String(PER_PAGE))
  url.searchParams.set("page", String(p))
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v)
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `GitHub API error (${response.status}): ${text || "No response body"}`
    )
  }

  const items = JSON.parse(text) as T[]
  return { items, hasMore: items.length === PER_PAGE }
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
export async function fetchIssuesPage(
  repo: string,
  page?: number
): Promise<{ issues: GitHubIssue[]; hasMore: boolean }> {
  const { items, hasMore } = await fetchPage<GitHubIssue>(
    `/repos/${repo}/issues`,
    { state: "all", sort: "updated", direction: "desc" },
    page
  )

  const issues = items.filter((i) => !i.pull_request)
  return { issues, hasMore }
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
  head: { ref: string }
  additions: number
  deletions: number
  review_comments: number
  comments: number
  html_url: string
  merged_at: string | null
  created_at: string
  updated_at: string
}

export async function fetchPullRequestsPage(
  repo: string,
  page?: number
): Promise<{ pullRequests: GitHubPullRequest[]; hasMore: boolean }> {
  const { items, hasMore } = await fetchPage<GitHubPullRequest>(
    `/repos/${repo}/pulls`,
    { state: "all", sort: "updated", direction: "desc" },
    page
  )

  return { pullRequests: items, hasMore }
}
