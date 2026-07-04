import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import test from "node:test"

import { RateLimitError } from "@notionhq/workers"

import {
  classifyDue,
  durationMinutes,
  optionLabel,
  optionLabels,
  todoistProjectUrl,
  todoistTaskUrl,
} from "./src/helpers.js"
import worker, { executeProjects, executeTasks } from "./src/index.js"
import {
  aggregateCompletions,
  aggregateTasks,
  projectSchema,
  projectToChange,
  type ProjectAggregateMap,
} from "./src/projects.js"
import {
  assertExpectedTodoistUserId,
  COMPLETION_LOOKBACK_MS,
  CONSISTENCY_BUFFER_MS,
  CursorPaginationError,
  currentProjectSummaryState,
  currentTaskSyncState,
  nextProjectSummaryState,
  nextTaskSyncState,
  restartProjectSummaryState,
  restartTaskSyncState,
  type ProjectSummaryState,
} from "./src/sync-state.js"
import { taskSchema, taskToChange } from "./src/tasks.js"
import {
  createTodoistClient,
  InvalidCursorError,
  MAX_ERROR_RESPONSE_BYTES,
  parseRetryAfterSeconds,
  TODOIST_PAGE_SIZE,
  type TodoistClient,
  type TodoistCompletedTask,
  type TodoistProject,
  type TodoistTask,
} from "./src/todoist.js"

const AUTHENTICATED_USER = {
  id: "user-1",
  timeZone: "America/New_York",
}
const EXPECTED_USER = () => AUTHENTICATED_USER.id
const NOW = "2026-07-04T16:00:00.000Z"
const COMPLETION_SINCE = "2026-06-27T15:59:00.000Z"
const COMPLETION_UNTIL = "2026-07-04T15:59:00.000Z"

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve("fixtures", name), "utf8")) as unknown
}

function propertyText(value: unknown): string {
  return JSON.stringify(value)
}

function assertPropertyContains(value: unknown, expected: string): void {
  assert.match(
    propertyText(value),
    new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  )
}

function client(overrides: Partial<TodoistClient> = {}): TodoistClient {
  return {
    fetchAuthenticatedUser: async () => AUTHENTICATED_USER,
    fetchTasksPage: async () => ({ resources: [], nextCursor: undefined }),
    fetchCompletedTasksPage: async () => ({
      resources: [],
      nextCursor: undefined,
    }),
    fetchProjectsPage: async () => ({ resources: [], nextCursor: undefined }),
    ...overrides,
  }
}

async function parsedTasks(): Promise<TodoistTask[]> {
  const parsed = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async () => Response.json(fixture("tasks-page.json")),
  })
  return (await parsed.fetchTasksPage()).resources
}

async function parsedCompletions(): Promise<TodoistCompletedTask[]> {
  const parsed = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async () => Response.json(fixture("completed-tasks-page.json")),
  })
  return (
    await parsed.fetchCompletedTasksPage({
      since: COMPLETION_SINCE,
      until: COMPLETION_UNTIL,
    })
  ).resources
}

async function parsedProjects(): Promise<TodoistProject[]> {
  const parsed = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async () => Response.json(fixture("projects-active.json")),
  })
  return (await parsed.fetchProjectsPage()).resources
}

test("worker manifest exposes one task view and one project summary", () => {
  assert.deepEqual(
    worker.manifest.databases.map((database) => ({
      key: database.key,
      title: database.config.initialTitle,
      primaryKey: database.config.primaryKeyProperty,
      icon: database.config.schema.databaseIcon,
      firstSix: Object.keys(database.config.schema.properties).slice(0, 6),
    })),
    [
      {
        key: "projects",
        title: "Todoist Projects",
        primaryKey: "Todoist Project ID",
        icon: { type: "notion", icon: "folder", color: "red" },
        firstSix: [
          "Project",
          "Open Tasks",
          "Overdue",
          "Due Next 7 Days",
          "Completed Last 7 Days",
          "Recent Completions",
        ],
      },
      {
        key: "tasks",
        title: "Todoist Tasks",
        primaryKey: "Todoist Task ID",
        icon: { type: "notion", icon: "checkmark-square", color: "red" },
        firstSix: [
          "Task",
          "Due Status",
          "Due",
          "Project",
          "Priority",
          "Labels",
        ],
      },
    ]
  )

  type SyncConfig = {
    databaseKey: string
    mode: string
    schedule: { type: string; intervalMs?: number }
  }
  assert.deepEqual(
    worker.manifest.capabilities.map((capability) => {
      assert.equal(capability._tag, "sync")
      const config = capability.config as SyncConfig
      return {
        key: capability.key,
        databaseKey: config.databaseKey,
        mode: config.mode,
        schedule: config.schedule,
      }
    }),
    [
      {
        key: "projectsSync",
        databaseKey: "projects",
        mode: "replace",
        schedule: { type: "interval", intervalMs: 60 * 60_000 },
      },
      {
        key: "tasksSync",
        databaseKey: "tasks",
        mode: "replace",
        schedule: { type: "interval", intervalMs: 15 * 60_000 },
      },
    ]
  )
  assert.deepEqual(worker.manifest.pacers, [
    {
      key: "todoist",
      config: { allowedRequests: 60, intervalMs: 60_000 },
    },
  ])
})

