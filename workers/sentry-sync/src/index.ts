// Three default, complementary Sentry views: recent issue triage, project
// reliability signals, and rollout health for the newest releases.

import { createHash } from "node:crypto"

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
  ProjectAggregationLimitError,
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
  fetchIssuesPage,
  fetchProjectsPage,
  fetchRecentReleases,
  fetchReleaseHealth,
  getSentryScope,
  type BeforeRequest,
  type SentryScope,
} from "./sentry.js"
import {
  MAX_SAFE_SYNC_STATE_LENGTH,
  boundedSyncState,
  issueWindow,
  nextCursorTraversal,
  nextIssueState,
  syncStateFits,
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

export async function executeIssuesSync(
  state: IssueSyncState | undefined,
  beforeRequest: BeforeRequest
) {
  const window = issueWindow(state)
  // Pin resource scope with the first page as well as the time window. If an
  // environment variable changes mid-run, the current snapshot finishes
  // against its original query and the new scope starts on the next cycle.
  const scope = state?.scope ?? getSentryScope()
  const page = await fetchIssuesPage(
    beforeRequest,
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
}

worker.sync("issuesSync", {
  database: issues,
  mode: "replace",
  schedule: "15m",
  execute: (state: IssueSyncState | undefined) =>
    executeIssuesSync(state, beforeSentryRequest),
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
  emittedAggregateIds?: string[]
  /** Accepted only while migrating continuations created before pruning. */
  unmatchedProjectIds?: string[]
  cursor?: string
  seenCursors?: string[]
}

type ProjectScopeRequiredState = {
  phase: "scope-required"
  blockedScopeIdentity: string
  reason: "project-count" | "state-size"
}

export type ProjectSyncState =
  | ProjectIssueState
  | ProjectRowsState
  | ProjectScopeRequiredState

// Reserve enough space for a bounded cursor history once project rows begin.
// Aggregates shrink during that phase, so a state accepted here cannot later
// cross the runtime limit merely by advancing inventory pagination.
const PROJECT_INVENTORY_CURSOR_HEADROOM = 40 * 1024
const MAX_PROJECT_AGGREGATION_STATE_LENGTH =
  MAX_SAFE_SYNC_STATE_LENGTH - PROJECT_INVENTORY_CURSOR_HEADROOM

function projectScopeIdentity(scope: SentryScope): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...scope,
        projects: [...scope.projects].sort(),
        environments: [...scope.environments].sort(),
      })
    )
    .digest("hex")
}

function scopeRequiredState(
  scope: SentryScope,
  reason: ProjectScopeRequiredState["reason"]
): ProjectScopeRequiredState {
  return {
    phase: "scope-required",
    blockedScopeIdentity: projectScopeIdentity(scope),
    reason,
  }
}

const projects = worker.database("projects", {
  type: "managed",
  initialTitle: PROJECTS_TITLE,
  primaryKeyProperty: PROJECTS_PK,
  schema: projectSchema,
})

