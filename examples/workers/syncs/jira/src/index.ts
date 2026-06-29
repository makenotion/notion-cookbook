// Entry point — syncs Jira Cloud issues, sprints, and projects into
// managed Notion databases.
//
// Three databases are created:
//   1. Issues    — status, priority, assignee, sprint, project (every 2 min)
//   2. Sprints   — state, board, dates, goal (every 5 min)
//   3. Projects  — key, lead, category, type (every 5 min)
//
// Issues are scoped to specific projects via the JIRA_PROJECTS env var.
// Board names are fetched once per sprint sync cycle to resolve board IDs.
// Three pagination models are used because each Jira endpoint differs:
//   - Issues: startAt/total (classic search endpoint)
//   - Sprints: multi-board iteration with startAt/isLast per board
//   - Projects: startAt/isLast

import { Worker } from "@notionhq/workers"

import {
  getBaseUrl,
  fetchIssuesPage,
  fetchAllBoards,
  fetchSprintsForBoard,
  fetchProjectsPage,
} from "./jira.js"
import type { BoardLookup } from "./jira.js"
import {
  INITIAL_TITLE as ISSUES_TITLE,
  PRIMARY_KEY as ISSUES_PK,
  issueSchema,
  issueToChange,
} from "./issues.js"
import {
  INITIAL_TITLE as SPRINTS_TITLE,
  PRIMARY_KEY as SPRINTS_PK,
  sprintSchema,
  sprintToChange,
} from "./sprints.js"
import {
  INITIAL_TITLE as PROJECTS_TITLE,
  PRIMARY_KEY as PROJECTS_PK,
  projectSchema,
  projectToChange,
} from "./projects.js"

const worker = new Worker()

// Jira Cloud rate-limits to 10 requests per second on Standard plans.
const pacer = worker.pacer("jira", {
  allowedRequests: 9,
  intervalMs: 1_000,
})

// ---------------------------------------------------------------------------
// Issues — core engineering workflow
// ---------------------------------------------------------------------------

type IssueSyncState = {
  startAt: number
}

const issues = worker.database("issues", {
  type: "managed",
  initialTitle: ISSUES_TITLE,
  primaryKeyProperty: ISSUES_PK,
  schema: issueSchema,
})

worker.sync("issuesSync", {
  database: issues,
  mode: "replace",
  schedule: "2m",
  execute: async (state: IssueSyncState | undefined) => {
    await pacer.wait()
    const baseUrl = getBaseUrl()

    const page = await fetchIssuesPage(state?.startAt)
    const changes = page.issues.map((i) => issueToChange(i, baseUrl))

    if (page.hasMore) {
      return {
        changes,
        hasMore: true,
        nextState: { startAt: page.nextStartAt },
      }
    }

    return { changes, hasMore: false }
  },
})

// ---------------------------------------------------------------------------
// Sprints — iterates all Scrum boards, fetches sprints for each
// ---------------------------------------------------------------------------

type SprintSyncState = {
  boardIndex: number
  startAt: number
}

let sprintBoards: BoardLookup | undefined
let sprintBoardIds: number[] | undefined

const sprints = worker.database("sprints", {
  type: "managed",
  initialTitle: SPRINTS_TITLE,
  primaryKeyProperty: SPRINTS_PK,
  schema: sprintSchema,
})

worker.sync("sprintsSync", {
  database: sprints,
  mode: "replace",
  schedule: "5m",
  execute: async (state: SprintSyncState | undefined) => {
    await pacer.wait()

    if (!sprintBoards) {
      sprintBoards = await fetchAllBoards(() => pacer.wait())
      sprintBoardIds = [...sprintBoards.keys()]
    }

    const boardIndex = state?.boardIndex ?? 0
    const startAt = state?.startAt ?? 0
    const boardId = sprintBoardIds![boardIndex]

    if (boardId === undefined) {
      sprintBoards = undefined
      sprintBoardIds = undefined
      return { changes: [], hasMore: false }
    }

    await pacer.wait()
    const result = await fetchSprintsForBoard(boardId, startAt)
    const changes = result.sprints.map((s) =>
      sprintToChange(s, sprintBoards!)
    )

    if (result.hasMore) {
      return {
        changes,
        hasMore: true,
        nextState: { boardIndex, startAt: result.nextStartAt },
      }
    }

    const nextBoard = boardIndex + 1
    if (nextBoard < sprintBoardIds!.length) {
      return {
        changes,
        hasMore: true,
        nextState: { boardIndex: nextBoard, startAt: 0 },
      }
    }

    sprintBoards = undefined
    sprintBoardIds = undefined
    return { changes, hasMore: false }
  },
})

// ---------------------------------------------------------------------------
// Projects — reference data
// ---------------------------------------------------------------------------

type ProjectSyncState = {
  startAt: number
}

const projects = worker.database("projects", {
  type: "managed",
  initialTitle: PROJECTS_TITLE,
  primaryKeyProperty: PROJECTS_PK,
  schema: projectSchema,
})

worker.sync("projectsSync", {
  database: projects,
  mode: "replace",
  schedule: "5m",
  execute: async (state: ProjectSyncState | undefined) => {
    await pacer.wait()
    const baseUrl = getBaseUrl()
    const startAt = state?.startAt ?? 0

    const page = await fetchProjectsPage(startAt)
    const changes = page.projects.map((p) => projectToChange(p, baseUrl))

    if (page.hasMore) {
      return {
        changes,
        hasMore: true,
        nextState: { startAt: page.nextStartAt },
      }
    }

    return { changes, hasMore: false }
  },
})

export default worker