test("schemas keep workflow fields ahead of detail and source metadata", () => {
  assert.deepEqual(Object.keys(taskSchema.properties), [
    "Task",
    "Due Status",
    "Due",
    "Project",
    "Priority",
    "Labels",
    "Deadline",
    "Planned Duration (min)",
    "Open in Todoist",
    "Description",
    "Recurring",
    "Is Subtask",
    "Created",
    "Updated",
    "Todoist Task ID",
  ])
  assert.deepEqual(Object.keys(projectSchema.properties), [
    "Project",
    "Open Tasks",
    "Overdue",
    "Due Next 7 Days",
    "Completed Last 7 Days",
    "Recent Completions",
    "Next Deadline",
    "Next Due",
    "Unscheduled",
    "P1 Tasks",
    "Planned Minutes Next 7 Days",
    "Last Completed",
    "Description",
    "Open in Todoist",
    "Updated",
    "Todoist Project ID",
  ])
})

test("due classification is pinned, timezone-aware, and boundary exact", () => {
  const classify = (date: string | null) =>
    classifyDue(date ? { date } : null, AUTHENTICATED_USER.timeZone, NOW)
  assert.equal(classify(null).status, "No due date")
  assert.equal(classify("2026-07-03").status, "Overdue")
  assert.equal(classify("2026-07-04").status, "Today")
  assert.equal(classify("2026-07-11").status, "Next 7 days")
  assert.equal(classify("2026-07-12").status, "Later")
  assert.equal(classify("2026-07-04T15:00:00Z").status, "Overdue")
  assert.equal(classify("2026-07-04T11:00:00").status, "Overdue")
  assert.equal(classify("2026-07-04T13:00:00").status, "Today")
  assert.equal(classify("2026-07-08").dueNextSevenDays, true)
  assert.equal(classify("2026-07-03").dueNextSevenDays, false)
  assert.throws(() => classify("tomorrow"), /due timestamp is invalid/)
})

test("task transform answers daily triage and clears absent fields", async () => {
  const tasks = await parsedTasks()
  const overdue = taskToChange(tasks[0]!, AUTHENTICATED_USER.timeZone, NOW)
  assert.equal(overdue.key, "task-overdue")
  assert.equal(overdue.upstreamUpdatedAt, NOW)
  assert.deepEqual(overdue.icon, {
    type: "notion",
    icon: "checkmark-square",
    color: "red",
  })
  assert.deepEqual(
    Object.keys(overdue.properties),
    Object.keys(taskSchema.properties)
  )
  assertPropertyContains(overdue.properties.Task, "Resolve launch blocker")
  assertPropertyContains(overdue.properties["Due Status"], "Overdue")
  assertPropertyContains(overdue.properties.Project, "project-launch")
  assertPropertyContains(overdue.properties.Priority, "P1 · Urgent")
  assertPropertyContains(overdue.properties.Labels, "needs-review")
  assertPropertyContains(overdue.properties["Planned Duration (min)"], "30")
  assertPropertyContains(
    overdue.properties["Open in Todoist"],
    todoistTaskUrl("task-overdue")
  )

  const unscheduled = taskToChange(tasks[2]!, AUTHENTICATED_USER.timeZone, NOW)
  assertPropertyContains(unscheduled.properties["Due Status"], "No due date")
  assert.deepEqual(unscheduled.properties.Due, [])
  assert.deepEqual(unscheduled.properties.Deadline, [])
  assert.deepEqual(unscheduled.properties.Labels, [])
  assert.deepEqual(unscheduled.properties["Planned Duration (min)"], [])
  assertPropertyContains(unscheduled.properties["Is Subtask"], "No")

  const fixedTime = taskToChange(
    {
      ...tasks[1]!,
      due: {
        date: "2026-07-05T01:00:00Z",
        isRecurring: false,
      },
    },
    AUTHENTICATED_USER.timeZone,
    NOW
  )
  assertPropertyContains(fixedTime.properties["Due Status"], "Today")
  assertPropertyContains(fixedTime.properties.Due, "2026-07-04")
  assertPropertyContains(fixedTime.properties.Due, "21:00")
  assertPropertyContains(fixedTime.properties.Due, "America/New_York")
})

