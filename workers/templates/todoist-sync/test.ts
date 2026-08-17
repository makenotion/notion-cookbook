import assert from "node:assert/strict"
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
import worker from "./src/index.js"
import {
  aggregateCompletions,
  aggregateTasks,
  projectSchema,
  projectToChange,
  type ProjectAggregateMap,
} from "./src/projects.js"
import {
  executeProjects,
  executeTasks,
  type ProjectSyncState,
  type TaskSyncState,
} from "./src/sync.js"
import { taskSchema, taskToChange } from "./src/tasks.js"
import {
  assertExpectedTodoistUserId,
  createTodoistClient,
  InvalidCursorError,
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
const COMPLETION_LOOKBACK_MS = 7 * 86_400_000

function task(
  overrides: Pick<TodoistTask, "id" | "content"> & Partial<TodoistTask>
): TodoistTask {
  return {
    projectId: "project-launch",
    parentId: null,
    description: "",
    labels: [],
    priority: 1,
    addedAt: null,
    updatedAt: null,
    due: null,
    deadline: null,
    duration: null,
    ...overrides,
  }
}

function completion(
  overrides: Pick<TodoistCompletedTask, "id" | "content" | "completedAt"> &
    Partial<TodoistCompletedTask>
): TodoistCompletedTask {
  return {
    projectId: "project-launch",
    isDeleted: false,
    ...overrides,
  }
}

function project(
  overrides: Pick<TodoistProject, "id" | "name"> & Partial<TodoistProject>
): TodoistProject {
  return {
    description: "",
    updatedAt: null,
    ...overrides,
  }
}

const TASKS: TodoistTask[] = [
  task({
    id: "task-overdue",
    content: "Resolve launch blocker",
    description: "Confirm the owner and unblock the release.",
    labels: ["launch", "needs-review"],
    priority: 4,
    addedAt: "2026-06-30T14:00:00Z",
    updatedAt: "2026-07-03T18:00:00Z",
    due: { date: "2026-07-03", isRecurring: false },
    deadline: "2026-07-05",
    duration: { amount: 30, unit: "minute" },
  }),
  task({
    id: "task-upcoming",
    content: "Publish launch notes",
    parentId: "task-parent",
    labels: ["Launch, 2026"],
    priority: 2,
    addedAt: "2026-07-01T12:00:00Z",
    updatedAt: "2026-07-04T12:00:00Z",
    due: { date: "2026-07-08T09:00:00", isRecurring: true },
    duration: { amount: 90, unit: "minute" },
  }),
  task({
    id: "task-unscheduled",
    content: "Document support handoff",
    projectId: "project-operations",
    description: "Add the agreed escalation path.",
    priority: 4,
    addedAt: "2026-07-02T12:00:00Z",
  }),
]

const COMPLETIONS: TodoistCompletedTask[] = [
  completion({
    id: "completed-brief",
    content: "Approve launch brief",
    completedAt: "2026-07-03T19:00:00Z",
  }),
  completion({
    id: "completed-qa",
    content: "Finish release QA",
    completedAt: "2026-07-02T20:00:00Z",
  }),
  completion({
    id: "completed-runbook",
    projectId: "project-operations",
    content: "Review incident runbook",
    completedAt: "2026-07-01T15:00:00Z",
  }),
]

const PROJECTS: TodoistProject[] = [
  project({
    id: "project-launch",
    name: "Product Launch",
    description: "Coordinate the launch across product and support.",
    updatedAt: "2026-07-04T12:00:00Z",
  }),
  project({
    id: "project-operations",
    name: "Operations",
    description: "Keep recurring operational work documented.",
    updatedAt: "2026-07-03T12:00:00Z",
  }),
]

function rawTaskPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-raw",
    project_id: "project-launch",
    parent_id: null,
    content: "Raw task",
    description: "",
    labels: [],
    priority: 1,
    added_at: null,
    updated_at: null,
    due: null,
    deadline: null,
    duration: null,
    ...overrides,
  }
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

