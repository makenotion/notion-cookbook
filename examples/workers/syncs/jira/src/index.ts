// Entry point — syncs Jira Cloud issues, sprints, sprint performance, and
// projects into
// managed Notion databases.
//
// Four databases are created:
//   1. Issues              — engineering workflow (every 5 min)
//   2. Current Sprints     — active and future sprint mirror (every 15 min)
//   3. Sprint Performance  — daily historical analytics and issue roster
//   4. Projects            — project reference data (daily)
//
// Issues are scoped to specific projects via the JIRA_PROJECTS env var.
// Board names are fetched once per sprint sync cycle to resolve board IDs.
// Three pagination models are used because each Jira endpoint differs:
//   - Issues: nextPageToken/isLast (enhanced search endpoint)
//   - Sprints: multi-board iteration with startAt/isLast per board
//   - Projects: startAt/isLast

import { Worker } from "@notionhq/workers"

import {
  getBaseUrl,
  fetchIssueFieldConfig,
  fetchIssuesPage,
  fetchAllBoards,
  fetchBoardConfiguration,
  fetchSprintsForBoard,
  fetchProjectsPage,
} from "./jira.js"
import type {
  IssueFieldConfig,
  JiraBoardConfiguration,
  JiraSprint,
} from "./jira.js"
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
import {
  ALL_SPRINTS_INITIAL_TITLE,
  ALL_SPRINTS_PRIMARY_KEY,
  allSprintsSchema,
  calculateSprintAnalytics,
  sprintAnalyticsToChange,
} from "./sprint-analytics.js"
import { fetchSprintAnalyticsInput } from "./all-sprints.js"

const worker = new Worker()

// Keep normal traffic conservative. Jira can also return quota- and
// burst-based 429s, which the API client surfaces as RateLimitError so the
// Workers runtime can honor Retry-After.
const pacer = worker.pacer("jira", {
  allowedRequests: 9,
  intervalMs: 1_000,
})

// ---------------------------------------------------------------------------
// Issues — core engineering workflow
// ---------------------------------------------------------------------------

type IssueSyncState = {
  nextPageToken?: string
  fieldConfig: IssueFieldConfig
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
  schedule: "5m",
  execute: async (state: IssueSyncState | undefined) => {
    const baseUrl = getBaseUrl()
    let fieldConfig = state?.fieldConfig

    if (!fieldConfig) {
      await pacer.wait()
      fieldConfig = await fetchIssueFieldConfig()
    }

    await pacer.wait()
    const page = await fetchIssuesPage(fieldConfig, state?.nextPageToken)
    const changes = page.issues.map((issue) =>
      issueToChange(issue, baseUrl, fieldConfig)
    )

    if (page.hasMore) {
      return {
        changes,
        hasMore: true,
        nextState: {
          nextPageToken: page.nextPageToken,
          fieldConfig,
        },
      }
    }

    return { changes, hasMore: false }
  },
})

// ---------------------------------------------------------------------------
// Current Sprints — lightweight mirror of active and future sprints
// ---------------------------------------------------------------------------

type BoardRef = {
  id: number
  name: string
}

type CurrentSprintSyncState = {
  boards: BoardRef[]
  boardIndex: number
  startAt: number
}

async function fetchBoardRefs(): Promise<BoardRef[]> {
  const boards = await fetchAllBoards(() => pacer.wait())
  return [...boards].map(([id, name]) => ({ id, name }))
}

const currentSprints = worker.database("currentSprints", {
  type: "managed",
  initialTitle: SPRINTS_TITLE,
  primaryKeyProperty: SPRINTS_PK,
  schema: sprintSchema,
})

worker.sync("currentSprintsSync", {
  database: currentSprints,
  mode: "replace",
  schedule: "15m",
  execute: async (state: CurrentSprintSyncState | undefined) => {
    const boards = state?.boards ?? (await fetchBoardRefs())

    const boardIndex = state?.boardIndex ?? 0
    const startAt = state?.startAt ?? 0
    const board = boards[boardIndex]

    if (!board) {
      return { changes: [], hasMore: false }
    }

    await pacer.wait()
    const result = await fetchSprintsForBoard(board.id, startAt, [
      "active",
      "future",
    ])
    const boardLookup = new Map(boards.map(({ id, name }) => [id, name]))
    const changes = result.sprints
      .filter((sprint) => sprint.originBoardId === board.id)
      .map((sprint) => sprintToChange(sprint, boardLookup))

    if (result.hasMore) {
      return {
        changes,
        hasMore: true,
        nextState: {
          boards,
          boardIndex,
          startAt: result.nextStartAt,
        },
      }
    }

    const nextBoard = boardIndex + 1
    if (nextBoard < boards.length) {
      return {
        changes,
        hasMore: true,
        nextState: { boards, boardIndex: nextBoard, startAt: 0 },
      }
    }

    return { changes, hasMore: false }
  },
})

// ---------------------------------------------------------------------------
// All Sprints — daily sprint performance reconstructed from Jira history
// ---------------------------------------------------------------------------

type AllSprintsLoadState = {
  phase: "load-sprints"
  boards: BoardRef[]
  fieldConfig: IssueFieldConfig
  boardIndex: number
  startAt: number
  sprints: JiraSprint[]
}