test("project aggregation combines open work and bounded recent completions", async () => {
  const tasks = await parsedTasks()
  const completions = await parsedCompletions()
  const active = aggregateTasks({}, [], tasks, AUTHENTICATED_USER.timeZone, NOW)
  const complete = aggregateCompletions(
    active.aggregates,
    [],
    completions,
    COMPLETION_SINCE,
    COMPLETION_UNTIL
  )

  assert.deepEqual(active.seenTaskIds, [
    "task-overdue",
    "task-upcoming",
    "task-unscheduled",
  ])
  assert.deepEqual(complete.seenCompletionIds, [
    "completed-brief:2026-07-03T19:00:00Z",
    "completed-qa:2026-07-02T20:00:00Z",
    "completed-runbook:2026-07-01T15:00:00Z",
  ])

  const launch = complete.aggregates["project-launch"]!
  assert.equal(launch.openTasks, 2)
  assert.equal(launch.overdue, 1)
  assert.equal(launch.dueNextSevenDays, 1)
  assert.equal(launch.unscheduled, 0)
  assert.equal(launch.p1Tasks, 1)
  assert.equal(launch.plannedMinutesNextSevenDays, 90)
  assert.equal(launch.nextDue?.date, "2026-07-08T09:00:00")
  assert.equal(launch.nextDeadline, "2026-07-05")
  assert.equal(launch.completedLastSevenDays, 2)
  assert.deepEqual(
    launch.recentCompletions.map((item) => item.title),
    ["Approve launch brief", "Finish release QA"]
  )
  assert.equal(launch.lastCompleted, "2026-07-03T19:00:00Z")

  const operations = complete.aggregates["project-operations"]!
  assert.equal(operations.openTasks, 1)
  assert.equal(operations.unscheduled, 1)
  assert.equal(operations.p1Tasks, 1)
  assert.equal(operations.completedLastSevenDays, 1)

  const deleted = aggregateCompletions(
    {},
    [],
    [{ ...completions[0]!, isDeleted: true }],
    COMPLETION_SINCE,
    COMPLETION_UNTIL
  )
  assert.deepEqual(deleted.aggregates, {})
  assert.deepEqual(deleted.seenCompletionIds, [])

  assert.throws(
    () =>
      aggregateTasks(
        active.aggregates,
        active.seenTaskIds,
        [tasks[0]!],
        AUTHENTICATED_USER.timeZone,
        NOW
      ),
    /repeated task-overdue/
  )
  assert.throws(
    () =>
      aggregateCompletions(
        complete.aggregates,
        complete.seenCompletionIds,
        [completions[0]!],
        COMPLETION_SINCE,
        COMPLETION_UNTIL
      ),
    /repeated completed-brief/
  )
  assert.throws(
    () =>
      aggregateCompletions(
        {},
        [],
        [
          {
            ...completions[0]!,
            completedAt: "2026-06-27T15:58:59.999Z",
          },
        ],
        COMPLETION_SINCE,
        COMPLETION_UNTIL
      ),
    /outside the requested window/
  )
})

test("project transform exposes review signals without a completion archive", async () => {
  const tasks = await parsedTasks()
  const completions = await parsedCompletions()
  const projects = await parsedProjects()
  const active = aggregateTasks({}, [], tasks, AUTHENTICATED_USER.timeZone, NOW)
  const complete = aggregateCompletions(
    active.aggregates,
    [],
    completions,
    COMPLETION_SINCE,
    COMPLETION_UNTIL
  )
  const change = projectToChange(
    projects[0]!,
    complete.aggregates[projects[0]!.id],
    NOW,
    AUTHENTICATED_USER.timeZone
  )
  assert.equal(change.key, "project-launch")
  assert.equal(change.upstreamUpdatedAt, NOW)
  assert.deepEqual(change.icon, {
    type: "notion",
    icon: "folder",
    color: "red",
  })
  assert.deepEqual(
    Object.keys(change.properties),
    Object.keys(projectSchema.properties)
  )
  assertPropertyContains(change.properties.Project, "Product Launch")
  assertPropertyContains(change.properties["Open Tasks"], "2")
  assertPropertyContains(change.properties.Overdue, "1")
  assertPropertyContains(change.properties["Due Next 7 Days"], "1")
  assertPropertyContains(change.properties["Completed Last 7 Days"], "2")
  assertPropertyContains(change.properties["Next Deadline"], "2026-07-05")
  assertPropertyContains(
    change.properties["Recent Completions"],
    "Approve launch brief"
  )
  assertPropertyContains(
    change.properties["Open in Todoist"],
    todoistProjectUrl("project-launch")
  )

  const many: TodoistCompletedTask[] = Array.from(
    { length: 7 },
    (_, index) => ({
      id: `completion-${index}`,
      projectId: "project-launch",
      content: `Completed item ${index}`,
      completedAt: `2026-07-0${index + 1}T12:00:00Z`,
      isDeleted: false,
    })
  )
  const bounded = aggregateCompletions(
    {},
    [],
    many,
    "2026-06-30T00:00:00Z",
    "2026-07-08T00:00:00Z"
  ).aggregates["project-launch"]!
  assert.equal(bounded.recentCompletions.length, 5)
  const boundedChange = projectToChange(
    projects[0]!,
    bounded,
    NOW,
    AUTHENTICATED_USER.timeZone
  )
  assertPropertyContains(
    boundedChange.properties["Recent Completions"],
    "+2 more"
  )

  const empty = projectToChange(
    projects[1]!,
    undefined,
    NOW,
    AUTHENTICATED_USER.timeZone
  )
  assertPropertyContains(empty.properties["Open Tasks"], "0")
  assert.deepEqual(empty.properties["Recent Completions"], [])
  assert.deepEqual(empty.properties["Next Due"], [])
})

