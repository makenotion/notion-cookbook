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
  COMPLETED_WINDOW_MS,
  CONSISTENCY_BUFFER_MS,
  currentCompletedWindow,
  currentProjectsSyncState,
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
})

test("completion windows stay bounded and checkpoint only after the final page", () => {
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

  state = nextCompletedSyncState(state, "cursor.page-2")
  assert.equal(state.phase, "window")
  if (state.phase !== "window") return
  assert.equal(state.cursor, "cursor.page-2")
  const cursorWindow = state
  assert.throws(
    () => nextCompletedSyncState(cursorWindow, "cursor.page-2"),
    /repeated a cursor/
  )

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
  const resumed = currentCompletedWindow(
    state,
    config,
    AUTHENTICATED_USER.id,
    "2026-04-15T01:00:00Z"
  )
  assert.equal(resumed.windowSince, state.since)
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

test("sync state pins the Todoist account and bounds cursor history", () => {
  const config = { historyStart: "2026-07-01T00:00:00Z" }
  let state = currentCompletedWindow(
    undefined,
    config,
    AUTHENTICATED_USER.id,
    "2026-07-03T00:00:00Z"
  )
  for (let index = 1; index <= MAX_RECENT_CURSORS + 2; index++) {
    const next = nextCompletedSyncState(state, `cursor-${index}`)
    assert.equal(next.phase, "window")
    if (next.phase !== "window") return
    state = next
  }
  assert.equal(state.recentCursors?.length, MAX_RECENT_CURSORS)
  assert.equal(state.pageCount, MAX_RECENT_CURSORS + 2)

  assert.throws(
    () => nextCompletedSyncState(state, "x".repeat(MAX_CURSOR_CHARACTERS + 1)),
    /oversized cursor/
  )
  assert.throws(
    () =>
      nextCompletedSyncState(
        {
          ...state,
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

test("execute functions keep cursors in-cycle and only publish durable checkpoints at completion", async () => {
  const tasks = await parsedCompletedTasks()
  const calls: Array<{ since: string; until: string; cursor?: string }> = []
  const client: TodoistClient = {
    async fetchAuthenticatedUser() {
      return AUTHENTICATED_USER
    },
    async fetchCompletedTasksPage(options) {
      calls.push(clone(options))
      return {
        resources: options.cursor ? [] : tasks,
        nextCursor: options.cursor ? undefined : "next.page",
      }
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
    "2026-07-03T00:00:00Z"
  )
  assert.equal(first.hasMore, true)
  assert.equal(first.changes.length, 2)
  assert.equal(first.nextState.phase, "window")

  const second = await executeCompletedWork(
    first.nextState,
    client,
    config,
    "2026-07-04T00:00:00Z"
  )
  assert.equal(second.hasMore, false)
  assert.equal(second.nextState.phase, "checkpoint")
  assert.deepEqual(calls[0], {
    since: calls[0]!.since,
    until: calls[0]!.until,
    cursor: undefined,
  })
  assert.equal(calls[1]?.since, calls[0]?.since)
  assert.equal(calls[1]?.until, calls[0]?.until)
  assert.equal(calls[1]?.cursor, "next.page")
})

test("execute functions reject account changes before reading source pages", async () => {
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
        {
          phase: "checkpoint",
          userId: AUTHENTICATED_USER.id,
          since: "2026-07-01T00:00:00Z",
        },
        client,
        () => ({ historyStart: "2026-07-01T00:00:00Z" }),
        "2026-07-03T00:00:00Z"
      ),
    /account changed/
  )
  await assert.rejects(
    () =>
      executeProjects(
        { phase: "checkpoint", userId: AUTHENTICATED_USER.id },
        client
      ),
    /account changed/
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

  const first = await executeProjects(undefined, client)
  assert.equal(first.hasMore, true)
  assert.ok(first.changes.every((change) => change.type === "upsert"))
  const second = await executeProjects(first.nextState, client)
  assert.equal(second.hasMore, false)
  assert.equal(second.nextState.phase, "checkpoint")
  assert.ok(second.changes.every((change) => change.type === "upsert"))
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

  const failed = createTodoistClient({
    beforeRequest: async () => {},
    getApiToken: () => "secret-test-token",
    fetch: async () =>
      Response.json(
        {
          error: "Bad token secret-test-token and private provider detail",
          error_code: "AUTH_INVALID",
        },
        { status: 401 }
      ),
  })
  await assert.rejects(
    () => failed.fetchProjectsPage("active"),
    (error: unknown) => {
      assert.match(String(error), /error_code=AUTH_INVALID/)
      assert.doesNotMatch(String(error), /secret-test-token/)
      assert.doesNotMatch(String(error), /private provider detail/)
      return true
    }
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
