// Deterministic offline tests for Todoist completed-work sync behavior.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { test } from "node:test"

import { RateLimitError } from "@notionhq/workers"

import {
  completionId,
  completedTaskToChange,
  completedWorkSchema,
  dedupeCompletedTasks,
} from "./src/completed-work.js"
import {
  elapsedDays,
  optionLabel,
  optionLabels,
  textWasTruncated,
} from "./src/helpers.js"
import worker, { executeCompletedWork, executeProjects } from "./src/index.js"
import { projectSchema, projectToChange } from "./src/projects.js"
import {
  COMPLETED_OVERLAP_MS,
  COMPLETED_RECONCILIATION_MS,
  COMPLETED_WINDOW_MS,
  CONSISTENCY_BUFFER_MS,
  assertExpectedTodoistUserId,
  currentCompletedWindow,
  currentProjectsSyncState,
  getExpectedTodoistUserId,
  getTodoistSyncConfig,
  MAX_CURSOR_PAGES,
  MAX_RECENT_CURSORS,
  MAX_SYNC_STATE_BYTES,
  nextCompletedSyncState,
  nextProjectsSyncState,
  type CompletedSyncState,
  type ProjectsSyncState,
} from "./src/sync-state.js"
import {
  createTodoistClient,
  InvalidCursorError,
  MAX_CURSOR_CHARACTERS,
  MAX_ERROR_RESPONSE_BYTES,
  MAX_SUCCESS_RESPONSE_BYTES,
  parseRetryAfterSeconds,
  TODOIST_PAGE_SIZE,
  type TodoistClient,
  type TodoistCompletedTask,
  type TodoistProject,
} from "./src/todoist.js"

const AUTHENTICATED_USER = {
  id: "user-1",
  timeZone: "America/New_York",
}
const EXPECTED_USER = () => AUTHENTICATED_USER.id

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

function clone<T>(value: T): T {
  return structuredClone(value)
}

async function parsedCompletedTasks(): Promise<TodoistCompletedTask[]> {
  const client = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async () => Response.json(fixture("completed-tasks-page.json")),
  })
  return (
    await client.fetchCompletedTasksPage({
      since: "2026-07-01T00:00:00Z",
      until: "2026-07-03T00:00:00Z",
    })
  ).resources
}

async function parsedProject(
  name: "projects-active.json" | "projects-archived.json"
): Promise<TodoistProject> {
  const client = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async () => Response.json(fixture(name)),
  })
  return (await client.fetchProjectsPage("active")).resources[0]!
}