test("helper normalization is bounded and Todoist-specific", () => {
  assert.equal(optionLabel("Launch, 2026"), "Launch， 2026")
  assert.equal(optionLabels("labels", ["A", "a", "B"]).length, 2)
  assert.equal(optionLabel("x".repeat(101))?.length, 100)
  assert.equal(durationMinutes({ amount: 2, unit: "day" }), 2_880)
  assert.equal(todoistTaskUrl("a/b"), "https://app.todoist.com/app/task/a%2Fb")
  assert.equal(
    todoistProjectUrl("a/b"),
    "https://app.todoist.com/app/project/a%2Fb"
  )
})

test("task state pins observation time and bounds cursor restart", () => {
  const initial = currentTaskSyncState(
    undefined,
    AUTHENTICATED_USER.id,
    AUTHENTICATED_USER.timeZone,
    NOW
  )
  const page = nextTaskSyncState(initial, "tasks.page-2", ["task-1"])!
  assert.equal(initial.phase, "discovery")
  assert.equal(page.cursor, "tasks.page-2")
  assert.equal(page.pageCount, 1)
  assert.equal(
    currentTaskSyncState(
      page,
      AUTHENTICATED_USER.id,
      AUTHENTICATED_USER.timeZone,
      "2026-07-05T16:00:00Z"
    ).observedAt,
    NOW
  )
  assert.throws(
    () => nextTaskSyncState(page, "tasks.page-2", ["task-1", "task-2"]),
    CursorPaginationError
  )
  const restarted = restartTaskSyncState(page)
  assert.equal(restarted.phase, "discovery")
  assert.equal(restarted.restartCount, 1)
  assert.equal(restarted.cursor, undefined)
  assert.deepEqual(restarted.seenTaskIds, [])
  assert.deepEqual(restarted.expectedTaskIds, [])
  assert.throws(() => restartTaskSyncState(restarted), /failed again/)
  const publish = nextTaskSyncState(initial, undefined, ["task-1"])!
  assert.equal(publish.phase, "publish")
  assert.deepEqual(publish.expectedTaskIds, ["task-1"])
  assert.deepEqual(publish.seenTaskIds, [])
  assert.equal(nextTaskSyncState(publish, undefined, ["task-1"]), undefined)
  assert.throws(
    () => nextTaskSyncState(publish, undefined, []),
    /identities changed/
  )
})

test("project state pins one seven-day aggregation before publishing", () => {
  const initial = currentProjectSummaryState(
    undefined,
    AUTHENTICATED_USER.id,
    AUTHENTICATED_USER.timeZone,
    NOW
  )
  assert.equal(initial.phase, "taskDiscovery")
  assert.equal(
    Date.parse(initial.completionUntil),
    Date.parse(NOW) - CONSISTENCY_BUFFER_MS
  )
  assert.equal(
    Date.parse(initial.completionUntil) - Date.parse(initial.completionSince),
    COMPLETION_LOOKBACK_MS
  )
  const taskPublish = nextProjectSummaryState(initial, undefined, {
    seenTaskIds: ["task-1"],
  })!
  assert.equal(taskPublish.phase, "tasks")
  assert.deepEqual(taskPublish.expectedTaskIds, ["task-1"])
  const completions = nextProjectSummaryState(taskPublish, undefined, {
    seenTaskIds: ["task-1"],
  })!
  assert.equal(completions.phase, "completions")
  const projectDiscovery = nextProjectSummaryState(completions, undefined)!
  assert.equal(projectDiscovery.phase, "projectDiscovery")
  const projects = nextProjectSummaryState(projectDiscovery, undefined, {
    seenProjectIds: ["project-1"],
  })!
  assert.equal(projects.phase, "projects")
  assert.deepEqual(projects.expectedProjectIds, ["project-1"])
  assert.equal(
    nextProjectSummaryState(projects, undefined, {
      seenProjectIds: ["project-1"],
    }),
    undefined
  )
  assert.throws(
    () => nextProjectSummaryState(projects, undefined),
    /identities changed/
  )
  assert.throws(
    () =>
      nextProjectSummaryState(projects, undefined, {
        seenProjectIds: [""],
      }),
    /empty ID/
  )

  const paged = nextProjectSummaryState(initial, "tasks.page-2")!
  assert.equal(paged.phase, "taskDiscovery")
  assert.equal(paged.cursor, "tasks.page-2")
  const restarted = restartProjectSummaryState(paged)
  assert.equal(restarted.phase, "taskDiscovery")
  assert.equal(restarted.restartCount, 1)
  assert.deepEqual(restarted.aggregates, {})
  assert.throws(() => restartProjectSummaryState(restarted), /failed again/)

  const migrated = currentProjectSummaryState(
    {
      phase: "checkpoint",
      userId: AUTHENTICATED_USER.id,
    } as unknown as ProjectSummaryState,
    AUTHENTICATED_USER.id,
    AUTHENTICATED_USER.timeZone,
    NOW
  )
  assert.equal(migrated.phase, "taskDiscovery")
  assertExpectedTodoistUserId(AUTHENTICATED_USER.id, AUTHENTICATED_USER.id)
  assert.throws(
    () => assertExpectedTodoistUserId("another-user", AUTHENTICATED_USER.id),
    /does not match/
  )
})

