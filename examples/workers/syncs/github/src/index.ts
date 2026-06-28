// Entry point — syncs GitHub issues and pull requests from one or more
// repositories into managed Notion databases.
//
// Each resource has its own schema + transform file. This file registers the
// managed databases and sync schedules.

import { Worker } from "@notionhq/workers"

import {
  getRepos,
  fetchIssuesPage,
  fetchPullRequestsPage,
} from "./github.js"
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
} from "./pull-requests.js"

// Tracks position across multiple repos and pages.
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
    await pacer.wait()

    const repos = getRepos()
    const repoIndex = state?.repoIndex ?? 0
    const page = state?.page ?? 1
    const repo = repos[repoIndex]

    if (!repo) {
      return { changes: [], hasMore: false }
    }

    const result = await fetchIssuesPage(repo, page)
    const changes = result.issues.map((i) => issueToChange(i, repo))

    if (result.hasMore) {
      return {
        changes,
        hasMore: true,
        nextState: { repoIndex, page: page + 1 },
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
// Pull Requests
// ---------------------------------------------------------------------------

const pullRequests = worker.database("pullRequests", {
  type: "managed",
  initialTitle: PRS_TITLE,
  primaryKeyProperty: PRS_PK,
  schema: pullRequestSchema,
})

worker.sync("pullRequestsSync", {
  database: pullRequests,
  mode: "replace",
  schedule: "5m",
  execute: async (state: SyncState | undefined) => {
    await pacer.wait()

    const repos = getRepos()
    const repoIndex = state?.repoIndex ?? 0
    const page = state?.page ?? 1
    const repo = repos[repoIndex]

    if (!repo) {
      return { changes: [], hasMore: false }
    }

    const result = await fetchPullRequestsPage(repo, page)
    const changes = result.pullRequests.map((pr) =>
      pullRequestToChange(pr, repo)
    )

    if (result.hasMore) {
      return {
        changes,
        hasMore: true,
        nextState: { repoIndex, page: page + 1 },
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
