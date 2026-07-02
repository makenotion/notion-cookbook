// Three default, complementary Sentry views: recent issue triage, project
// reliability signals, and rollout health for the newest releases.

import { Worker } from "@notionhq/workers"

import {
  INITIAL_TITLE as ISSUES_TITLE,
  PRIMARY_KEY as ISSUES_PK,
  issueSchema,
  issueToChange,
} from "./issues.js"
import {
  INITIAL_TITLE as PROJECTS_TITLE,
  PRIMARY_KEY as PROJECTS_PK,
  aggregateProjectIssues,
  aggregateProjectResource,
  projectMatchesScope,
  projectSchema,
  projectToChange,
  type ProjectAggregateMap,
} from "./projects.js"
import {
  INITIAL_TITLE as RELEASES_TITLE,
  PRIMARY_KEY as RELEASES_PK,
  releaseHealthWindow,
  releaseSchema,
  releasesToChanges,
} from "./releases.js"
import {
  SentryApiError,
  fetchIssuesPage,
  fetchProjectsPage,
  fetchRecentReleases,
  fetchReleaseHealth,
  getSentryScope,
  type SentryScope,
} from "./sentry.js"
import {
  boundedSyncState,
  issueWindow,
  nextCursorTraversal,
  nextIssueState,
  type IssueSyncState,
  type IssueWindow,
} from "./sync-state.js"

const worker = new Worker()

// Sentry applies caller- and endpoint-specific frequency/concurrency limits,
// rather than publishing one universal quota. Serialize all calls through a
// conservative shared courtesy cap and still honor 429/reset headers.
const pacer = worker.pacer("sentry", {
  allowedRequests: 60,
  intervalMs: 60_000,
})
const beforeSentryRequest = () => pacer.wait()

const issues = worker.database("issues", {
  type: "managed",
  initialTitle: ISSUES_TITLE,
  primaryKeyProperty: ISSUES_PK,
  schema: issueSchema,
})

worker.sync("issuesSync", {
  database: issues,
  mode: "replace",
  schedule: "15m",
  execute: async (state: IssueSyncState | undefined) => {
    const window = issueWindow(state)
    // Pin resource scope with the first page as well as the time window. If an
    // environment variable changes mid-run, the current snapshot finishes
    // against its original query and the new scope starts on the next cycle.
    const scope = state?.scope ?? getSentryScope()
    const page = await fetchIssuesPage(
      beforeSentryRequest,
      {
        ...window,
        cursor: state?.cursor,
      },
      scope
    )

    return {
      changes: page.resources.map(issueToChange),
      hasMore: page.hasMore,
      nextState: page.hasMore
        ? boundedSyncState(
            nextIssueState(state, window, scope, page.nextCursor),
            "issue pagination"
          )
        : undefined,
    }
  },
})

type ProjectIssueState = IssueSyncState & {
  phase: "issues"
  aggregates: ProjectAggregateMap
}

type ProjectRowsState = {
  phase: "projects"
  start: string
  end: string
  scope: SentryScope
  aggregates: ProjectAggregateMap
  unmatchedProjectIds: string[]
  cursor?: string
  seenCursors?: string[]
}

export type ProjectSyncState = ProjectIssueState | ProjectRowsState

const projects = worker.database("projects", {
  type: "managed",
  initialTitle: PROJECTS_TITLE,
  primaryKeyProperty: PROJECTS_PK,
  schema: projectSchema,
})

worker.sync("projectsSync", {
  database: projects,
  mode: "replace",
  schedule: "1d",
  execute: async (previousState: ProjectSyncState | undefined) => {
    let state = previousState
    if (!state) {
      const window = issueWindow(undefined)
      state = {
        phase: "issues",
        ...window,
        scope: getSentryScope(),
        aggregates: {},
      }
    }

    const window: IssueWindow = issueWindow(state)
    if (state.phase === "issues") {
      const page = await fetchIssuesPage(
        beforeSentryRequest,
        {
          ...window,
          cursor: state.cursor,
          statsPeriod: "14d",
        },
        state.scope
      )
      const aggregates = aggregateProjectIssues(
        state.aggregates,
        page.resources,
        window
      )

      if (page.hasMore) {
        const next = nextIssueState(state, window, state.scope, page.nextCursor)
        return {
          changes: [],
          hasMore: true,
          nextState: boundedSyncState(
            {
              phase: "issues" as const,
              ...next,
              aggregates,
            },
            "project aggregation"
          ),
        }
      }

      return {
        changes: [],
        hasMore: true,
        nextState: boundedSyncState(
          {
            phase: "projects" as const,
            ...window,
            scope: state.scope,
            aggregates,
            unmatchedProjectIds: Object.keys(aggregates),
          },
          "project aggregation"
        ),
      }
    }

    const page = await fetchProjectsPage(
      beforeSentryRequest,
      state.cursor,
      state.scope
    )
    const resources = page.resources.filter((project) =>
      projectMatchesScope(project, state.scope)
    )
    const returnedIds = new Set(resources.map((project) => project.id))
    const unmatchedProjectIds = state.unmatchedProjectIds.filter(
      (projectId) => !returnedIds.has(projectId)
    )
    const changes = resources.map((project) =>
      projectToChange(
        project,
        state.aggregates[project.id],
        window.end,
        state.scope
      )
    )

    if (page.hasMore) {
      const traversal = nextCursorTraversal(
        state.cursor,
        state.seenCursors,
        page.nextCursor,
        "project"
      )
      return {
        changes,
        hasMore: true,
        nextState: boundedSyncState(
          {
            ...state,
            ...traversal,
            unmatchedProjectIds,
          },
          "project inventory"
        ),
      }
    }

    // An issue can outlive a deleted/inaccessible project record. Preserve its
    // aggregate with current issue metadata rather than silently dropping risk.
    const fallbackChanges = unmatchedProjectIds.map((projectId) =>
      projectToChange(
        aggregateProjectResource(state.aggregates[projectId]),
        state.aggregates[projectId],
        window.end,
        state.scope
      )
    )
    return { changes: [...changes, ...fallbackChanges], hasMore: false }
  },
})

const releases = worker.database("releases", {
  type: "managed",
  initialTitle: RELEASES_TITLE,
  primaryKeyProperty: RELEASES_PK,
  schema: releaseSchema,
})

worker.sync("releasesSync", {
  database: releases,
  mode: "replace",
  schedule: "15m",
  execute: async () => {
    const scope = getSentryScope()
    const window = releaseHealthWindow()
    const recentReleases = await fetchRecentReleases(beforeSentryRequest, scope)
    if (recentReleases.length === 0) {
      return { changes: [], hasMore: false }
    }

    let health
    try {
      health = await fetchReleaseHealth(
        beforeSentryRequest,
        window.start,
        window.end,
        scope
      )
    } catch (error) {
      // A sessions 404 can mean that Release Health is unavailable on this
      // route or installation. Preserve useful metadata-only rows; the README
      // lists other 404 causes to check when health was expected.
      if (!(error instanceof SentryApiError) || error.status !== 404)
        throw error
      health = { available: false, start: null, end: null, groups: [] }
    }

    return {
      changes: releasesToChanges(recentReleases, health, scope),
      hasMore: false,
    }
  },
})

export default worker
