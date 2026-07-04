// Todoist remains the task system of record. Mutable inventories are first
// discovered, then published only when a second traversal reproduces the same
// identities. Two replacement syncs publish:
//   1. Tasks    — every active task, classified for daily triage
//   2. Projects — active project metadata plus open/recent work summaries

import { Worker } from "@notionhq/workers"

import {
  aggregateCompletions,
  aggregateTasks,
  INITIAL_TITLE as PROJECTS_TITLE,
  MAX_AGGREGATED_ITEMS,
  PRIMARY_KEY as PROJECTS_PK,
  projectSchema,
  projectToChange,
} from "./projects.js"
import {
  assertExpectedTodoistUserId,
  CursorPaginationError,
  currentProjectSummaryState,
  currentTaskSyncState,
  getExpectedTodoistUserId,
  nextProjectSummaryState,
  nextTaskSyncState,
  restartProjectSummaryState,
  restartTaskSyncState,
  type ProjectSummaryState,
  type TaskSyncState,
} from "./sync-state.js"
import {
  INITIAL_TITLE as TASKS_TITLE,
  PRIMARY_KEY as TASKS_PK,
  taskSchema,
  taskToChange,
} from "./tasks.js"
import {
  createTodoistClient,
  InvalidCursorError,
  type TodoistClient,
} from "./todoist.js"

const worker = new Worker()

// Todoist publishes endpoint-specific limits rather than one general REST
// budget. Share a conservative pace across both capabilities.
const pacer = worker.pacer("todoist", {
  allowedRequests: 60,
  intervalMs: 60_000,
})
const todoist = createTodoistClient({ beforeRequest: () => pacer.wait() })

type ExpectedUserProvider = () => string

function appendIds(
  prior: ReadonlyArray<string>,
  candidates: ReadonlyArray<string>,
  resource: string
): string[] {
  const seen = new Set(prior)
  for (const id of candidates) {
    if (seen.has(id)) {
      throw new CursorPaginationError(
        `Todoist ${resource} snapshot repeated ${id}.`
      )
    }
    seen.add(id)
    if (seen.size > MAX_AGGREGATED_ITEMS) {
      throw new Error(
        `Todoist ${resource} snapshot exceeded ${MAX_AGGREGATED_ITEMS} records.`
      )
    }
  }
  return [...seen]
}

function assertExpectedIds(
  expectedIds: ReadonlyArray<string>,
  candidates: ReadonlyArray<string>,
  resource: string
): void {
  const expected = new Set(expectedIds)
  if (candidates.some((id) => !expected.has(id))) {
    throw new CursorPaginationError(
      `Todoist ${resource} identities changed between discovery and publish.`
    )
  }
}

export async function executeTasks(
  previousState: TaskSyncState | undefined,
  client: TodoistClient = todoist,
  readExpectedUserId: ExpectedUserProvider = () => getExpectedTodoistUserId(),
  now: Date | string = new Date()
) {
  const user = await client.fetchAuthenticatedUser()
  assertExpectedTodoistUserId(user.id, readExpectedUserId())
  const state = currentTaskSyncState(previousState, user.id, user.timeZone, now)

  let page
  try {
    page = await client.fetchTasksPage(state.cursor)
  } catch (error) {
    if (error instanceof InvalidCursorError && state.cursor) {
      return {
        changes: [],
        hasMore: true as const,
        nextState: restartTaskSyncState(state),
      }
    }
    throw error
  }

  const pageIds = page.resources.map((task) => task.id)
  let seenTaskIds: string[]
  let nextState: TaskSyncState | undefined
  try {
    if (state.phase === "publish") {
      assertExpectedIds(state.expectedTaskIds, pageIds, "task")
    }
    seenTaskIds = appendIds(state.seenTaskIds, pageIds, "active-task")
    nextState = nextTaskSyncState(state, page.nextCursor, seenTaskIds)
  } catch (error) {
    if (error instanceof CursorPaginationError) {
      return {
        changes: [],
        hasMore: true as const,
        nextState: restartTaskSyncState(state),
      }
    }
    throw error
  }

  const changes =
    state.phase === "publish"
      ? page.resources.map((task) =>
          taskToChange(task, state.timeZone, state.observedAt)
        )
      : []
  return nextState
    ? { changes, hasMore: true as const, nextState }
    : { changes, hasMore: false as const }
}

function restartProjectResult(state: ProjectSummaryState) {
  return {
    changes: [],
    hasMore: true as const,
    nextState: restartProjectSummaryState(state),
  }
}