test("worker manifest registers durable incremental syncs and shared pacing", () => {
  assert.deepEqual(
    worker.manifest.databases.map((database) => ({
      key: database.key,
      title: database.config.initialTitle,
      primaryKey: database.config.primaryKeyProperty,
      firstFive: Object.keys(database.config.schema.properties).slice(0, 5),
    })),
    [
      {
        key: "projects",
        title: "Todoist Projects",
        primaryKey: "Todoist Project ID",
        firstFive: ["Project", "State", "Kind", "Workspace Status", "Color"],
      },
      {
        key: "completedWork",
        title: "Todoist Completed Work",
        primaryKey: "Completion ID",
        firstFive: ["Task", "Completed", "Project", "Priority", "Labels"],
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
        mode: "incremental",
        schedule: { type: "interval", intervalMs: 60 * 60_000 },
      },
      {
        key: "completedWorkSync",
        databaseKey: "completedWork",
        mode: "incremental",
        schedule: { type: "interval", intervalMs: 15 * 60_000 },
      },
      {
        key: "completedWorkBackfill",
        databaseKey: "completedWork",
        mode: "incremental",
        schedule: { type: "manual" },
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

test("history configuration is explicit, timezone-safe, and deterministic", () => {
  const now = new Date("2026-07-03T12:00:00Z")
  assert.equal(
    getTodoistSyncConfig({}, now).historyStart,
    "2025-07-03T12:00:00.000Z"
  )
  assert.equal(
    getTodoistSyncConfig({ TODOIST_HISTORY_START: "2026-01-15" }, now)
      .historyStart,
    "2026-01-15T00:00:00.000Z"
  )
  assert.equal(
    getTodoistSyncConfig(
      { TODOIST_HISTORY_START: "2026-01-15T03:00:00-05:00" },
      now
    ).historyStart,
    "2026-01-15T08:00:00.000Z"
  )
  assert.throws(
    () =>
      getTodoistSyncConfig(
        { TODOIST_HISTORY_START: "2026-01-15T03:00:00" },
        now
      ),
    /include Z or a UTC offset/
  )

  assert.equal(
    getExpectedTodoistUserId({ TODOIST_USER_ID: " user-1 " }),
    AUTHENTICATED_USER.id
  )
  assert.throws(() => getExpectedTodoistUserId({}), /not set/)
  assert.throws(
    () => getExpectedTodoistUserId({ TODOIST_USER_ID: "x".repeat(257) }),
    /oversized/
  )
  assert.doesNotThrow(() =>
    assertExpectedTodoistUserId(AUTHENTICATED_USER.id, AUTHENTICATED_USER.id)
  )
  assert.throws(
    () => assertExpectedTodoistUserId(AUTHENTICATED_USER.id, "other-user"),
    /does not match/
  )
})

test("completion windows replay paginated ranges before checkpointing", () => {
  const config = { historyStart: "2026-01-01T00:00:00Z" }
  const now = new Date("2026-04-15T00:00:00Z")
  let state: CompletedSyncState = currentCompletedWindow(
    undefined,
    config,
    AUTHENTICATED_USER.id,
    now
  )
  assert.equal(state.phase, "window")
  if (state.phase !== "window") return
  assert.equal(
    Date.parse(state.cycleUntil),
    now.getTime() - CONSISTENCY_BUFFER_MS
  )
  assert.ok(
    Date.parse(state.windowUntil) - Date.parse(state.windowSince) <=
      COMPLETED_WINDOW_MS
  )
  assert.equal(state.reconciliation, true)
  assert.equal(state.historyStart, "2026-01-01T00:00:00.000Z")

  const originalWindow = {
    since: state.windowSince,
    until: state.windowUntil,
  }
  state = nextCompletedSyncState(state, "cursor.page-2")
  assert.equal(state.phase, "window")
  if (state.phase !== "window") return
  assert.equal(state.cursor, "cursor.page-2")
  assert.equal(state.pass, "primary")

  state = nextCompletedSyncState(state, undefined)
  assert.equal(state.phase, "window")
  if (state.phase !== "window") return
  assert.equal(state.pass, "replay")
  assert.equal(state.cursor, undefined)
  assert.equal(state.windowSince, originalWindow.since)
  assert.equal(state.windowUntil, originalWindow.until)

  state = nextCompletedSyncState(state, undefined)
  while (state.phase === "window") {
    assert.ok(
      Date.parse(state.windowUntil) - Date.parse(state.windowSince) <=
        COMPLETED_WINDOW_MS
    )
    state = nextCompletedSyncState(state, undefined)
  }

  assert.equal(
    Date.parse(state.since),
    now.getTime() - CONSISTENCY_BUFFER_MS - COMPLETED_OVERLAP_MS
  )
  assert.equal(
    state.lastReconciledAt,
    new Date(now.getTime() - CONSISTENCY_BUFFER_MS).toISOString()
  )
  const resumed = currentCompletedWindow(
    state,
    config,
    AUTHENTICATED_USER.id,
    "2026-04-15T01:00:00Z"
  )
  assert.equal(resumed.windowSince, state.since)
  assert.equal(resumed.reconciliation, false)

  const reconciled = currentCompletedWindow(
    state,
    config,
    AUTHENTICATED_USER.id,
    new Date(
      Date.parse(state.lastReconciledAt!) +
        COMPLETED_RECONCILIATION_MS +
        CONSISTENCY_BUFFER_MS
    )
  )
  assert.equal(
    reconciled.windowSince,
    new Date(config.historyStart).toISOString()
  )
  assert.equal(reconciled.reconciliation, true)
  assert.throws(
    () =>
      currentCompletedWindow(
        undefined,
        { historyStart: "2027-01-01T00:00:00Z" },
        AUTHENTICATED_USER.id,
        now
      ),
    /must be before the buffered cycle end/
  )
})

test("sync state pins history and bounds cursor pagination", () => {
  const config = { historyStart: "2026-07-01T00:00:00Z" }
  const state = currentCompletedWindow(
    undefined,
    config,
    AUTHENTICATED_USER.id,
    "2026-07-03T00:00:00Z"
  )
  const resumed = currentCompletedWindow(
    {
      ...state,
      cursor: "expired-cursor",
      recentCursors: ["expired-cursor"],
      pageCount: 1,
    },
    config,
    AUTHENTICATED_USER.id,
    "2026-07-04T00:00:00Z"
  )
  assert.equal(resumed.cursor, "expired-cursor")
  assert.equal(resumed.windowSince, state.windowSince)
  assert.equal(resumed.windowUntil, state.windowUntil)
  assert.equal(resumed.historyStart, "2026-07-01T00:00:00.000Z")

  const legacyTail = currentCompletedWindow(
    {
      phase: "window",
      userId: AUTHENTICATED_USER.id,
      cycleSince: "2026-07-02T00:00:00Z",
      cycleUntil: "2026-07-03T00:00:00Z",
      windowSince: "2026-07-02T00:00:00Z",
      windowUntil: "2026-07-03T00:00:00Z",
    } as CompletedSyncState,
    { historyStart: "2025-07-01T00:00:00Z" },
    AUTHENTICATED_USER.id,
    "2026-07-04T00:00:00Z"
  )
  assert.equal(legacyTail.historyStart, "2025-07-01T00:00:00.000Z")

  let projectState = currentProjectsSyncState(undefined, AUTHENTICATED_USER.id)
  for (let index = 1; index <= MAX_RECENT_CURSORS + 2; index++) {
    const next = nextProjectsSyncState(projectState, `cursor-${index}`)
    assert.notEqual(next.phase, "checkpoint")
    if (next.phase === "checkpoint") return
    projectState = next
  }
  assert.equal(projectState.recentCursors?.length, MAX_RECENT_CURSORS)
  assert.equal(projectState.pageCount, MAX_RECENT_CURSORS + 2)

  assert.throws(
    () =>
      nextProjectsSyncState(
        projectState,
        "x".repeat(MAX_CURSOR_CHARACTERS + 1)
      ),
    /oversized cursor/
  )
  assert.throws(
    () =>
      nextProjectsSyncState(
        {
          ...projectState,
          cursor: "cursor-last",
          recentCursors: ["cursor-last"],
          pageCount: MAX_CURSOR_PAGES - 1,
        },
        "cursor-overflow"
      ),
    /exceeded 1000 pages/
  )
  assert.throws(
    () =>
      currentCompletedWindow(
        {
          phase: "checkpoint",
          userId: AUTHENTICATED_USER.id,
          historyStart: state.historyStart,
          since: state.cycleSince,
        },
        config,
        "different-user",
        "2026-07-04T00:00:00Z"
      ),
    /account changed/
  )
  assert.throws(
    () =>
      currentCompletedWindow(
        {
          phase: "checkpoint",
          userId: AUTHENTICATED_USER.id,
          historyStart: state.historyStart,
          since: state.cycleSince,
          padding: "x".repeat(MAX_SYNC_STATE_BYTES),
        } as unknown as CompletedSyncState,
        config,
        AUTHENTICATED_USER.id,
        "2026-07-04T00:00:00Z"
      ),
    /size bound/
  )
  assert.throws(
    () =>
      currentCompletedWindow(
        {
          phase: "unknown",
          userId: AUTHENTICATED_USER.id,
        } as unknown as CompletedSyncState,
        config,
        AUTHENTICATED_USER.id,
        "2026-07-04T00:00:00Z"
      ),
    /invalid phase/
  )

  const corruptProjectsState = {
    phase: "active",
    userId: AUTHENTICATED_USER.id,
    cursor: " ",
    recentCursors: [" "],
    pageCount: 1,
  } as ProjectsSyncState
  assert.throws(
    () => currentProjectsSyncState(corruptProjectsState, AUTHENTICATED_USER.id),
    /empty cursor/
  )
  assert.throws(
    () =>
      currentProjectsSyncState(
        { phase: "checkpoint", userId: AUTHENTICATED_USER.id },
        "different-user"
      ),
    /account changed/
  )
})

test("completed-task transform preserves occurrence identity and user-owned body", async () => {
  const tasks = await parsedCompletedTasks()
  const deduped = dedupeCompletedTasks(tasks)
  assert.equal(deduped.length, 2)
  assert.equal(
    deduped.find((task) => task.id === "6XGgmFVcrG5RRjVr")?.description,
    "The fresher duplicate returned by a live cursor page."
  )

  const change = completedTaskToChange(deduped[0]!, AUTHENTICATED_USER.timeZone)
  assert.equal(change.key, completionId(deduped[0]!))
  assert.equal("pageContentMarkdown" in change, false)
  assert.deepEqual(
    Object.keys(change.properties),
    Object.keys(completedWorkSchema.properties)
  )
  assertPropertyContains(change.properties.Task, "Ship the launch brief")
  assertPropertyContains(change.properties.Priority, "P1 · Urgent")
  assertPropertyContains(change.properties.Labels, "Launch， 2026")
  assertPropertyContains(change.properties["Planned Duration (min)"], "90")
  assertPropertyContains(change.properties["Days to Complete"], "2.15")
  assertPropertyContains(change.properties.Project, deduped[0]!.projectId)
  assertPropertyContains(
    change.properties["Responsible User ID"],
    deduped[0]!.responsibleUserId!
  )
  assertPropertyContains(change.properties["Completion ID"], change.key)
  assertPropertyContains(
    change.properties["Task Link"],
    `https://app.todoist.com/app/task/${deduped[0]!.id}`
  )

  const recurring = completedTaskToChange(deduped[1]!)
  assertPropertyContains(recurring.properties.Recurring, "Yes")
  assertPropertyContains(recurring.properties["Planned Duration (min)"], "1440")
  assert.deepEqual(recurring.properties["Days to Complete"], [])
  assertPropertyContains(recurring.properties["Completion Count"], "42")
  assertPropertyContains(recurring.properties["Is Subtask"], "Yes")
  assert.equal(recurring.key, completionId(deduped[1]!))

  const nextOccurrence = {
    ...deduped[1]!,
    completedAt: "2026-07-03T20:00:00-04:00",
    updatedAt: "2026-07-04T00:00:05Z",
    completedCount: 43,
  }
  const occurrences = dedupeCompletedTasks([deduped[1]!, nextOccurrence])
  assert.equal(occurrences.length, 2)
  assert.notEqual(completionId(occurrences[0]!), completionId(occurrences[1]!))
  assert.equal(
    dedupeCompletedTasks([
      deduped[1]!,
      { ...deduped[1]!, completedAt: "2026-07-02T16:00:00-04:00" },
    ]).length,
    1
  )

  const preciseOccurrence = {
    ...deduped[1]!,
    completedAt: "2026-07-02T20:00:00.123456Z",
  }
  const differentMicroseconds = {
    ...preciseOccurrence,
    completedAt: "2026-07-02T20:00:00.123789Z",
  }
  assert.notEqual(
    completionId(preciseOccurrence),
    completionId(differentMicroseconds)
  )
  assert.equal(
    dedupeCompletedTasks([preciseOccurrence, differentMicroseconds]).length,
    2
  )
  assert.equal(
    completionId(preciseOccurrence),
    completionId({
      ...preciseOccurrence,
      completedAt: "2026-07-02T16:00:00.123456-04:00",
    })
  )
  assert.equal(
    completionId({
      ...preciseOccurrence,
      completedAt: "2026-07-02T20:00:00.123000Z",
    }),
    completionId({
      ...preciseOccurrence,
      completedAt: "2026-07-02T20:00:00.123Z",
    })
  )

  const floatingDue = completedTaskToChange(
    {
      ...deduped[0]!,
      due: {
        date: "2026-07-02T09:00:00",
        string: "Jul 2 at 9am",
        isRecurring: false,
        timeZone: null,
      },
    },
    AUTHENTICATED_USER.timeZone
  )
  assertPropertyContains(floatingDue.properties.Due, "America/New_York")

  const longDescription = completedTaskToChange({
    ...deduped[0]!,
    description: "x".repeat(2_001),
  })
  assertPropertyContains(
    longDescription.properties["Description Truncated"],
    "Yes"
  )
  assert.ok(propertyText(longDescription.properties.Description).length < 2_100)
})

test("helpers bound provider options and useful completion metrics", () => {
  assert.equal(optionLabel("Launch, 2026"), "Launch， 2026")
  assert.equal(optionLabels("labels", ["A", "a", "B"]).length, 2)
  assert.equal(optionLabel("x".repeat(101))?.length, 100)
  assert.equal(textWasTruncated("x".repeat(2_001)), true)
  assert.equal(textWasTruncated("x".repeat(2_000)), false)
  assert.equal(elapsedDays("2026-07-01T00:00:00Z", "2026-07-02T12:00:00Z"), 1.5)
})

test("Todoist client pins completion parameters, bearer auth, and pacing", async () => {
  let requestUrl: URL | undefined
  let requestInit: RequestInit | undefined
  let pacing = 0
  const client = createTodoistClient({
    beforeRequest: async () => {
      pacing++
    },
    getApiToken: () => "secret-test-token",
    fetch: async (input, init) => {
      requestUrl = new URL(String(input))
      requestInit = init
      return Response.json(fixture("completed-tasks-page.json"))
    },
  })

  const page = await client.fetchCompletedTasksPage({
    since: "2026-07-01T00:00:00Z",
    until: "2026-07-03T00:00:00Z",
    cursor: "completed.page-1",
  })
  assert.equal(pacing, 1)
  assert.equal(
    requestUrl?.pathname,
    "/api/v1/tasks/completed/by_completion_date"
  )
  assert.equal(requestUrl?.searchParams.get("since"), "2026-07-01T00:00:00Z")
  assert.equal(requestUrl?.searchParams.get("until"), "2026-07-03T00:00:00Z")
  assert.equal(requestUrl?.searchParams.get("limit"), String(TODOIST_PAGE_SIZE))
  assert.equal(requestUrl?.searchParams.get("cursor"), "completed.page-1")
  assert.equal(
    new Headers(requestInit?.headers).get("authorization"),
    "Bearer secret-test-token"
  )
  assert.equal(page.resources.length, 3)
  assert.equal(page.nextCursor, "completed.page-2")
})

test("Todoist client validates authenticated user identity and timezone", async () => {
  let requestUrl: URL | undefined
  const client = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async (input, init) => {
      requestUrl = new URL(String(input))
      assert.ok(init?.signal instanceof AbortSignal)
      return Response.json({
        id: AUTHENTICATED_USER.id,
        tz_info: { timezone: AUTHENTICATED_USER.timeZone },
        token: "provider-token-that-must-not-be-retained",
      })
    },
  })

  assert.deepEqual(await client.fetchAuthenticatedUser(), AUTHENTICATED_USER)
  assert.equal(requestUrl?.pathname, "/api/v1/user")
})

test("Todoist client normalizes nullable labels and project flags", async () => {
  const completedResponse = clone(fixture("completed-tasks-page.json")) as {
    items: Array<Record<string, unknown>>
  }
  completedResponse.items[0]!.labels = null
  const completedClient = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async () => Response.json(completedResponse),
  })
  const completedPage = await completedClient.fetchCompletedTasksPage({
    since: "2026-07-01T00:00:00Z",
    until: "2026-07-03T00:00:00Z",
  })
  assert.deepEqual(completedPage.resources[0]!.labels, [])

  delete completedResponse.items[0]!.labels
  await assert.rejects(
    () =>
      completedClient.fetchCompletedTasksPage({
        since: "2026-07-01T00:00:00Z",
        until: "2026-07-03T00:00:00Z",
      }),
    /invalid completed task 0.labels/
  )

  const projectResponse = clone(fixture("projects-active.json")) as {
    results: Array<Record<string, unknown>>
  }
  projectResponse.results[0]!.inbox_project = null
  const projectClient = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async () => Response.json(projectResponse),
  })
  const projectPage = await projectClient.fetchProjectsPage("active")
  assert.equal(projectPage.resources[0]!.inboxProject, false)
})

