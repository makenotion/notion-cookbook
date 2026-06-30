// Entry point — syncs GitHub issues and pull requests from one or more
// repositories into managed Notion databases.
//
// Three databases are created:
//   1. Issues        — all issues, synced every 5 min
//   2. All PRs       — all pull requests (basic fields), synced every 5 min
//   3. Open PRs      — open PRs enriched with review + CI status, synced every 5 min

import { Worker } from "@notionhq/workers"

import { createGitHubAccessTokenProvider } from "./auth.js"
import { createGitHubClient, getRepos } from "./github.js"
import {
  INITIAL_TITLE as ISSUES_TITLE,
  PRIMARY_KEY as ISSUES_PK,
  issueSchema,
  issueToChange,
} from "./issues.js"
import {
  INITIAL_TITLE as PRS_TITLE,
  PRIMARY_KEY as PRS_PK,
  pullRequestSchema,
  pullRequestToChange,
} from "./all-pull-requests.js"
import {
  INITIAL_TITLE as OPEN_PRS_TITLE,
  PRIMARY_KEY as OPEN_PRS_PK,
  openPullRequestSchema,
  openPullRequestToChange,
} from "./open-pull-requests.js"

type SyncState = {
  repoIndex: number
  page: number
}

const worker = new Worker()

// GitHub rate-limits authenticated requests to 5000 per hour.
const pacer = worker.pacer("github", {
  allowedRequests: 4800,
  intervalMs: 3_600_000,
})

const beforeGitHubRequest = () => pacer.wait()
const github = createGitHubClient({
  beforeRequest: beforeGitHubRequest,
  getAccessToken: createGitHubAccessTokenProvider(worker),
})

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

const issues = worker.database("issues", {
  type: "managed",
  initialTitle: ISSUES_TITLE,
  primaryKeyProperty: ISSUES_PK,
  schema: issueSchema,
})

worker.sync("issuesSync", {
  database: issues,
  mode: "replace",
  schedule: "5m",
  execute: async (state: SyncState | undefined) => {
    const repos = getRepos()
    const repoIndex = state?.repoIndex ?? 0
    const page = state?.page ?? 1
    const repo = repos[repoIndex]

    if (!repo) {
      return { changes: [], hasMore: false }
    }

    const result = await github.fetchIssuesPage(repo, page)
    const changes = result.issues.map((i) => issueToChange(i, repo))

    if (result.nextPage !== undefined) {
      return {
        changes,
        hasMore: true,
        nextState: { repoIndex, page: result.nextPage },
      }
    }

    const nextRepo = repoIndex + 1
    if (nextRepo < repos.length) {
      return {
        changes,
        hasMore: true,
        nextState: { repoIndex: nextRepo, page: 1 },
      }
    }

    return { changes, hasMore: false }
  },
})

// ---------------------------------------------------------------------------
// All Pull Requests — basic fields, all states
// ---------------------------------------------------------------------------

const allPullRequests = worker.database("allPullRequests", {
  type: "managed",
  initialTitle: PRS_TITLE,
  primaryKeyProperty: PRS_PK,
  schema: pullRequestSchema,
})

worker.sync("allPullRequestsSync", {
  database: allPullRequests,
  mode: "replace",
  schedule: "5m",
  execute: async (state: SyncState | undefined) => {
    const repos = getRepos()
    const repoIndex = state?.repoIndex ?? 0
    const page = state?.page ?? 1
    const repo = repos[repoIndex]

    if (!repo) {
      return { changes: [], hasMore: false }
    }

    const result = await github.fetchPullRequestsPage(repo, page, "all")
    const changes = result.pullRequests.map((pr) =>
      pullRequestToChange(pr, repo)
    )

    if (result.nextPage !== undefined) {
      return {
        changes,
        hasMore: true,
        nextState: { repoIndex, page: result.nextPage },
      }
    }

    const nextRepo = repoIndex + 1
    if (nextRepo < repos.length) {
      return {
        changes,
        hasMore: true,
        nextState: { repoIndex: nextRepo, page: 1 },
      }
    }

    return { changes, hasMore: false }
  },
})

// ---------------------------------------------------------------------------
// Open Pull Requests — enriched with review state and CI status
// ---------------------------------------------------------------------------

const openPullRequests = worker.database("openPullRequests", {
  type: "managed",
  initialTitle: OPEN_PRS_TITLE,
  primaryKeyProperty: OPEN_PRS_PK,
  schema: openPullRequestSchema,
})

worker.sync("openPullRequestsSync", {
  database: openPullRequests,
  mode: "replace",
  schedule: "5m",
  execute: async (state: SyncState | undefined) => {
    const repos = getRepos()
    const repoIndex = state?.repoIndex ?? 0
    const page = state?.page ?? 1
    const repo = repos[repoIndex]

    if (!repo) {
      return { changes: [], hasMore: false }
    }

    // Scan all PRs in stable created order so a PR closing during a replace
    // cycle cannot shift the membership of later pages. Only open PRs are
    // emitted, so closed PRs are still swept from this database.
    const result = await github.fetchPullRequestsPage(repo, page, "all")
    const changes = []

    for (const pr of result.pullRequests.filter((pr) => pr.state === "open")) {
      const reviews = await github.fetchReviews(repo, pr.number)
      const checkRuns = await github.fetchCheckRuns(repo, pr.head.sha)
      const combinedStatus = await github.fetchCombinedStatus(repo, pr.head.sha)
      changes.push(
        openPullRequestToChange(pr, repo, reviews, checkRuns, combinedStatus)
      )
    }

    if (result.nextPage !== undefined) {
      return {
        changes,
        hasMore: true,
        nextState: { repoIndex, page: result.nextPage },
      }
    }

    const nextRepo = repoIndex + 1
    if (nextRepo < repos.length) {
      return {
        changes,
        hasMore: true,
        nextState: { repoIndex: nextRepo, page: 1 },
      }
    }

    return { changes, hasMore: false }
  },
})

export default worker