export async function executeProjects(
  previousState: ProjectSummaryState | undefined,
  client: TodoistClient = todoist,
  readExpectedUserId: ExpectedUserProvider = () => getExpectedTodoistUserId(),
  now: Date | string = new Date()
) {
  const user = await client.fetchAuthenticatedUser()
  assertExpectedTodoistUserId(user.id, readExpectedUserId())
  const state = currentProjectSummaryState(
    previousState,
    user.id,
    user.timeZone,
    now
  )

  if (state.phase === "taskDiscovery" || state.phase === "tasks") {
    let page
    try {
      page = await client.fetchTasksPage(state.cursor)
    } catch (error) {
      if (error instanceof InvalidCursorError && state.cursor) {
        return restartProjectResult(state)
      }
      throw error
    }
    try {
      const pageIds = page.resources.map((task) => task.id)
      if (state.phase === "taskDiscovery") {
        const seenTaskIds = appendIds(
          state.seenTaskIds,
          pageIds,
          "project active-task discovery"
        )
        const nextState = nextProjectSummaryState(state, page.nextCursor, {
          seenTaskIds,
        })
        if (!nextState) {
          throw new Error(
            "Todoist project summary ended during task discovery."
          )
        }
        return { changes: [], hasMore: true as const, nextState }
      }

      assertExpectedIds(state.expectedTaskIds, pageIds, "active-task")
      appendIds(state.seenTaskIds, pageIds, "project active-task")
      const aggregated = aggregateTasks(
        state.aggregates,
        state.seenTaskIds,
        page.resources,
        state.timeZone,
        state.observedAt
      )
      const nextState = nextProjectSummaryState(state, page.nextCursor, {
        aggregates: aggregated.aggregates,
        seenTaskIds: aggregated.seenTaskIds,
      })
      if (!nextState) {
        throw new Error("Todoist project summary ended during active tasks.")
      }
      return { changes: [], hasMore: true as const, nextState }
    } catch (error) {
      if (error instanceof CursorPaginationError) {
        return restartProjectResult(state)
      }
      throw error
    }
  }

  if (state.phase === "completions") {
    let page
    try {
      page = await client.fetchCompletedTasksPage({
        since: state.completionSince,
        until: state.completionUntil,
        cursor: state.cursor,
      })
    } catch (error) {
      if (error instanceof InvalidCursorError && state.cursor) {
        return restartProjectResult(state)
      }
      throw error
    }
    const aggregated = aggregateCompletions(
      state.aggregates,
      state.seenCompletionIds,
      page.resources,
      state.completionSince,
      state.completionUntil
    )
    try {
      const nextState = nextProjectSummaryState(state, page.nextCursor, {
        aggregates: aggregated.aggregates,
        seenCompletionIds: aggregated.seenCompletionIds,
      })
      if (!nextState) {
        throw new Error("Todoist project summary ended before projects.")
      }
      return { changes: [], hasMore: true as const, nextState }
    } catch (error) {
      if (error instanceof CursorPaginationError) {
        return restartProjectResult(state)
      }
      throw error
    }
  }

  let page
  try {
    page = await client.fetchProjectsPage(state.cursor)
  } catch (error) {
    if (error instanceof InvalidCursorError && state.cursor) {
      return restartProjectResult(state)
    }
    throw error
  }

  const pageIds = page.resources.map((project) => project.id)
  if (state.phase === "projectDiscovery") {
    try {
      const seenProjectIds = appendIds(
        state.seenProjectIds,
        pageIds,
        "project discovery"
      )
      const nextState = nextProjectSummaryState(state, page.nextCursor, {
        seenProjectIds,
      })
      if (!nextState) {
        throw new Error("Todoist project summary ended during discovery.")
      }
      return { changes: [], hasMore: true as const, nextState }
    } catch (error) {
      if (error instanceof CursorPaginationError) {
        return restartProjectResult(state)
      }
      throw error
    }
  }

  let seenProjectIds: string[]
  try {
    assertExpectedIds(state.expectedProjectIds, pageIds, "project")
    seenProjectIds = appendIds(state.seenProjectIds, pageIds, "project publish")
  } catch (error) {
    if (error instanceof CursorPaginationError) {
      return restartProjectResult(state)
    }
    throw error
  }
  const remainingAggregates = structuredClone(state.aggregates)
  const changes = page.resources.map((project) => {
    const change = projectToChange(
      project,
      remainingAggregates[project.id],
      state.observedAt,
      state.timeZone
    )
    delete remainingAggregates[project.id]
    return change
  })

  let nextState: ProjectSummaryState | undefined
  try {
    if (
      !page.nextCursor &&
      Object.values(remainingAggregates).some(
        (aggregate) => aggregate.openTasks > 0
      )
    ) {
      throw new CursorPaginationError(
        "Todoist project inventory omitted a project referenced by an active task."
      )
    }
    nextState = nextProjectSummaryState(state, page.nextCursor, {
      aggregates: remainingAggregates,
      seenProjectIds,
    })
  } catch (error) {
    if (error instanceof CursorPaginationError) {
      return restartProjectResult(state)
    }
    throw error
  }
  return nextState
    ? { changes, hasMore: true as const, nextState }
    : { changes, hasMore: false as const }
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
  schedule: "1h",
  execute: (state: ProjectSummaryState | undefined) => executeProjects(state),
})

const tasks = worker.database("tasks", {
  type: "managed",
  initialTitle: TASKS_TITLE,
  primaryKeyProperty: TASKS_PK,
  schema: taskSchema,
})

worker.sync("tasksSync", {
  database: tasks,
  mode: "replace",
  schedule: "15m",
  execute: (state: TaskSyncState | undefined) => executeTasks(state),
})

export default worker
