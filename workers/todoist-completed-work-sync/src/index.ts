// Todoist completed work — a durable record of finished tasks rather than an
// active-task mirror. Three sync capabilities maintain two managed databases:
//   1. Completed Work — scheduled updates plus a manual historical replay
//   2. Projects       — last-known active and archived project context

import { Worker } from "@notionhq/workers"

import {
  completedTaskToChange,
  completedWorkSchema,
  dedupeCompletedTasks,
  INITIAL_TITLE as COMPLETED_WORK_TITLE,
  PRIMARY_KEY as COMPLETED_WORK_PK,
} from "./completed-work.js"
import {
  INITIAL_TITLE as PROJECTS_TITLE,
  PRIMARY_KEY as PROJECTS_PK,
  projectSchema,
  projectToChange,
} from "./projects.js"
import {
  currentCompletedWindow,
  currentProjectsSyncState,
  getTodoistSyncConfig,
  nextCompletedSyncState,
  nextProjectsSyncState,
  type CompletedSyncState,
  type ProjectsSyncState,
  type TodoistSyncConfig,
} from "./sync-state.js"
import { createTodoistClient, type TodoistClient } from "./todoist.js"

const worker = new Worker()

// Todoist publishes backoff metadata but not one general REST request budget.
// Share a deliberately conservative pace across the three capabilities.
const pacer = worker.pacer("todoist", {
  allowedRequests: 60,
  intervalMs: 60_000,
})
const todoist = createTodoistClient({ beforeRequest: () => pacer.wait() })

type ConfigProvider = () => TodoistSyncConfig

export async function executeCompletedWork(
  previousState: CompletedSyncState | undefined,
  client: TodoistClient = todoist,
  readConfig: ConfigProvider = () => getTodoistSyncConfig(),
  now: Date | string = new Date()
) {
  const authenticatedUser = await client.fetchAuthenticatedUser()
  const state = currentCompletedWindow(
    previousState,
    readConfig(),
    authenticatedUser.id,
    now
  )
  const page = await client.fetchCompletedTasksPage({
    since: state.windowSince,
    until: state.windowUntil,
    cursor: state.cursor,
  })
  const changes = dedupeCompletedTasks(page.resources)
    // Todoist's endpoint does not promise deletion or reopen tombstones. Keep
    // the journal durable instead of translating a tombstone into data loss.
    .filter((task) => !task.isDeleted)
    .map((task) => completedTaskToChange(task, authenticatedUser.timeZone))
  const nextState = nextCompletedSyncState(state, page.nextCursor)

  return nextState.phase === "window"
    ? { changes, hasMore: true as const, nextState }
    : { changes, hasMore: false as const, nextState }
}

export async function executeProjects(
  previousState: ProjectsSyncState | undefined,
  client: TodoistClient = todoist
) {
  const authenticatedUser = await client.fetchAuthenticatedUser()
  const state = currentProjectsSyncState(previousState, authenticatedUser.id)
  const page = await client.fetchProjectsPage(state.phase, state.cursor)
  const changes = page.resources
    .filter((project) => !project.isDeleted)
    .map((project) => projectToChange(project, state.phase))
  const nextState = nextProjectsSyncState(state, page.nextCursor)

  return nextState.phase === "checkpoint"
    ? { changes, hasMore: false as const, nextState }
    : { changes, hasMore: true as const, nextState }
}

const projects = worker.database("projects", {
  type: "managed",
  initialTitle: PROJECTS_TITLE,
  primaryKeyProperty: PROJECTS_PK,
  schema: projectSchema,
})

worker.sync("projectsSync", {
  database: projects,
  mode: "incremental",
  schedule: "1h",
  execute: (state: ProjectsSyncState | undefined) => executeProjects(state),
})

const completedWork = worker.database("completedWork", {
  type: "managed",
  initialTitle: COMPLETED_WORK_TITLE,
  primaryKeyProperty: COMPLETED_WORK_PK,
  schema: completedWorkSchema,
})

worker.sync("completedWorkSync", {
  database: completedWork,
  mode: "incremental",
  schedule: "15m",
  execute: (state: CompletedSyncState | undefined) =>
    executeCompletedWork(state),
})

// Reset this capability's state before triggering it to replay the configured
// history start. Incremental mode refreshes provider fields without deleting
// user-enriched rows that Todoist no longer returns.
worker.sync("completedWorkBackfill", {
  database: completedWork,
  mode: "incremental",
  schedule: "manual",
  execute: (state: CompletedSyncState | undefined) =>
    executeCompletedWork(state),
})

export default worker