test("projects traverse active then archived and retain last-known rows", async () => {
  const active = await parsedProject("projects-active.json")
  const archived = await parsedProject("projects-archived.json")
  const activeChange = projectToChange(active, "active")
  const archivedChange = projectToChange(archived, "archived")
  assert.deepEqual(
    Object.keys(activeChange.properties),
    Object.keys(projectSchema.properties)
  )
  assertPropertyContains(activeChange.properties.State, "Active")
  assertPropertyContains(activeChange.properties.Color, "Berry Red")
  assertPropertyContains(archivedChange.properties.State, "Archived")
  const longDescription = projectToChange(
    { ...active, description: "x".repeat(2_001) },
    "active"
  )
  assertPropertyContains(
    longDescription.properties["Description Truncated"],
    "Yes"
  )

  let state = currentProjectsSyncState(undefined, AUTHENTICATED_USER.id)
  let nextState = nextProjectsSyncState(state, "active.page-2")
  if (nextState.phase === "checkpoint") return
  assert.equal(nextState.phase, "active")
  state = nextState
  assert.equal(state.phase, "active")
  assert.equal(state.cursor, "active.page-2")
  nextState = nextProjectsSyncState(state, undefined)
  assert.deepEqual(nextState, {
    phase: "archived",
    userId: AUTHENTICATED_USER.id,
  })
  if (nextState.phase === "checkpoint") return
  assert.deepEqual(nextProjectsSyncState(nextState, undefined), {
    phase: "checkpoint",
    userId: AUTHENTICATED_USER.id,
  })
})