test("tasks replacement discovers and publishes the same complete identity set", async () => {
  const tasks = await parsedTasks()
  const cursors: Array<string | undefined> = []
  const source = client({
    async fetchTasksPage(cursor) {
      cursors.push(cursor)
      return cursor
        ? { resources: [tasks[1]!], nextCursor: undefined }
        : { resources: [tasks[0]!], nextCursor: "tasks.page-2" }
    },
  })
  const first = await executeTasks(undefined, source, EXPECTED_USER, NOW)
  assert.equal(first.hasMore, true)
  assert.equal(first.changes.length, 0)
  assert.ok(first.nextState)
  const second = await executeTasks(first.nextState, source, EXPECTED_USER, NOW)
  assert.equal(second.hasMore, true)
  assert.equal(second.changes.length, 0)
  assert.ok(second.nextState)
  assert.equal(second.nextState.phase, "publish")
  const third = await executeTasks(second.nextState, source, EXPECTED_USER, NOW)
  assert.equal(third.hasMore, true)
  assert.equal(third.changes.length, 1)
  assert.ok(third.nextState)
  const fourth = await executeTasks(third.nextState, source, EXPECTED_USER, NOW)
  assert.equal(fourth.hasMore, false)
  assert.equal(fourth.changes.length, 1)
  assert.equal("nextState" in fourth, false)
  assert.deepEqual(cursors, [
    undefined,
    "tasks.page-2",
    undefined,
    "tasks.page-2",
  ])
})

test("tasks replacement fails closed on duplicates and enforces account first", async () => {
  const tasks = await parsedTasks()
  const duplicate = client({
    fetchTasksPage: async () => ({
      resources: [tasks[0]!, tasks[0]!],
      nextCursor: undefined,
    }),
  })
  const duplicateRestart = await executeTasks(
    undefined,
    duplicate,
    EXPECTED_USER,
    NOW
  )
  assert.equal(duplicateRestart.hasMore, true)
  assert.equal(duplicateRestart.nextState.restartCount, 1)
  await assert.rejects(
    () =>
      executeTasks(duplicateRestart.nextState, duplicate, EXPECTED_USER, NOW),
    /failed again/
  )

  const discovery = await executeTasks(
    undefined,
    client({
      fetchTasksPage: async () => ({
        resources: [tasks[0]!],
        nextCursor: undefined,
      }),
    }),
    EXPECTED_USER,
    NOW
  )
  const shifted = await executeTasks(
    discovery.nextState,
    client(),
    EXPECTED_USER,
    NOW
  )
  assert.equal(shifted.hasMore, true)
  assert.equal(shifted.changes.length, 0)
  assert.equal(shifted.nextState.phase, "discovery")
  assert.equal(shifted.nextState.restartCount, 1)

  let taskReads = 0
  const wrongAccount = client({
    fetchAuthenticatedUser: async () => ({
      ...AUTHENTICATED_USER,
      id: "wrong-user",
    }),
    fetchTasksPage: async () => {
      taskReads += 1
      return { resources: [], nextCursor: undefined }
    },
  })
  await assert.rejects(
    () => executeTasks(undefined, wrongAccount, EXPECTED_USER, NOW),
    /does not match/
  )
  assert.equal(taskReads, 0)
})

test("invalid task cursors restart once without completing replacement", async () => {
  const tasks = await parsedTasks()
  const first = await executeTasks(
    undefined,
    client({
      fetchTasksPage: async () => ({
        resources: [tasks[0]!],
        nextCursor: "expired",
      }),
    }),
    EXPECTED_USER,
    NOW
  )
  assert.ok(first.nextState)
  const recovered = await executeTasks(
    first.nextState,
    client({
      fetchTasksPage: async () => {
        throw new InvalidCursorError()
      },
    }),
    EXPECTED_USER,
    NOW
  )
  assert.equal(recovered.hasMore, true)
  assert.equal(recovered.changes.length, 0)
  assert.equal(recovered.nextState.restartCount, 1)
  assert.equal(recovered.nextState.cursor, undefined)
})

