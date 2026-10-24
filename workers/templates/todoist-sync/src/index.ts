// Register the Todoist databases and their replacement schedules.

import { Worker } from "@notionhq/workers"

import {
  INITIAL_TITLE as PROJECTS_TITLE,
  PRIMARY_KEY as PROJECTS_PK,
  projectSchema,
} from "./projects.js"
import {
  executeProjects,
  executeTasks,
  type ProjectSyncState,
  type TaskSyncState,
} from "./sync.js"
import {
  INITIAL_TITLE as TASKS_TITLE,
  PRIMARY_KEY as TASKS_PK,
  taskSchema,
} from "./tasks.js"
import { createTodoistClient } from "./todoist.js"

const worker = new Worker()

// Todoist publishes endpoint-specific limits rather than one general REST
// budget. Share a conservative pace across both capabilities.
const pacer = worker.pacer("todoist", {
  allowedRequests: 60,
  intervalMs: 60_000,
})
const todoist = createTodoistClient({ beforeRequest: () => pacer.wait() })

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
  execute: (state: ProjectSyncState | undefined) =>
    executeProjects(state, todoist),
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
  execute: (state: TaskSyncState | undefined) => executeTasks(state, todoist),
})

export default worker