test("completed execution replays paginated windows before checkpointing", async () => {
  const tasks = await parsedCompletedTasks()
  const calls: Array<{ since: string; until: string; cursor?: string }> = []
  const client: TodoistClient = {
    async fetchAuthenticatedUser() {
      return AUTHENTICATED_USER
    },
    async fetchCompletedTasksPage(options) {
      calls.push(clone(options))
      if (calls.length === 1) {
        return { resources: tasks, nextCursor: "primary.page-2" }
      }
      if (calls.length === 3) {
        return { resources: tasks, nextCursor: "replay.page-2" }
      }
      return { resources: [], nextCursor: undefined }
    },
    async fetchProjectsPage() {
      return { resources: [], nextCursor: undefined }
    },
  }
  const config = () => ({ historyStart: "2026-07-01T00:00:00Z" })
  const first = await executeCompletedWork(
    undefined,
    client,
    config,
    "2026-07-03T00:00:00Z",
    EXPECTED_USER
  )
  assert.equal(first.hasMore, true)
  assert.equal(first.changes.length, 2)
  assert.equal(first.nextState.phase, "window")

  const second = await executeCompletedWork(
    first.nextState,
    client,
    config,
    "2026-07-04T00:00:00Z",
    EXPECTED_USER
  )
  assert.equal(second.hasMore, true)
  assert.equal(second.nextState.phase, "window")
  if (second.nextState.phase !== "window") return
  assert.equal(second.nextState.pass, "replay")

  const third = await executeCompletedWork(
    second.nextState,
    client,
    config,
    "2026-07-04T00:00:00Z",
    EXPECTED_USER
  )
  assert.equal(third.hasMore, true)
  assert.equal(third.nextState.phase, "window")

  const fourth = await executeCompletedWork(
    third.nextState,
    client,
    config,
    "2026-07-04T00:00:00Z",
    EXPECTED_USER
  )
  assert.equal(fourth.hasMore, false)
  assert.equal(fourth.nextState.phase, "checkpoint")
  assert.deepEqual(
    calls.map((call) => call.cursor),
    [undefined, "primary.page-2", undefined, "replay.page-2"]
  )
  assert.equal(calls[1]?.since, calls[0]?.since)
  assert.equal(calls[1]?.until, calls[0]?.until)
  assert.equal(calls[2]?.since, calls[0]?.since)
  assert.equal(calls[2]?.until, calls[0]?.until)
})