function continuation<State>(
  result:
    | { hasMore: true; nextState: State }
    | { hasMore: false; nextState?: never }
): State {
  if (!result.hasMore) assert.fail("Expected another sync page.")
  return result.nextState
}

function projectPublishState(
  projectIds: string[],
  aggregates: ProjectAggregateMap = {}
): ProjectSyncState {
  return {
    phase: "projects",
    userId: AUTHENTICATED_USER.id,
    timeZone: AUTHENTICATED_USER.timeZone,
    observedAt: NOW,
    completionSince: COMPLETION_SINCE,
    completionUntil: COMPLETION_UNTIL,
    aggregates,
    pageCount: 0,
    expectedIds: [...projectIds].sort(),
    seenIds: [],
  }
}

function completionPublishState(completionIds: string[]): ProjectSyncState {
  return {
    ...projectPublishState([]),
    phase: "completions",
    expectedIds: [...completionIds].sort(),
  }
}

function taskPublishState(taskIds: string[]): TaskSyncState {
  return {
    phase: "publish",
    userId: AUTHENTICATED_USER.id,
    timeZone: AUTHENTICATED_USER.timeZone,
    observedAt: NOW,
    pageCount: 0,
    expectedIds: [...taskIds].sort(),
    seenIds: [],
  }
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
  assert.equal(classify("2024-02-29").status, "Overdue")
  for (const invalid of [
    "2026-02-29",
    "2026-02-30T10:00:00",
    "2026-04-31T10:00:00Z",
    "2026-07-03T24:00:00",
    "2026-07-03 19:00:00Z",
  ]) {
    assert.throws(() => classify(invalid), /due (date|timestamp) is invalid/)
  }
  assert.throws(() => classify("tomorrow"), /due timestamp is invalid/)
})