test("project replacement aggregates sources before emitting rows", async () => {
  const tasks = await parsedTasks()
  const completions = await parsedCompletions()
  const projects = await parsedProjects()
  const completionOptions: Array<{ since: string; until: string }> = []
  const source = client({
    fetchTasksPage: async (cursor) =>
      cursor
        ? { resources: tasks.slice(1), nextCursor: undefined }
        : { resources: [tasks[0]!], nextCursor: "tasks.page-2" },
    async fetchCompletedTasksPage(options) {
      completionOptions.push(options)
      return options.cursor
        ? { resources: completions.slice(1), nextCursor: undefined }
        : {
            resources: [completions[0]!],
            nextCursor: "completions.page-2",
          }
    },
    fetchProjectsPage: async () => ({
      resources: projects,
      nextCursor: undefined,
    }),
  })

  const taskDiscoveryPage = await executeProjects(
    undefined,
    source,
    EXPECTED_USER,
    NOW
  )
  assert.equal(taskDiscoveryPage.hasMore, true)
  assert.deepEqual(taskDiscoveryPage.changes, [])
  assert.equal(taskDiscoveryPage.nextState.phase, "taskDiscovery")

  const taskDiscoveryDone = await executeProjects(
    taskDiscoveryPage.nextState,
    source,
    EXPECTED_USER,
    NOW
  )
  assert.equal(taskDiscoveryDone.hasMore, true)
  assert.deepEqual(taskDiscoveryDone.changes, [])
  assert.equal(taskDiscoveryDone.nextState.phase, "tasks")

  const taskPublishPage = await executeProjects(
    taskDiscoveryDone.nextState,
    source,
    EXPECTED_USER,
    NOW
  )
  assert.equal(taskPublishPage.hasMore, true)
  assert.deepEqual(taskPublishPage.changes, [])
  assert.equal(taskPublishPage.nextState.phase, "tasks")

  const taskPublishDone = await executeProjects(
    taskPublishPage.nextState,
    source,
    EXPECTED_USER,
    NOW
  )
  assert.equal(taskPublishDone.hasMore, true)
  assert.deepEqual(taskPublishDone.changes, [])
  assert.equal(taskPublishDone.nextState.phase, "completions")

  const firstCompletionPage = await executeProjects(
    taskPublishDone.nextState,
    source,
    EXPECTED_USER,
    NOW
  )
  assert.equal(firstCompletionPage.hasMore, true)
  assert.deepEqual(firstCompletionPage.changes, [])
  assert.equal(firstCompletionPage.nextState.phase, "completions")

  const completionDone = await executeProjects(
    firstCompletionPage.nextState,
    source,
    EXPECTED_USER,
    NOW
  )
  assert.equal(completionDone.hasMore, true)
  assert.deepEqual(completionDone.changes, [])
  assert.equal(completionDone.nextState.phase, "projectDiscovery")

  const projectDiscovery = await executeProjects(
    completionDone.nextState,
    source,
    EXPECTED_USER,
    NOW
  )
  assert.equal(projectDiscovery.hasMore, true)
  assert.deepEqual(projectDiscovery.changes, [])
  assert.equal(projectDiscovery.nextState.phase, "projects")

  const projectPublish = await executeProjects(
    projectDiscovery.nextState,
    source,
    EXPECTED_USER,
    NOW
  )
  assert.equal(projectPublish.hasMore, false)
  assert.equal(projectPublish.changes.length, 2)
  assert.equal("nextState" in projectPublish, false)
  const launch = projectPublish.changes.find(
    (change) => change.key === "project-launch"
  )
  assert.ok(launch && launch.type === "upsert")
  assertPropertyContains(launch.properties.Overdue, "1")
  assertPropertyContains(launch.properties["Completed Last 7 Days"], "2")
  assert.equal(completionOptions.length, 2)
  assert.equal(
    Date.parse(completionOptions[0]!.until) -
      Date.parse(completionOptions[0]!.since),
    COMPLETION_LOOKBACK_MS
  )
})

test("project aggregation restarts from scratch after an expired cursor", async () => {
  const tasks = await parsedTasks()
  const completions = await parsedCompletions()
  const taskDiscovery = await executeProjects(
    undefined,
    client({
      fetchTasksPage: async () => ({ resources: tasks, nextCursor: undefined }),
    }),
    EXPECTED_USER,
    NOW
  )
  const taskPhase = await executeProjects(
    taskDiscovery.nextState,
    client({
      fetchTasksPage: async () => ({ resources: tasks, nextCursor: undefined }),
    }),
    EXPECTED_USER,
    NOW
  )
  const partialCompletions = await executeProjects(
    taskPhase.nextState,
    client({
      fetchCompletedTasksPage: async () => ({
        resources: [completions[0]!],
        nextCursor: "expired",
      }),
    }),
    EXPECTED_USER,
    NOW
  )
  assert.ok(partialCompletions.nextState)
  assert.equal(
    partialCompletions.nextState.aggregates["project-launch"]
      ?.completedLastSevenDays,
    1
  )

  const recovered = await executeProjects(
    partialCompletions.nextState,
    client({
      fetchCompletedTasksPage: async () => {
        throw new InvalidCursorError()
      },
    }),
    EXPECTED_USER,
    NOW
  )
  assert.equal(recovered.hasMore, true)
  assert.deepEqual(recovered.changes, [])
  assert.equal(recovered.nextState.phase, "taskDiscovery")
  assert.equal(recovered.nextState.restartCount, 1)
  assert.deepEqual(recovered.nextState.aggregates, {})
  assert.deepEqual(recovered.nextState.seenTaskIds, [])
  assert.deepEqual(recovered.nextState.seenCompletionIds, [])
})