test("completed execution bounds invalid-cursor recovery without advancing", async () => {
  const config = () => ({ historyStart: "2026-07-01T00:00:00Z" })
  const initial = currentCompletedWindow(
    undefined,
    config(),
    AUTHENTICATED_USER.id,
    "2026-07-03T00:00:00Z"
  )
  const persisted = nextCompletedSyncState(initial, "expired-cursor")
  if (persisted.phase !== "window") return
  const bounds = {
    since: persisted.windowSince,
    until: persisted.windowUntil,
  }
  const calls: Array<{ since: string; until: string; cursor?: string }> = []
  let stable = false
  const client: TodoistClient = {
    async fetchAuthenticatedUser() {
      return AUTHENTICATED_USER
    },
    async fetchCompletedTasksPage(options) {
      calls.push(clone(options))
      if (options.cursor) throw new InvalidCursorError()
      return {
        resources: [],
        nextCursor: stable ? undefined : "replacement-cursor",
      }
    },
    async fetchProjectsPage() {
      return { resources: [], nextCursor: undefined }
    },
  }

  const recovered = await executeCompletedWork(
    persisted,
    client,
    config,
    "2026-07-04T00:00:00Z",
    EXPECTED_USER
  )
  assert.equal(recovered.hasMore, true)
  assert.equal(recovered.nextState.phase, "window")
  if (recovered.nextState.phase !== "window") return
  assert.equal(recovered.nextState.cursor, undefined)
  assert.equal(recovered.nextState.cursorRecoveryCount, 1)

  const retried = await executeCompletedWork(
    recovered.nextState,
    client,
    config,
    "2026-07-04T00:00:00Z",
    EXPECTED_USER
  )
  const deferred = await executeCompletedWork(
    retried.nextState,
    client,
    config,
    "2026-07-04T00:00:00Z",
    EXPECTED_USER
  )
  assert.equal(deferred.hasMore, false)
  assert.equal(deferred.nextState.phase, "window")
  if (deferred.nextState.phase !== "window") return
  assert.equal(deferred.nextState.cursor, undefined)
  assert.equal(deferred.nextState.cursorRecoveryCount, undefined)
  assert.equal(deferred.nextState.windowSince, bounds.since)
  assert.equal(deferred.nextState.windowUntil, bounds.until)
  assert.deepEqual(
    calls.map((call) => call.cursor),
    ["expired-cursor", undefined, "replacement-cursor"]
  )

  stable = true
  const resumed = await executeCompletedWork(
    deferred.nextState,
    client,
    config,
    "2026-07-04T00:00:00Z",
    EXPECTED_USER
  )
  assert.equal(resumed.hasMore, false)
  assert.equal(resumed.nextState.phase, "checkpoint")
})