test("task transform answers daily triage and clears absent fields", () => {
  const tasks = TASKS
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

test("project aggregation combines open work and bounded recent completions", () => {
  const tasks = TASKS
  const completions = COMPLETIONS
  const active = aggregateTasks({}, tasks, AUTHENTICATED_USER.timeZone, NOW)
  const complete = aggregateCompletions(
    active,
    completions,
    COMPLETION_SINCE,
    COMPLETION_UNTIL
  )

  const launch = complete["project-launch"]!
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

  const operations = complete["project-operations"]!
  assert.equal(operations.openTasks, 1)
  assert.equal(operations.unscheduled, 1)
  assert.equal(operations.p1Tasks, 1)
  assert.equal(operations.completedLastSevenDays, 1)

  const deleted = aggregateCompletions(
    {},
    [{ ...completions[0]!, isDeleted: true }],
    COMPLETION_SINCE,
    COMPLETION_UNTIL
  )
  assert.deepEqual(deleted, {})

  assert.throws(
    () =>
      aggregateCompletions(
        {},
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

test("project transform exposes review signals without a completion archive", () => {
  const tasks = TASKS
  const completions = COMPLETIONS
  const projects = PROJECTS
  const active = aggregateTasks({}, tasks, AUTHENTICATED_USER.timeZone, NOW)
  const complete = aggregateCompletions(
    active,
    completions,
    COMPLETION_SINCE,
    COMPLETION_UNTIL
  )
  const change = projectToChange(
    projects[0]!,
    complete[projects[0]!.id],
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
    many,
    "2026-06-30T00:00:00Z",
    "2026-07-08T00:00:00Z"
  )["project-launch"]!
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

test("account binding rejects a token for another Todoist account", () => {
  assertExpectedTodoistUserId(AUTHENTICATED_USER.id, AUTHENTICATED_USER.id)
  assert.throws(
    () => assertExpectedTodoistUserId("another-user", AUTHENTICATED_USER.id),
    /does not match/
  )
})

test("tasks replacement discovers and publishes the same complete identity set", async () => {
  const tasks = TASKS
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

test("continuations pin task observation time and the completion window", async () => {
  const pinnedTask = task({
    id: "task-pinned",
    content: "Pinned task",
    due: { date: "2026-07-08", isRecurring: false },
  })
  const taskSource = client({
    fetchTasksPage: async () => ({
      resources: [pinnedTask],
      nextCursor: undefined,
    }),
  })
  const discovered = await executeTasks(
    undefined,
    taskSource,
    EXPECTED_USER,
    NOW
  )
  const taskState = continuation(discovered)
  assert.equal(taskState.observedAt, NOW)

  const published = await executeTasks(
    taskState,
    taskSource,
    EXPECTED_USER,
    "2026-08-04T16:00:00.000Z"
  )
  assert.equal(published.hasMore, false)
  assert.equal(published.changes[0]?.upstreamUpdatedAt, NOW)
  assertPropertyContains(
    published.changes[0]?.properties["Due Status"],
    "Next 7 days"
  )

  const completionOptions: Array<{ since: string; until: string }> = []
  const projectSource = client({
    async fetchCompletedTasksPage(options) {
      completionOptions.push(options)
      return { resources: [], nextCursor: undefined }
    },
  })
  const taskDiscovery = await executeProjects(
    undefined,
    projectSource,
    EXPECTED_USER,
    NOW
  )
  const taskPublish = await executeProjects(
    continuation(taskDiscovery),
    projectSource,
    EXPECTED_USER,
    "2026-08-04T16:00:00.000Z"
  )
  const completionDiscovery = await executeProjects(
    continuation(taskPublish),
    projectSource,
    EXPECTED_USER,
    "2026-09-04T16:00:00.000Z"
  )
  await executeProjects(
    continuation(completionDiscovery),
    projectSource,
    EXPECTED_USER,
    "2026-10-04T16:00:00.000Z"
  )
  assert.deepEqual(
    completionOptions.map(({ since, until }) => ({ since, until })),
    [
      { since: COMPLETION_SINCE, until: COMPLETION_UNTIL },
      { since: COMPLETION_SINCE, until: COMPLETION_UNTIL },
    ]
  )
})

test("replacement rejects a pagination cursor that does not advance", async () => {
  const first = await executeTasks(
    undefined,
    client({
      fetchTasksPage: async () => ({
        resources: [TASKS[0]!],
        nextCursor: "tasks.same-cursor",
      }),
    }),
    EXPECTED_USER,
    NOW
  )

  await assert.rejects(
    () =>
      executeTasks(
        continuation(first),
        client({
          fetchTasksPage: async () => ({
            resources: [TASKS[1]!],
            nextCursor: "tasks.same-cursor",
          }),
        }),
        EXPECTED_USER,
        NOW
      ),
    /repeated its current cursor.*state reset tasksSync/
  )
})

test("task replacement fails closed after emitting an inconsistent page", async () => {
  const [firstTask, secondTask] = TASKS
  assert.ok(firstTask && secondTask)
  const publish = taskPublishState([firstTask.id, secondTask.id])
  const first = await executeTasks(
    publish,
    client({
      fetchTasksPage: async () => ({
        resources: [firstTask],
        nextCursor: "tasks.page-2",
      }),
    }),
    EXPECTED_USER,
    NOW
  )
  assert.deepEqual(
    first.changes.map((change) => change.key),
    [firstTask.id]
  )
  const firstState = continuation(first)
  await assert.rejects(
    () => executeTasks(firstState, client(), EXPECTED_USER, NOW),
    /state reset tasksSync/
  )
  const stabilized = await executeTasks(
    firstState,
    client({
      fetchTasksPage: async () => ({
        resources: [secondTask],
        nextCursor: undefined,
      }),
    }),
    EXPECTED_USER,
    NOW
  )
  assert.equal(stabilized.hasMore, false)
  assert.deepEqual(
    stabilized.changes.map((change) => change.key),
    [secondTask.id]
  )
})

test("tasks replacement bounds pre-output restarts and enforces account first", async () => {
  const tasks = TASKS
  const duplicate = client({
    fetchTasksPage: async () => ({
      resources: [tasks[0]!, tasks[0]!],
      nextCursor: undefined,
    }),
  })
  await assert.rejects(
    () => executeTasks(undefined, duplicate, EXPECTED_USER, NOW),
    /state reset tasksSync/
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
  const discoveryState = continuation(discovery)
  const restarted = await executeTasks(
    discoveryState,
    client(),
    EXPECTED_USER,
    NOW
  )
  const restartedState = continuation(restarted)
  assert.equal(restartedState.phase, "discovery")
  assert.equal(restartedState.restartAttempted, true)
  assert.deepEqual(restarted.changes, [])

  const rediscovered = await executeTasks(
    restartedState,
    client({
      fetchTasksPage: async () => ({
        resources: [tasks[0]!],
        nextCursor: undefined,
      }),
    }),
    EXPECTED_USER,
    NOW
  )
  const republish = continuation(rediscovered)
  assert.equal(republish.phase, "publish")
  assert.equal(republish.restartAttempted, true)
  await assert.rejects(
    () => executeTasks(republish, client(), EXPECTED_USER, NOW),
    /state reset tasksSync/
  )

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

test("invalid task cursors restart discovery without completing replacement", async () => {
  const tasks = TASKS
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
  const firstState = continuation(first)
  const restarted = await executeTasks(
    firstState,
    client({
      fetchTasksPage: async () => {
        throw new InvalidCursorError()
      },
    }),
    EXPECTED_USER,
    NOW
  )
  const restartedState = continuation(restarted)
  assert.equal(restartedState.phase, "discovery")
  assert.equal(restartedState.cursor, undefined)
  assert.equal(restartedState.restartAttempted, true)
  assert.deepEqual(restarted.changes, [])
})

test("project replacement aggregates sources before emitting rows", async () => {
  const tasks = TASKS
  const completions = COMPLETIONS
  const projects = PROJECTS
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
  assert.equal(taskPublishDone.nextState.phase, "completionDiscovery")

  const firstCompletionDiscoveryPage = await executeProjects(
    taskPublishDone.nextState,
    source,
    EXPECTED_USER,
    NOW
  )
  assert.equal(firstCompletionDiscoveryPage.hasMore, true)
  assert.deepEqual(firstCompletionDiscoveryPage.changes, [])
  assert.equal(
    firstCompletionDiscoveryPage.nextState.phase,
    "completionDiscovery"
  )

  const completionDiscoveryDone = await executeProjects(
    firstCompletionDiscoveryPage.nextState,
    source,
    EXPECTED_USER,
    NOW
  )
  assert.equal(completionDiscoveryDone.hasMore, true)
  assert.deepEqual(completionDiscoveryDone.changes, [])
  assert.equal(completionDiscoveryDone.nextState.phase, "completions")

  const firstCompletionPage = await executeProjects(
    completionDiscoveryDone.nextState,
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
  assert.equal(completionOptions.length, 4)
  assert.ok(
    completionOptions.every(
      (options) =>
        options.since === completionOptions[0]!.since &&
        options.until === completionOptions[0]!.until
    )
  )
  assert.equal(
    Date.parse(completionOptions[0]!.until) -
      Date.parse(completionOptions[0]!.since),
    COMPLETION_LOOKBACK_MS
  )
})

test("completion history requires the same occurrence set on both passes", async () => {
  const [completion, unexpectedCompletion] = COMPLETIONS
  assert.ok(completion && unexpectedCompletion)
  const occurrenceId = `${completion.id}:${completion.completedAt}`
  const publish = completionPublishState([occurrenceId])

  const restarted = await executeProjects(publish, client(), EXPECTED_USER, NOW)
  const restartedState = continuation(restarted)
  assert.equal(restartedState.phase, "taskDiscovery")
  assert.equal(restartedState.restartAttempted, true)
  assert.deepEqual(restartedState.aggregates, {})

  const tombstone = await executeProjects(
    publish,
    client({
      fetchCompletedTasksPage: async () => ({
        resources: [{ ...completion, isDeleted: true }],
        nextCursor: undefined,
      }),
    }),
    EXPECTED_USER,
    NOW
  )
  const tombstoneState = continuation(tombstone)
  assert.equal(tombstoneState.phase, "projectDiscovery")
  assert.deepEqual(tombstoneState.aggregates, {})

  await assert.rejects(
    () =>
      executeProjects(
        publish,
        client({
          fetchCompletedTasksPage: async () => ({
            resources: [completion, completion],
            nextCursor: undefined,
          }),
        }),
        EXPECTED_USER,
        NOW
      ),
    /state reset projectsSync/
  )

  const firstAggregationPage = await executeProjects(
    publish,
    client({
      fetchCompletedTasksPage: async () => ({
        resources: [completion],
        nextCursor: "completions.page-2",
      }),
    }),
    EXPECTED_USER,
    NOW
  )
  const firstAggregationState = continuation(firstAggregationPage)
  await assert.rejects(
    () =>
      executeProjects(
        firstAggregationState,
        client({
          fetchCompletedTasksPage: async () => ({
            resources: [completion],
            nextCursor: undefined,
          }),
        }),
        EXPECTED_USER,
        NOW
      ),
    /state reset projectsSync/
  )

  const changedSet = await executeProjects(
    publish,
    client({
      fetchCompletedTasksPage: async () => ({
        resources: [completion, unexpectedCompletion],
        nextCursor: undefined,
      }),
    }),
    EXPECTED_USER,
    NOW
  )
  assert.equal(continuation(changedSet).phase, "taskDiscovery")

  await assert.rejects(
    () =>
      executeProjects(
        publish,
        client({
          fetchCompletedTasksPage: async () => ({
            resources: [completion, { ...completion, isDeleted: true }],
            nextCursor: undefined,
          }),
        }),
        EXPECTED_USER,
        NOW
      ),
    /state reset projectsSync/
  )
})

test("project aggregation restarts before output after an expired cursor", async () => {
  const completions = COMPLETIONS
  const completion = completions[0]!
  const publish = completionPublishState([
    `${completion.id}:${completion.completedAt}`,
  ])

  const partialCompletions = await executeProjects(
    publish,
    client({
      fetchCompletedTasksPage: async () => ({
        resources: [completions[0]!],
        nextCursor: "expired",
      }),
    }),
    EXPECTED_USER,
    NOW
  )
  const partialCompletionState = continuation(partialCompletions)
  assert.equal(
    partialCompletionState.aggregates["project-launch"]?.completedLastSevenDays,
    1
  )

  const restarted = await executeProjects(
    partialCompletionState,
    client({
      fetchCompletedTasksPage: async () => {
        throw new InvalidCursorError()
      },
    }),
    EXPECTED_USER,
    NOW
  )
  const restartedState = continuation(restarted)
  assert.equal(restartedState.phase, "taskDiscovery")
  assert.equal(restartedState.restartAttempted, true)
  assert.deepEqual(restartedState.aggregates, {})
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
  const projectState = projectPublishState(["project-launch"], aggregate)
  const projects = PROJECTS
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
  assert.deepEqual(first.nextState.seenIds, ["project-launch"])

  const completed = await executeProjects(
    first.nextState,
    client(),
    EXPECTED_USER,
    NOW
  )
  assert.equal(completed.hasMore, false)
  assert.deepEqual(completed.changes, [])

  await assert.rejects(
    () =>
      executeProjects(
        first.nextState,
        client({
          fetchProjectsPage: async () => ({
            resources: [projects[0]!],
            nextCursor: undefined,
          }),
        }),
        EXPECTED_USER,
        NOW
      ),
    /state reset projectsSync/
  )

  const missingProject: ProjectAggregateMap = {
    "project-missing": {
      ...aggregate["project-launch"]!,
      projectId: "project-missing",
    },
  }
  const missingInventory = projectPublishState([], missingProject)
  const restarted = await executeProjects(
    missingInventory,
    client(),
    EXPECTED_USER,
    NOW
  )
  const restartedState = continuation(restarted)
  assert.equal(restartedState.phase, "taskDiscovery")
  assert.equal(restartedState.restartAttempted, true)
  assert.deepEqual(restartedState.aggregates, {})
})

test("project replacement fails closed after emitting an inconsistent page", async () => {
  const [firstProject, secondProject] = PROJECTS
  assert.ok(firstProject && secondProject)
  const publish = projectPublishState([firstProject.id, secondProject.id])

  const first = await executeProjects(
    publish,
    client({
      fetchProjectsPage: async () => ({
        resources: [firstProject],
        nextCursor: "projects.page-2",
      }),
    }),
    EXPECTED_USER,
    NOW
  )
  assert.deepEqual(
    first.changes.map((change) => change.key),
    [firstProject.id]
  )
  const firstState = continuation(first)
  await assert.rejects(
    () => executeProjects(firstState, client(), EXPECTED_USER, NOW),
    /state reset projectsSync/
  )
  const stabilized = await executeProjects(
    firstState,
    client({
      fetchProjectsPage: async () => ({
        resources: [secondProject],
        nextCursor: undefined,
      }),
    }),
    EXPECTED_USER,
    NOW
  )
  assert.equal(stabilized.hasMore, false)
  assert.deepEqual(
    stabilized.changes.map((change) => change.key),
    [secondProject.id]
  )
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
        return Response.json({
          items: [
            {
              id: "completed-raw",
              project_id: "project-launch",
              content: "Completed raw task",
              completed_at: "2026-07-03T19:00:00Z",
              is_deleted: false,
            },
          ],
          next_cursor: null,
        })
      }
      if (url.pathname.endsWith("/tasks")) {
        return Response.json({
          results: [rawTaskPayload()],
          next_cursor: null,
        })
      }
      return Response.json({
        results: [
          {
            id: "project-raw",
            name: "Raw project",
            description: "",
            updated_at: null,
          },
        ],
        next_cursor: null,
      })
    },
  })

  assert.deepEqual(await api.fetchAuthenticatedUser(), AUTHENTICATED_USER)
  assert.equal((await api.fetchTasksPage("tasks.cursor")).resources.length, 1)
  assert.equal(
    (await api.fetchProjectsPage("projects.cursor")).resources.length,
    1
  )
  assert.equal(
    (
      await api.fetchCompletedTasksPage({
        since: "2026-06-27T00:00:00Z",
        until: "2026-07-04T00:00:00Z",
        cursor: "completed.cursor",
      })
    ).resources.length,
    1
  )
  assert.equal(pacing, 4)
  for (const request of requests) {
    assert.equal(
      new Headers(request.init?.headers).get("authorization"),
      "Bearer secret-test-token"
    )
    if (!request.url.pathname.endsWith("/user")) {
      assert.equal(request.url.searchParams.get("limit"), "200")
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
        results: [rawTaskPayload()],
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

  const nullable = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async () =>
      Response.json({
        results: [rawTaskPayload({ labels: null, updated_at: null })],
        next_cursor: null,
      }),
  })
  const [nullableTask] = (await nullable.fetchTasksPage()).resources
  assert.deepEqual(nullableTask?.labels, [])
  assert.equal(nullableTask?.updatedAt, null)

  for (const completedAt of [
    "yesterday",
    "2026-07-03Z",
    "2026-07-03 19:00:00Z",
    "2026-07-03T24:00:00Z",
  ]) {
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
              completed_at: completedAt,
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
  }

  for (const dueDate of ["2026-02-30T10:00:00Z", "2026-07-03T24:00:00"]) {
    const invalidCalendarTask = rawTaskPayload({
      due: { date: dueDate, is_recurring: false },
    })
    const invalidCalendar = createTodoistClient({
      beforeRequest: async () => {},
      getApiToken: () => "test-token",
      fetch: async () =>
        Response.json({ results: [invalidCalendarTask], next_cursor: null }),
    })
    await assert.rejects(
      () => invalidCalendar.fetchTasksPage(),
      /invalid task 0.due.date/
    )
  }
})

test("HTTP failures are rate-aware, bounded, and never expose credentials", async () => {
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
        headers: { "Content-Length": "1000000" },
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