export async function executeProjectsSync(
  previousState: ProjectSyncState | undefined,
  beforeRequest: BeforeRequest
) {
  let state = previousState
  if (state?.phase === "scope-required") {
    const scope = getSentryScope()
    if (projectScopeIdentity(scope) === state.blockedScopeIdentity) {
      const reason =
        state.reason === "project-count"
          ? "more than 500 active projects"
          : "too much continuation data"
      throw new Error(
        `Sentry project aggregation paused before writing rows because it collected ${reason}. Narrow SENTRY_PROJECTS or SENTRY_ENVIRONMENTS, then retry; the refresh will restart automatically after the configured scope changes.`
      )
    }
    const window = issueWindow(undefined)
    state = {
      phase: "issues",
      ...window,
      scope,
      aggregates: {},
    }
  }
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
      beforeRequest,
      {
        ...window,
        cursor: state.cursor,
        statsPeriod: "14d",
      },
      state.scope
    )
    let aggregates: ProjectAggregateMap
    try {
      aggregates = aggregateProjectIssues(
        state.aggregates,
        page.resources,
        window
      )
    } catch (error) {
      if (!(error instanceof ProjectAggregationLimitError)) throw error
      return {
        changes: [],
        hasMore: true,
        nextState: scopeRequiredState(state.scope, "project-count"),
      }
    }

    if (page.hasMore) {
      const next = nextIssueState(state, window, state.scope, page.nextCursor)
      const nextState: ProjectIssueState = {
        phase: "issues",
        ...next,
        aggregates,
      }
      if (!syncStateFits(nextState, MAX_PROJECT_AGGREGATION_STATE_LENGTH)) {
        return {
          changes: [],
          hasMore: true,
          nextState: scopeRequiredState(state.scope, "state-size"),
        }
      }
      return {
        changes: [],
        hasMore: true,
        nextState,
      }
    }

    const nextState: ProjectRowsState = {
      phase: "projects",
      ...window,
      scope: state.scope,
      aggregates,
    }
    if (!syncStateFits(nextState, MAX_PROJECT_AGGREGATION_STATE_LENGTH)) {
      return {
        changes: [],
        hasMore: true,
        nextState: scopeRequiredState(state.scope, "state-size"),
      }
    }
    return {
      changes: [],
      hasMore: true,
      nextState,
    }
  }

  const page = await fetchProjectsPage(beforeRequest, state.cursor, state.scope)
  const resources = page.resources.filter((project) =>
    projectMatchesScope(project, state.scope)
  )
  const remainingAggregates = { ...state.aggregates }
  const legacyUnmatchedIds = state.unmatchedProjectIds
    ? new Set(state.unmatchedProjectIds)
    : undefined
  const emittedAggregateIds = new Set(
    state.emittedAggregateIds ??
      (legacyUnmatchedIds
        ? Object.keys(state.aggregates).filter(
            (projectId) => !legacyUnmatchedIds.has(projectId)
          )
        : [])
  )
  for (const projectId of emittedAggregateIds) {
    delete remainingAggregates[projectId]
  }
  const changes = []
  for (const project of resources) {
    const aggregate = remainingAggregates[project.id]
    // Project inventory can move while cursor pagination is in flight. If a
    // project carrying an aggregate repeats on a later page, keep the first
    // enriched row rather than overwriting it with zeroes after pruning.
    if (!aggregate && emittedAggregateIds.has(project.id)) continue
    changes.push(projectToChange(project, aggregate, window.end, state.scope))
    if (aggregate) {
      delete remainingAggregates[project.id]
      emittedAggregateIds.add(project.id)
    }
  }

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
          phase: "projects" as const,
          start: state.start,
          end: state.end,
          scope: state.scope,
          aggregates: remainingAggregates,
          emittedAggregateIds: [...emittedAggregateIds],
          ...traversal,
        },
        "project inventory"
      ),
    }
  }

  // An issue can outlive a deleted/inaccessible project record. Preserve its
  // aggregate with current issue metadata rather than silently dropping risk.
  const fallbackChanges = Object.keys(remainingAggregates).map((projectId) =>
    projectToChange(
      aggregateProjectResource(remainingAggregates[projectId]),
      remainingAggregates[projectId],
      window.end,
      state.scope
    )
  )
  return { changes: [...changes, ...fallbackChanges], hasMore: false }
}

worker.sync("projectsSync", {
  database: projects,
  mode: "replace",
  schedule: "1d",
  execute: (state: ProjectSyncState | undefined) =>
    executeProjectsSync(state, beforeSentryRequest),
})

const releases = worker.database("releases", {
  type: "managed",
  initialTitle: RELEASES_TITLE,
  primaryKeyProperty: RELEASES_PK,
  schema: releaseSchema,
})

export async function executeReleasesSync(beforeRequest: BeforeRequest) {
  const scope = getSentryScope()
  const window = releaseHealthWindow()
  const recentReleases = await fetchRecentReleases(beforeRequest, scope)
  if (recentReleases.length === 0) {
    return { changes: [], hasMore: false }
  }

  const health = await fetchReleaseHealth(
    beforeRequest,
    window.start,
    window.end,
    scope
  )

  return {
    changes: releasesToChanges(recentReleases, health, scope),
    hasMore: false,
  }
}

worker.sync("releasesSync", {
  database: releases,
  mode: "replace",
  schedule: "15m",
  execute: () => executeReleasesSync(beforeSentryRequest),
})

export default worker