test("project replacement prunes aggregates while paginating inventory", async () => {
  const aggregate: ProjectAggregateMap = {
    "project-launch": {
      projectId: "project-launch",
      openTasks: 1,
      overdue: 1,
      dueNextSevenDays: 0,
      completedLastSevenDays: 0,
      recentCompletions: [],
      nextDue: null,
      nextDeadline: null,
      unscheduled: 0,
      p1Tasks: 1,
      plannedMinutesNextSevenDays: 0,
      lastCompleted: null,
    },
  }
  const initial = currentProjectSummaryState(
    undefined,
    AUTHENTICATED_USER.id,
    AUTHENTICATED_USER.timeZone,
    NOW
  )
  const taskPublish = nextProjectSummaryState(initial, undefined, {
    aggregates: aggregate,
  })!
  const completions = nextProjectSummaryState(taskPublish, undefined)!
  const projectDiscovery = nextProjectSummaryState(completions, undefined)!
  const projectState = nextProjectSummaryState(projectDiscovery, undefined, {
    seenProjectIds: ["project-launch"],
  })!
  const projects = await parsedProjects()
  const first = await executeProjects(
    projectState,
    client({
      fetchProjectsPage: async () => ({
        resources: [projects[0]!],
        nextCursor: "projects.page-2",
      }),
    }),
    EXPECTED_USER,
    NOW
  )
  assert.equal(first.hasMore, true)
  assert.deepEqual(first.nextState.aggregates, {})
  assert.deepEqual(first.nextState.seenProjectIds, ["project-launch"])

  const completed = await executeProjects(
    first.nextState,
    client(),
    EXPECTED_USER,
    NOW
  )
  assert.equal(completed.hasMore, false)
  assert.deepEqual(completed.changes, [])

  const duplicateRestart = await executeProjects(
    first.nextState,
    client({
      fetchProjectsPage: async () => ({
        resources: [projects[0]!],
        nextCursor: undefined,
      }),
    }),
    EXPECTED_USER,
    NOW
  )
  assert.equal(duplicateRestart.hasMore, true)
  assert.equal(duplicateRestart.nextState.phase, "taskDiscovery")
  assert.equal(duplicateRestart.nextState.restartCount, 1)

  const missingProject: ProjectAggregateMap = {
    "project-missing": {
      ...aggregate["project-launch"]!,
      projectId: "project-missing",
    },
  }
  const missingTaskPublish = nextProjectSummaryState(initial, undefined, {
    aggregates: missingProject,
  })!
  const missingCompletions = nextProjectSummaryState(
    missingTaskPublish,
    undefined
  )!
  const missingDiscovery = nextProjectSummaryState(
    missingCompletions,
    undefined
  )!
  const missingInventory = nextProjectSummaryState(missingDiscovery, undefined)!
  const missingRestart = await executeProjects(
    missingInventory,
    client(),
    EXPECTED_USER,
    NOW
  )
  assert.equal(missingRestart.hasMore, true)
  assert.equal(missingRestart.nextState.phase, "taskDiscovery")
  assert.equal(missingRestart.nextState.restartCount, 1)
})

test("Todoist client pins endpoints, pagination, bearer auth, and pacing", async () => {
  const requests: Array<{ url: URL; init: RequestInit | undefined }> = []
  let pacing = 0
  const api = createTodoistClient({
    beforeRequest: async () => {
      pacing += 1
    },
    getApiToken: () => "secret-test-token",
    fetch: async (input, init) => {
      const url = new URL(String(input))
      requests.push({ url, init })
      if (url.pathname.endsWith("/user")) {
        return Response.json({
          id: AUTHENTICATED_USER.id,
          tz_info: { timezone: AUTHENTICATED_USER.timeZone },
          token: "must-not-be-retained",
        })
      }
      if (url.pathname.includes("/tasks/completed/")) {
        return Response.json(fixture("completed-tasks-page.json"))
      }
      if (url.pathname.endsWith("/tasks")) {
        return Response.json(fixture("tasks-page.json"))
      }
      return Response.json(fixture("projects-active.json"))
    },
  })

  assert.deepEqual(await api.fetchAuthenticatedUser(), AUTHENTICATED_USER)
  assert.equal((await api.fetchTasksPage("tasks.cursor")).resources.length, 3)
  assert.equal(
    (await api.fetchProjectsPage("projects.cursor")).resources.length,
    2
  )
  assert.equal(
    (
      await api.fetchCompletedTasksPage({
        since: "2026-06-27T00:00:00Z",
        until: "2026-07-04T00:00:00Z",
        cursor: "completed.cursor",
      })
    ).resources.length,
    3
  )
  assert.equal(pacing, 4)
  for (const request of requests) {
    assert.equal(
      new Headers(request.init?.headers).get("authorization"),
      "Bearer secret-test-token"
    )
    if (!request.url.pathname.endsWith("/user")) {
      assert.equal(
        request.url.searchParams.get("limit"),
        String(TODOIST_PAGE_SIZE)
      )
    }
  }
  assert.equal(requests[1]!.url.searchParams.get("cursor"), "tasks.cursor")
  assert.equal(requests[2]!.url.searchParams.get("cursor"), "projects.cursor")
  assert.equal(
    requests[3]!.url.searchParams.get("since"),
    "2026-06-27T00:00:00Z"
  )
})

