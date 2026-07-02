// Entry point — maintains one rolling Sentry issue database for operational
// triage and recent review. Every run is a complete, paginated reconciliation
// of issue groups seen during the pinned prior 30 days.

import { Worker } from "@notionhq/workers"

import {
  INITIAL_TITLE as ISSUES_TITLE,
  PRIMARY_KEY as ISSUES_PK,
  issueSchema,
  issueToChange,
} from "./issues.js"
import { fetchIssuesPage, getIssueScope } from "./sentry.js"
import {
  issueWindow,
  nextIssueState,
  type IssueSyncState,
} from "./sync-state.js"

const worker = new Worker()

// Sentry applies caller- and endpoint-specific frequency/concurrency limits,
// rather than publishing one universal quota. Serialize all issue-list calls
// through a conservative shared courtesy cap and still honor 429/reset headers.
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
    const scope = state?.scope ?? getIssueScope()
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
        ? nextIssueState(state, window, scope, page.nextCursor)
        : undefined,
    }
  },
})

export default worker
