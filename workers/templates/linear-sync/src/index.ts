// Entry point — syncs Linear projects, issues, and initiatives into managed
// Notion databases for cross-functional product and engineering visibility.
//
// Three databases are created:
//   1. Projects     — strategic delivery view (every 15 min)
//   2. Issues       — incremental workflow updates (every 5 min), plus a
//                     daily full reconciliation for deletes and drift
//   3. Initiatives  — company-level goals and health (hourly)

// Every API request shares one pacer. All pagination and incremental cursors
// are plain serializable state so executions never rely on module globals.

import { Worker } from "@notionhq/workers"

import {
  fetchInitiativesPage,
  fetchIssuesPage,
  fetchProjectsPage,
} from "./linear.js"
import {
  INITIAL_TITLE as PROJECTS_TITLE,
  PRIMARY_KEY as PROJECTS_PK,
  projectSchema,
  projectToChange,
} from "./projects.js"
import {
  INITIAL_TITLE as ISSUES_TITLE,
  PRIMARY_KEY as ISSUES_PK,
  issueSchema,
  issueToChange,
  issueToSyncChange,
} from "./issues.js"
import {
  INITIAL_TITLE as INITIATIVES_TITLE,
  PRIMARY_KEY as INITIATIVES_PK,
  initiativeSchema,
  initiativeToChange,
} from "./initiatives.js"
import {
  issueIncrementalWindow,
  nextCursorState,
  nextIssueWatermark,
  type CursorSyncState,
  type IssueIncrementalSyncState,
} from "./sync-state.js"

const worker = new Worker()

// Linear currently documents a lower API-key limit of 2,500 requests/hour
// alongside a separate query-complexity budget. Keep aggregate traffic below
// the lower request limit and keep each GraphQL query deliberately shallow.
const pacer = worker.pacer("linear", {
  allowedRequests: 2_000,
  intervalMs: 3_600_000,
})
const beforeLinearRequest = () => pacer.wait()

// ---------------------------------------------------------------------------
// Projects — strategic delivery view
// ---------------------------------------------------------------------------

const projects = worker.database("projects", {
  type: "managed",
  initialTitle: PROJECTS_TITLE,
  primaryKeyProperty: PROJECTS_PK,
  schema: projectSchema,
})

worker.sync("projectsSync", {
  database: projects,
  mode: "replace",
  schedule: "15m",
  execute: async (state: CursorSyncState | undefined) => {
    const page = await fetchProjectsPage(beforeLinearRequest, state?.after)
    const changes = page.resources
      .filter((project) => !project.trashed)
      .map(projectToChange)

    return {
      changes,
      hasMore: page.hasMore,
      nextState: page.hasMore
        ? nextCursorState(state, page.nextCursor, "projects")
        : undefined,
    }
  },
})

// ---------------------------------------------------------------------------
// Issues — fast incremental updates with an overlapping, pinned time window
// ---------------------------------------------------------------------------

const issues = worker.database("issues", {
  type: "managed",
  initialTitle: ISSUES_TITLE,
  primaryKeyProperty: ISSUES_PK,
  schema: issueSchema,
})

worker.sync("issuesSync", {
  database: issues,
  mode: "incremental",
  schedule: "5m",
  execute: async (state: IssueIncrementalSyncState | undefined) => {
    const { since, until } = issueIncrementalWindow(state)

    const page = await fetchIssuesPage(beforeLinearRequest, {
      after: state?.after,
      updatedSince: since,
      updatedBefore: until,
    })
    const changes = page.resources.map(issueToSyncChange)

    if (page.hasMore) {
      return {
        changes,
        hasMore: true,
        nextState: {
          since,
          until,
          ...nextCursorState(state, page.nextCursor, "issues"),
        },
      }
    }

    // Keep an overlap so equal timestamps, indexing lag, and writes near the
    // window boundary are safely replayed. Upserts are idempotent by UUID.
    return {
      changes,
      hasMore: false,
      // Incremental sync state persists between scheduled runs even when the
      // current page finishes the cycle.
      nextState: { since: nextIssueWatermark(until) },
    }
  },
})

// A daily full sweep repairs missed updates and removes hard-deleted issues,
// which an updatedAt watermark cannot discover by itself.
worker.sync("issuesReconciliationSync", {
  database: issues,
  mode: "replace",
  schedule: "1d",
  execute: async (state: CursorSyncState | undefined) => {
    const page = await fetchIssuesPage(beforeLinearRequest, {
      after: state?.after,
    })
    const changes = page.resources
      .filter((issue) => !issue.trashed)
      .map(issueToChange)

    return {
      changes,
      hasMore: page.hasMore,
      nextState: page.hasMore
        ? nextCursorState(state, page.nextCursor, "issues")
        : undefined,
    }
  },
})

// ---------------------------------------------------------------------------
// Initiatives — leadership-level goals and health
// ---------------------------------------------------------------------------

const initiatives = worker.database("initiatives", {
  type: "managed",
  initialTitle: INITIATIVES_TITLE,
  primaryKeyProperty: INITIATIVES_PK,
  schema: initiativeSchema,
})

worker.sync("initiativesSync", {
  database: initiatives,
  mode: "replace",
  schedule: "1h",
  execute: async (state: CursorSyncState | undefined) => {
    const page = await fetchInitiativesPage(beforeLinearRequest, state?.after)
    const changes = page.resources
      .filter((initiative) => !initiative.trashed)
      .map(initiativeToChange)

    return {
      changes,
      hasMore: page.hasMore,
      nextState: page.hasMore
        ? nextCursorState(state, page.nextCursor, "initiatives")
        : undefined,
    }
  },
})

export default worker