test("all capabilities enforce the deployment account before source reads", async () => {
  let sourceRequests = 0
  const client: TodoistClient = {
    async fetchAuthenticatedUser() {
      return { id: "different-user", timeZone: "UTC" }
    },
    async fetchCompletedTasksPage() {
      sourceRequests++
      return { resources: [], nextCursor: undefined }
    },
    async fetchProjectsPage() {
      sourceRequests++
      return { resources: [], nextCursor: undefined }
    },
  }

  await assert.rejects(
    () =>
      executeCompletedWork(
        undefined,
        client,
        () => ({ historyStart: "2026-07-01T00:00:00Z" }),
        "2026-07-03T00:00:00Z",
        EXPECTED_USER
      ),
    /does not match TODOIST_USER_ID/
  )
  await assert.rejects(
    () => executeProjects(undefined, client, EXPECTED_USER),
    /does not match TODOIST_USER_ID/
  )
  assert.equal(sourceRequests, 0)
})

test("projects execution does not emit delete changes for unavailable history", async () => {
  const active = await parsedProject("projects-active.json")
  const archived = await parsedProject("projects-archived.json")
  const client: TodoistClient = {
    async fetchAuthenticatedUser() {
      return AUTHENTICATED_USER
    },
    async fetchCompletedTasksPage() {
      return { resources: [], nextCursor: undefined }
    },
    async fetchProjectsPage(collection) {
      return {
        resources: collection === "active" ? [active] : [archived],
        nextCursor: undefined,
      }
    },
  }

  const first = await executeProjects(undefined, client, EXPECTED_USER)
  assert.equal(first.hasMore, true)
  assert.ok(first.changes.every((change) => change.type === "upsert"))
  const second = await executeProjects(first.nextState, client, EXPECTED_USER)
  assert.equal(second.hasMore, false)
  assert.equal(second.nextState.phase, "checkpoint")
  assert.ok(second.changes.every((change) => change.type === "upsert"))
})