type AllSprintsAnalyzeState = {
  phase: "analyze"
  boards: BoardRef[]
  fieldConfig: IssueFieldConfig
  boardIndex: number
  sprints: JiraSprint[]
  sprintNamesById: Record<string, string>
  sprintIndex: number
  boardConfig: JiraBoardConfiguration
  priorSprintVelocities: number[]
}

type AllSprintsSyncState = AllSprintsLoadState | AllSprintsAnalyzeState

const allSprints = worker.database("allSprints", {
  type: "managed",
  initialTitle: ALL_SPRINTS_INITIAL_TITLE,
  primaryKeyProperty: ALL_SPRINTS_PRIMARY_KEY,
  schema: allSprintsSchema,
})

function nextBoardLoadState(
  state: AllSprintsSyncState,
  boardIndex: number
): AllSprintsLoadState {
  return {
    phase: "load-sprints",
    boards: state.boards,
    fieldConfig: state.fieldConfig,
    boardIndex,
    startAt: 0,
    sprints: [],
  }
}

worker.sync("allSprintsSync", {
  database: allSprints,
  mode: "replace",
  schedule: "1d",
  execute: async (previousState: AllSprintsSyncState | undefined) => {
    let state = previousState

    if (!state) {
      const boards = await fetchBoardRefs()
      await pacer.wait()
      const fieldConfig = await fetchIssueFieldConfig()
      state = {
        phase: "load-sprints",
        boards,
        fieldConfig,
        boardIndex: 0,
        startAt: 0,
        sprints: [],
      }
    }

    const board = state.boards[state.boardIndex]
    if (!board) return { changes: [], hasMore: false }

    if (state.phase === "load-sprints") {
      await pacer.wait()
      const page = await fetchSprintsForBoard(board.id, state.startAt)
      const allBoardSprints = [
        ...state.sprints,
        ...page.sprints.filter((sprint) => sprint.originBoardId === board.id),
      ]

      if (page.hasMore) {
        return {
          changes: [],
          hasMore: true,
          nextState: {
            ...state,
            startAt: page.nextStartAt,
            sprints: allBoardSprints,
          },
        }
      }

      const sprintNamesById = Object.fromEntries(
        allBoardSprints.map((sprint) => [String(sprint.id), sprint.name])
      )
      const analyzableSprints = allBoardSprints
        .filter(
          (sprint) =>
            (sprint.state === "active" || sprint.state === "closed") &&
            Boolean(sprint.startDate && sprint.endDate)
        )
        .sort((left, right) => {
          if (left.state !== right.state) {
            return left.state === "active" ? 1 : -1
          }
          const leftDate = left.completeDate ?? left.startDate ?? ""
          const rightDate = right.completeDate ?? right.startDate ?? ""
          return leftDate.localeCompare(rightDate)
        })

      if (analyzableSprints.length === 0) {
        const nextBoardIndex = state.boardIndex + 1
        if (nextBoardIndex >= state.boards.length) {
          return { changes: [], hasMore: false }
        }
        return {
          changes: [],
          hasMore: true,
          nextState: nextBoardLoadState(state, nextBoardIndex),
        }
      }

      await pacer.wait()
      const boardConfig = await fetchBoardConfiguration(board.id)
      const nextState: AllSprintsAnalyzeState = {
        phase: "analyze",
        boards: state.boards,
        fieldConfig: state.fieldConfig,
        boardIndex: state.boardIndex,
        sprints: analyzableSprints,
        sprintNamesById,
        sprintIndex: 0,
        boardConfig,
        priorSprintVelocities: [],
      }
      return {
        changes: [],
        hasMore: true,
        nextState,
      }
    }

    const sprint = state.sprints[state.sprintIndex]
    if (!sprint) {
      const nextBoardIndex = state.boardIndex + 1
      if (nextBoardIndex >= state.boards.length) {
        return { changes: [], hasMore: false }
      }
      return {
        changes: [],
        hasMore: true,
        nextState: nextBoardLoadState(state, nextBoardIndex),
      }
    }

    const evaluatedAt = new Date().toISOString()
    const input = await fetchSprintAnalyticsInput({
      sprint,
      boardName: board.name,
      boardConfig: state.boardConfig,
      sprintFieldId: state.fieldConfig.sprintField,
      fallbackEstimateFieldId: state.fieldConfig.storyPointsFields[0],
      storyPointFieldIds: state.fieldConfig.storyPointsFields,
      priorSprintVelocities: state.priorSprintVelocities,
      evaluatedAt,
      baseUrl: getBaseUrl(),
      sprintNamesById: state.sprintNamesById,
      waitFn: () => pacer.wait(),
    })
    const metrics = calculateSprintAnalytics(input)
    const changes = [sprintAnalyticsToChange(input)]
    const priorSprintVelocities =
      sprint.state === "closed"
        ? [metrics.velocity, ...state.priorSprintVelocities].slice(0, 5)
        : state.priorSprintVelocities
    const nextSprintIndex = state.sprintIndex + 1

    if (nextSprintIndex < state.sprints.length) {
      return {
        changes,
        hasMore: true,
        nextState: {
          ...state,
          sprintIndex: nextSprintIndex,
          priorSprintVelocities,
        },
      }
    }

    const nextBoardIndex = state.boardIndex + 1
    if (nextBoardIndex < state.boards.length) {
      return {
        changes,
        hasMore: true,
        nextState: nextBoardLoadState(state, nextBoardIndex),
      }
    }

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
  schedule: "1d",
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