test("Todoist client accepts only safe terminal and nullable response shapes", async () => {
  const empty = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async () => Response.json({ results: [], next_cursor: null }),
  })
  assert.deepEqual(await empty.fetchTasksPage(), {
    resources: [],
    nextCursor: undefined,
  })

  const ambiguousEmptyInventory = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async () => Response.json({ results: [] }),
  })
  await assert.rejects(
    () => ambiguousEmptyInventory.fetchTasksPage(),
    /missing next_cursor/
  )

  const emptyCompletions = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async () => Response.json({ items: [] }),
  })
  assert.deepEqual(
    await emptyCompletions.fetchCompletedTasksPage({
      since: COMPLETION_SINCE,
      until: COMPLETION_UNTIL,
    }),
    { resources: [], nextCursor: undefined }
  )

  const missingCursor = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async () =>
      Response.json({
        results: (fixture("tasks-page.json") as { results: unknown[] }).results,
      }),
  })
  await assert.rejects(
    () => missingCursor.fetchTasksPage(),
    /missing next_cursor/
  )

  const malformed = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async () => Response.json({ results: {}, next_cursor: null }),
  })
  await assert.rejects(
    () => malformed.fetchProjectsPage(),
    /invalid project results/
  )

  const tasks = await parsedTasks()
  assert.deepEqual(tasks[2]!.labels, [])
  assert.equal(tasks[2]!.updatedAt, null)

  const invalidTimestamp = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async () =>
      Response.json({
        items: [
          {
            id: "task-1",
            project_id: "project-1",
            content: "Invalid completion",
            completed_at: "yesterday",
            is_deleted: false,
          },
        ],
        next_cursor: null,
      }),
  })
  await assert.rejects(
    () =>
      invalidTimestamp.fetchCompletedTasksPage({
        since: COMPLETION_SINCE,
        until: COMPLETION_UNTIL,
      }),
    /invalid completed task 0.completed_at/
  )
})

test("HTTP failures are rate-aware, bounded, and never expose credentials", async () => {
  assert.equal(parseRetryAfterSeconds("7"), 7)
  assert.equal(
    parseRetryAfterSeconds(
      "Wed, 21 Oct 2015 07:28:10 GMT",
      Date.parse("2015-10-21T07:28:00Z")
    ),
    10
  )

  const rateLimited = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async () =>
      Response.json(
        { error_tag: "RATE_LIMIT", error_extra: { retry_after: 9 } },
        { status: 429, headers: { "Retry-After": "7" } }
      ),
  })
  await assert.rejects(
    () => rateLimited.fetchTasksPage(),
    (error: unknown) => {
      assert.ok(error instanceof RateLimitError)
      assert.equal(error.retryAfter, 9)
      return true
    }
  )

  const invalidCursor = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async () =>
      Response.json(
        {
          error_tag: "INVALID_ARGUMENT_VALUE",
          error_extra: { argument: "cursor" },
        },
        { status: 400 }
      ),
  })
  await assert.rejects(
    () => invalidCursor.fetchTasksPage("expired"),
    InvalidCursorError
  )

  const secret = "provider-secret-that-must-not-leak"
  const denied = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => secret,
    fetch: async () =>
      Response.json(
        { error_tag: "FORBIDDEN", private_detail: secret },
        { status: 403 }
      ),
  })
  await assert.rejects(
    () => denied.fetchTasksPage(),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.doesNotMatch(error.message, new RegExp(secret))
      assert.match(error.message, /403/)
      return true
    }
  )

  const oversized = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async () =>
      new Response("private upstream body", {
        status: 503,
        headers: { "Content-Length": String(MAX_ERROR_RESPONSE_BYTES + 1) },
      }),
  })
  await assert.rejects(() => oversized.fetchTasksPage(), /safe size limit/)
})

test("Todoist client times out stalled requests without transport leakage", async () => {
  const api = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    requestTimeoutMs: 5,
    fetch: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        assert.ok(signal)
        const keepAlive = setTimeout(() => {
          reject(new Error("test fetch remained stalled"))
        }, 1_000)
        if (signal.aborted) reject(signal.reason)
        else
          signal.addEventListener("abort", () => {
            clearTimeout(keepAlive)
            reject(signal.reason)
          })
      }),
  })
  await assert.rejects(() => api.fetchTasksPage(), /timed out after 5ms/)
})