test("projects bound invalid and repeated cursor recovery", async () => {
  const calls: Array<{ collection: string; cursor?: string }> = []
  const client: TodoistClient = {
    async fetchAuthenticatedUser() {
      return AUTHENTICATED_USER
    },
    async fetchCompletedTasksPage() {
      return { resources: [], nextCursor: undefined }
    },
    async fetchProjectsPage(collection, cursor) {
      calls.push({ collection, cursor })
      if (cursor === "expired-cursor") throw new InvalidCursorError()
      if (cursor) return { resources: [], nextCursor: cursor }
      return { resources: [], nextCursor: "replacement-cursor" }
    },
  }
  const recovered = await executeProjects(
    {
      phase: "active",
      userId: AUTHENTICATED_USER.id,
      cursor: "expired-cursor",
      recentCursors: ["expired-cursor"],
      pageCount: 1,
    },
    client,
    EXPECTED_USER
  )
  assert.equal(recovered.hasMore, true)
  assert.deepEqual(recovered.changes, [])
  assert.deepEqual(recovered.nextState, {
    phase: "active",
    userId: AUTHENTICATED_USER.id,
    cursorRecoveryCount: 1,
  })

  const retried = await executeProjects(
    recovered.nextState,
    client,
    EXPECTED_USER
  )
  assert.equal(retried.hasMore, true)
  assert.equal(retried.nextState.phase, "active")

  const deferred = await executeProjects(
    retried.nextState,
    client,
    EXPECTED_USER
  )
  assert.equal(deferred.hasMore, false)
  assert.deepEqual(deferred.nextState, {
    phase: "active",
    userId: AUTHENTICATED_USER.id,
  })
  assert.deepEqual(calls, [
    { collection: "active", cursor: "expired-cursor" },
    { collection: "active", cursor: undefined },
    { collection: "active", cursor: "replacement-cursor" },
  ])
})

