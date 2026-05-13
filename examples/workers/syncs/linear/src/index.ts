// Linear → Notion sync.
//
// Two syncs share a single managed database:
//
//   - `issuesBackfill` (replace mode, manual) — paginates every issue in
//     the workspace. Run it once on first deploy and any time you need to
//     reconcile (e.g. you suspect drift, or an issue was deleted in Linear).
//
//   - `issuesDelta` (incremental mode, every 5 minutes) — pulls only issues
//     whose `updatedAt` is newer than the last cursor. This is what keeps
//     Notion in sync day-to-day.
//
// This backfill+delta pattern is the recommended shape for any API that
// supports change tracking. See
// https://developers.notion.com/workers/guides/syncs for the full design.

import { Worker } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"
import { fetchAllIssuesPage, fetchIssuesUpdatedSince } from "./linear.js"
import type { LinearIssue } from "./types.js"

const worker = new Worker()
export default worker

// Linear's GraphQL API allows up to 1500 requests/hour (~25/sec) for
// personal API keys. We stay well under that with a conservative pacer
// that both syncs share — the runtime apportions the budget between them.
const linearApi = worker.pacer("linearApi", {
  allowedRequests: 5,
  intervalMs: 1000,
})

// Lag the delta cursor 15 seconds behind real time. Linear is eventually
// consistent, so a write that happened ~now might not be queryable yet.
// Without this buffer, we risk advancing the cursor past records that
// haven't been indexed — and missing them forever.
const CONSISTENCY_BUFFER_MS = 15_000

const issues = worker.database("issues", {
  type: "managed",
  initialTitle: "Linear Issues",
  primaryKeyProperty: "Issue ID",
  schema: {
    properties: {
      Title: Schema.title(),
      "Issue ID": Schema.richText(),
      URL: Schema.url(),
      // Workspace-specific values — use richText so we don't have to
      // enumerate every possible state and label.
      State: Schema.richText(),
      Assignee: Schema.richText(),
      Labels: Schema.richText(),
      // Linear's five fixed priority labels — safe to enumerate.
      Priority: Schema.select([
        { name: "No priority" },
        { name: "Urgent", color: "red" },
        { name: "High", color: "orange" },
        { name: "Medium", color: "yellow" },
        { name: "Low", color: "blue" },
      ]),
      Updated: Schema.date(),
    },
  },
})

function toUpsert(issue: LinearIssue) {
  const labels = issue.labels.nodes.map((l) => l.name).join(", ")
  return {
    type: "upsert" as const,
    key: issue.id,
    properties: {
      Title: Builder.title(`${issue.identifier} — ${issue.title}`),
      "Issue ID": Builder.richText(issue.identifier),
      URL: Builder.url(issue.url),
      State: Builder.richText(issue.state?.name ?? ""),
      Assignee: Builder.richText(issue.assignee?.name ?? ""),
      Labels: Builder.richText(labels),
      Priority: Builder.select(issue.priorityLabel),
      Updated: Builder.dateTime(issue.updatedAt),
    },
  }
}

// --- Backfill sync (replace mode) ---
//
// Walks the entire `issues` connection one page at a time. At the end of
// the cycle, the runtime deletes any rows we didn't touch — so if an issue
// was hard-deleted in Linear, it disappears from Notion on the next backfill.
//
// `schedule: "manual"` means it only runs when triggered:
//   ntn workers sync trigger issuesBackfill
type BackfillState = { after: string | null }

worker.sync("issuesBackfill", {
  database: issues,
  mode: "replace",
  schedule: "manual",
  execute: async (state: BackfillState | undefined) => {
    const after = state?.after ?? null
    await linearApi.wait()
    const page = await fetchAllIssuesPage(after)

    return {
      changes: page.nodes.map(toUpsert),
      hasMore: page.hasNextPage,
      nextState: page.hasNextPage ? { after: page.endCursor } : undefined,
    }
  },
})

// --- Delta sync (incremental mode) ---
//
// The cursor is a `(since, after, maxSeen)` triple:
//   - `since`   — the `updatedAt` watermark. Only issues newer than this
//                 are fetched in the current cycle.
//   - `after`   — within-cycle page cursor while sweeping the current
//                 watermark's result set. Resets to null at end of cycle.
//   - `maxSeen` — the largest `updatedAt` observed during the current
//                 cycle. At end-of-cycle, this becomes the new `since`
//                 (clamped to "now − buffer" for consistency).
//
// State must survive across multiple `execute` calls inside one cycle
// because we paginate within a cycle when there's a backlog.
type DeltaState = {
  since: string
  after: string | null
  maxSeen: string
}

worker.sync("issuesDelta", {
  database: issues,
  mode: "incremental",
  schedule: "5m",
  execute: async (state: DeltaState | undefined) => {
    const since = state?.since ?? new Date(0).toISOString()
    const after = state?.after ?? null
    const maxSeenSoFar = state?.maxSeen ?? since

    await linearApi.wait()
    const page = await fetchIssuesUpdatedSince(since, after)

    const maxSeen = page.nodes.reduce(
      (max, n) => (n.updatedAt > max ? n.updatedAt : max),
      maxSeenSoFar
    )

    // Mid-cycle: still pages to fetch. Keep `since` pinned, advance
    // `after`, carry the running `maxSeen`.
    if (page.hasNextPage) {
      return {
        changes: page.nodes.map(toUpsert),
        hasMore: true,
        nextState: {
          since,
          after: page.endCursor,
          maxSeen,
        },
      }
    }

    // End of cycle: advance the watermark, clamped by the buffer so we
    // don't run ahead of Linear's index.
    const bufferTs = new Date(Date.now() - CONSISTENCY_BUFFER_MS).toISOString()
    const newSince = maxSeen < bufferTs ? maxSeen : bufferTs

    return {
      changes: page.nodes.map(toUpsert),
      hasMore: false,
      nextState: {
        since: newSince,
        after: null,
        maxSeen: newSince,
      },
    }
  },
})