test("HTTP failures are bounded, rate-aware, and never expose the API token", async () => {
  const now = Date.parse("2026-07-03T12:00:00Z")
  assert.equal(parseRetryAfterSeconds("7", now), 7)
  assert.equal(parseRetryAfterSeconds("Fri, 03 Jul 2026 12:00:09 GMT", now), 9)

  const limited = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async () =>
      Response.json(
        { error: "Slow down", error_extra: { retry_after: 11 } },
        { status: 429, headers: { "Retry-After": "7" } }
      ),
  })
  await assert.rejects(
    () => limited.fetchProjectsPage("active"),
    (error: unknown) => {
      assert.ok(error instanceof RateLimitError)
      assert.equal(error.retryAfter, 11)
      return true
    }
  )

  const temporarilyUnavailable = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async () =>
      Response.json(
        { error: "Try later", error_extra: { retry_after: 11 } },
        { status: 503, headers: { "Retry-After": "7" } }
      ),
  })
  await assert.rejects(
    () => temporarilyUnavailable.fetchProjectsPage("active"),
    (error: unknown) => {
      assert.ok(error instanceof RateLimitError)
      assert.equal(error.retryAfter, 11)
      return true
    }
  )

  const failed = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "secret-test-token",
    fetch: async () =>
      Response.json(
        {
          error: "Bad token secret-test-token and private provider detail",
          error_code: "AUTH_INVALID",
          error_extra: { retry_after: 5 },
        },
        { status: 401, headers: { "Retry-After": "7" } }
      ),
  })
  await assert.rejects(
    () => failed.fetchProjectsPage("active"),
    (error: unknown) => {
      assert.equal(error instanceof RateLimitError, false)
      assert.match(String(error), /error_code=AUTH_INVALID/)
      assert.doesNotMatch(String(error), /secret-test-token/)
      assert.doesNotMatch(String(error), /private provider detail/)
      return true
    }
  )

  const invalidCursor = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async () =>
      Response.json(
        {
          error: "Invalid argument value",
          error_code: 20,
          error_tag: "INVALID_ARGUMENT_VALUE",
          error_extra: { argument: "cursor" },
        },
        { status: 400 }
      ),
  })
  await assert.rejects(
    () => invalidCursor.fetchProjectsPage("active", "expired-cursor"),
    InvalidCursorError
  )

  const oversizedSuccess = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async () =>
      new Response("{}", {
        headers: {
          "Content-Length": String(MAX_SUCCESS_RESPONSE_BYTES + 1),
        },
      }),
  })
  await assert.rejects(
    () => oversizedSuccess.fetchProjectsPage("active"),
    /exceeded the .* safety limit/
  )

  const oversizedFailure = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async () =>
      new Response("private upstream response", {
        status: 500,
        headers: {
          "Content-Length": String(MAX_ERROR_RESPONSE_BYTES + 1),
        },
      }),
  })
  await assert.rejects(
    () => oversizedFailure.fetchProjectsPage("active"),
    (error: unknown) => {
      assert.match(String(error), /exceeded the safe size limit/)
      assert.doesNotMatch(String(error), /private upstream response/)
      return true
    }
  )

  const oversizedRetryableFailure = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async () =>
      new Response("private upstream response", {
        status: 503,
        headers: {
          "Content-Length": String(MAX_ERROR_RESPONSE_BYTES + 1),
          "Retry-After": "7",
        },
      }),
  })
  await assert.rejects(
    () => oversizedRetryableFailure.fetchProjectsPage("active"),
    (error: unknown) => {
      assert.ok(error instanceof RateLimitError)
      assert.equal(error.retryAfter, 7)
      return true
    }
  )

  const malformed = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async () => Response.json({ items: [] }),
  })
  await assert.rejects(
    () =>
      malformed.fetchCompletedTasksPage({
        since: "2026-07-01T00:00:00Z",
        until: "2026-07-03T00:00:00Z",
      }),
    /missing items or next_cursor/
  )

  const oversizedCursor = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    fetch: async () =>
      Response.json({
        items: [],
        next_cursor: "x".repeat(MAX_CURSOR_CHARACTERS + 1),
      }),
  })
  await assert.rejects(
    () =>
      oversizedCursor.fetchCompletedTasksPage({
        since: "2026-07-01T00:00:00Z",
        until: "2026-07-03T00:00:00Z",
      }),
    /oversized .*next_cursor/
  )
})

test("Todoist client times out stalled requests without exposing transport details", async () => {
  const client = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "test-token",
    requestTimeoutMs: 5,
    fetch: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        assert.ok(signal)
        if (signal.aborted) {
          reject(signal.reason)
          return
        }
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        })
      }),
  })

  // AbortSignal.timeout uses an unref'ed timer in Node; keep the event loop
  // alive long enough to observe the deterministic abort in this isolated test.
  const keepAlive = setTimeout(() => {}, 100)
  try {
    await assert.rejects(
      () => client.fetchAuthenticatedUser(),
      /timed out after 5ms/
    )
  } finally {
    clearTimeout(keepAlive)
  }
})
