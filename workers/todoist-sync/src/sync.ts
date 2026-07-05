// Two-pass replacement syncs for mutable Todoist inventories. Discovery pins
// an identity set; the second traversal must match it before replacement can
// finish and authorize deletion of rows that disappeared upstream.

import {
  aggregateCompletions,
  aggregateTasks,
  completionOccurrenceId,
  projectToChange,
  type ProjectAggregateMap,
} from "./projects.js"
import { taskToChange } from "./tasks.js"
import {
  assertExpectedTodoistUserId,
  getExpectedTodoistUserId,
  InvalidCursorError,
  type TodoistClient,
  type TodoistAuthenticatedUser,
} from "./todoist.js"

const DAY_MS = 86_400_000
const COMPLETION_LOOKBACK_MS = 7 * DAY_MS
const CONSISTENCY_BUFFER_MS = 60_000
const MAX_CURSOR_PAGES = 1_000
const MAX_SYNC_ITEMS = 5_000
const MAX_SYNC_STATE_BYTES = 200 * 1_024

type TaskPhase = "discovery" | "publish"
type ProjectPhase =
  | "taskDiscovery"
  | "tasks"
  | "completionDiscovery"
  | "completions"
  | "projectDiscovery"
  | "projects"

type TraversalState = {
  cursor?: string
  pageCount: number
  expectedIds: string[]
  seenIds: string[]
}

type SnapshotState = TraversalState & {
  userId: string
  timeZone: string
  observedAt: string
  restartAttempted?: true
}

export type TaskSyncState = SnapshotState & {
  phase: TaskPhase
}

export type ProjectSyncState = SnapshotState & {
  phase: ProjectPhase
  completionSince: string
  completionUntil: string
  aggregates: ProjectAggregateMap
}

type ExpectedUserProvider = () => string

class SyncConsistencyError extends Error {
  constructor(
    syncKey: "tasksSync" | "projectsSync",
    detail: string,
    readonly restartable = false
  ) {
    super(
      `${detail} Retry this continuation; if Todoist remains inconsistent, run \`ntn workers sync state reset ${syncKey}\` to start a fresh snapshot.`
    )
    this.name = "SyncConsistencyError"
  }
}

function iso(value: Date | string, context: string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Todoist ${context} must be a valid timestamp.`)
  }
  return date.toISOString()
}

function assertStateSize(value: unknown, syncKey: string): void {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
  if (bytes > MAX_SYNC_STATE_BYTES) {
    throw new Error(`Todoist ${syncKey} continuation state is too large.`)
  }
}

function assertTraversalState(
  state: SnapshotState & { phase: string },
  phases: ReadonlyArray<string>,
  user: TodoistAuthenticatedUser,
  syncKey: "tasksSync" | "projectsSync"
): void {
  assertStateSize(state, syncKey)
  if (!phases.includes(state.phase)) {
    throw new SyncConsistencyError(syncKey, "Todoist sync state is invalid.")
  }
  if (state.userId !== user.id) {
    throw new Error(
      `Todoist account changed during ${syncKey}; restore the expected account token or deploy a separate Worker.`
    )
  }
  if (
    !state.timeZone ||
    !Number.isFinite(Date.parse(state.observedAt)) ||
    !Number.isSafeInteger(state.pageCount) ||
    state.pageCount < 0 ||
    state.pageCount > MAX_CURSOR_PAGES ||
    (state.restartAttempted !== undefined && state.restartAttempted !== true) ||
    !Array.isArray(state.expectedIds) ||
    !Array.isArray(state.seenIds) ||
    state.expectedIds.length > MAX_SYNC_ITEMS ||
    state.seenIds.length > MAX_SYNC_ITEMS ||
    (state.cursor !== undefined &&
      (typeof state.cursor !== "string" || !state.cursor))
  ) {
    throw new SyncConsistencyError(syncKey, "Todoist sync state is invalid.")
  }
}

function initialTaskState(
  user: TodoistAuthenticatedUser,
  now: Date | string
): TaskSyncState {
  return {
    phase: "discovery",
    userId: user.id,
    timeZone: user.timeZone,
    observedAt: iso(now, "task observation time"),
    pageCount: 0,
    expectedIds: [],
    seenIds: [],
  }
}

function initialProjectState(
  user: TodoistAuthenticatedUser,
  now: Date | string
): ProjectSyncState {
  const observedAt = iso(now, "project observation time")
  const completionUntil = new Date(
    Date.parse(observedAt) - CONSISTENCY_BUFFER_MS
  ).toISOString()
  return {
    phase: "taskDiscovery",
    userId: user.id,
    timeZone: user.timeZone,
    observedAt,
    completionSince: new Date(
      Date.parse(completionUntil) - COMPLETION_LOOKBACK_MS
    ).toISOString(),
    completionUntil,
    aggregates: {},
    pageCount: 0,
    expectedIds: [],
    seenIds: [],
  }
}

function appendIds(
  prior: ReadonlyArray<string>,
  candidates: ReadonlyArray<string>,
  resource: string,
  syncKey: "tasksSync" | "projectsSync"
): string[] {
  const seen = new Set(prior)
  for (const id of candidates) {
    if (!id || seen.has(id)) {
      throw new SyncConsistencyError(
        syncKey,
        `Todoist ${resource} traversal repeated an identity.`
      )
    }
    seen.add(id)
    if (seen.size > MAX_SYNC_ITEMS) {
      throw new Error(
        `Todoist ${resource} traversal exceeded ${MAX_SYNC_ITEMS} records.`
      )
    }
  }
  return [...seen]
}

function assertExpectedPage(
  expectedIds: ReadonlyArray<string>,
  pageIds: ReadonlyArray<string>,
  resource: string,
  syncKey: "tasksSync" | "projectsSync"
): void {
  const expected = new Set(expectedIds)
  if (pageIds.some((id) => !expected.has(id))) {
    throw new SyncConsistencyError(
      syncKey,
      `Todoist ${resource} identities changed between traversals.`,
      true
    )
  }
}

function assertExactSet(
  expectedIds: ReadonlyArray<string>,
  seenIds: ReadonlyArray<string>,
  resource: string,
  syncKey: "tasksSync" | "projectsSync"
): void {
  const expected = new Set(expectedIds)
  if (
    seenIds.length !== expectedIds.length ||
    seenIds.some((id) => !expected.has(id))
  ) {
    throw new SyncConsistencyError(
      syncKey,
      `Todoist ${resource} identities changed between traversals.`,
      true
    )
  }
}

function continueTraversal<State extends SnapshotState & { phase: string }>(
  state: State,
  nextCursor: string,
  seenIds: string[],
  syncKey: "tasksSync" | "projectsSync"
): State {
  if (nextCursor === state.cursor) {
    throw new SyncConsistencyError(
      syncKey,
      "Todoist pagination repeated its current cursor."
    )
  }
  if (state.pageCount >= MAX_CURSOR_PAGES) {
    throw new SyncConsistencyError(
      syncKey,
      `Todoist pagination exceeded ${MAX_CURSOR_PAGES} pages.`
    )
  }
  const nextState = {
    ...state,
    cursor: nextCursor,
    pageCount: state.pageCount + 1,
    seenIds,
  }
  return nextState
}

function nextPhase<State extends SnapshotState & { phase: string }>(
  state: State,
  phase: State["phase"],
  expectedIds: string[] = []
): State {
  return {
    ...state,
    phase,
    cursor: undefined,
    pageCount: 0,
    expectedIds: [...expectedIds].sort(),
    seenIds: [],
  }
}

function more<State>(state: State): {
  changes: never[]
  hasMore: true
  nextState: State
}
function more<State, Change>(
  state: State,
  changes: Change[]
): {
  changes: Change[]
  hasMore: true
  nextState: State
}
function more<State>(state: State, changes: unknown[] = []) {
  assertStateSize(state, "sync")
  return { changes, hasMore: true as const, nextState: state }
}

function invalidCursor(
  error: unknown,
  cursor: string | undefined,
  syncKey: "tasksSync" | "projectsSync"
): never {
  if (error instanceof InvalidCursorError && cursor) {
    throw new SyncConsistencyError(
      syncKey,
      "Todoist rejected the saved pagination cursor.",
      true
    )
  }
  throw error
}

async function authenticatedState(
  client: TodoistClient,
  readExpectedUserId: ExpectedUserProvider
): Promise<TodoistAuthenticatedUser> {
  const user = await client.fetchAuthenticatedUser()
  assertExpectedTodoistUserId(user.id, readExpectedUserId())
  return user
}

async function executeTasksOnce(
  previousState: TaskSyncState | undefined,
  client: TodoistClient,
  readExpectedUserId: ExpectedUserProvider = () => getExpectedTodoistUserId(),
  now: Date | string = new Date()
) {
  const user = await authenticatedState(client, readExpectedUserId)
  const state = previousState ?? initialTaskState(user, now)
  assertTraversalState(state, ["discovery", "publish"], user, "tasksSync")

  let page
  try {
    page = await client.fetchTasksPage(state.cursor)
  } catch (error) {
    invalidCursor(error, state.cursor, "tasksSync")
  }

  const pageIds = page.resources.map((task) => task.id)
  if (state.phase === "publish") {
    assertExpectedPage(state.expectedIds, pageIds, "task", "tasksSync")
  }
  const seenIds = appendIds(state.seenIds, pageIds, "active-task", "tasksSync")
  const changes =
    state.phase === "publish"
      ? page.resources.map((task) =>
          taskToChange(task, state.timeZone, state.observedAt)
        )
      : []

  if (page.nextCursor) {
    return more(
      continueTraversal(state, page.nextCursor, seenIds, "tasksSync"),
      changes
    )
  }
  if (state.phase === "discovery") {
    return more(nextPhase(state, "publish", seenIds))
  }

  assertExactSet(state.expectedIds, seenIds, "task", "tasksSync")
  return { changes, hasMore: false as const }
}

export async function executeTasks(
  previousState: TaskSyncState | undefined,
  client: TodoistClient,
  readExpectedUserId: ExpectedUserProvider = () => getExpectedTodoistUserId(),
  now: Date | string = new Date()
) {
  try {
    return await executeTasksOnce(
      previousState,
      client,
      readExpectedUserId,
      now
    )
  } catch (error) {
    const canRestart =
      previousState &&
      !previousState.restartAttempted &&
      (previousState.phase === "discovery" ||
        (previousState.phase === "publish" &&
          previousState.seenIds.length === 0))
    if (
      error instanceof SyncConsistencyError &&
      error.restartable &&
      canRestart
    ) {
      const user = await authenticatedState(client, readExpectedUserId)
      return more({
        ...initialTaskState(user, now),
        restartAttempted: true as const,
      })
    }
    throw error
  }
}

async function executeProjectsOnce(
  previousState: ProjectSyncState | undefined,
  client: TodoistClient,
  readExpectedUserId: ExpectedUserProvider = () => getExpectedTodoistUserId(),
  now: Date | string = new Date()
) {
  const user = await authenticatedState(client, readExpectedUserId)
  const state = previousState ?? initialProjectState(user, now)
  assertTraversalState(
    state,
    [
      "taskDiscovery",
      "tasks",
      "completionDiscovery",
      "completions",
      "projectDiscovery",
      "projects",
    ],
    user,
    "projectsSync"
  )
  if (
    !Number.isFinite(Date.parse(state.completionSince)) ||
    !Number.isFinite(Date.parse(state.completionUntil)) ||
    !state.aggregates ||
    typeof state.aggregates !== "object" ||
    Array.isArray(state.aggregates)
  ) {
    throw new SyncConsistencyError(
      "projectsSync",
      "Todoist project sync state is invalid."
    )
  }

  if (state.phase === "taskDiscovery" || state.phase === "tasks") {
    let page
    try {
      page = await client.fetchTasksPage(state.cursor)
    } catch (error) {
      invalidCursor(error, state.cursor, "projectsSync")
    }
    const pageIds = page.resources.map((task) => task.id)
    if (state.phase === "tasks") {
      assertExpectedPage(
        state.expectedIds,
        pageIds,
        "active-task",
        "projectsSync"
      )
    }
    const seenIds = appendIds(
      state.seenIds,
      pageIds,
      "active-task",
      "projectsSync"
    )
    const aggregates =
      state.phase === "tasks"
        ? aggregateTasks(
            state.aggregates,
            page.resources,
            state.timeZone,
            state.observedAt
          )
        : state.aggregates
    const withAggregates = { ...state, aggregates }

    if (page.nextCursor) {
      return more(
        continueTraversal(
          withAggregates,
          page.nextCursor,
          seenIds,
          "projectsSync"
        )
      )
    }
    if (state.phase === "taskDiscovery") {
      return more(nextPhase(withAggregates, "tasks", seenIds))
    }
    assertExactSet(state.expectedIds, seenIds, "active-task", "projectsSync")
    return more(nextPhase(withAggregates, "completionDiscovery"))
  }

  if (state.phase === "completionDiscovery" || state.phase === "completions") {
    let page
    try {
      page = await client.fetchCompletedTasksPage({
        since: state.completionSince,
        until: state.completionUntil,
        cursor: state.cursor,
      })
    } catch (error) {
      invalidCursor(error, state.cursor, "projectsSync")
    }
    const pageIds = page.resources.map(completionOccurrenceId)
    if (state.phase === "completions") {
      assertExpectedPage(
        state.expectedIds,
        pageIds,
        "completion occurrence",
        "projectsSync"
      )
    }
    const seenIds = appendIds(
      state.seenIds,
      pageIds,
      "completion occurrence",
      "projectsSync"
    )
    const aggregates =
      state.phase === "completions"
        ? aggregateCompletions(
            state.aggregates,
            page.resources,
            state.completionSince,
            state.completionUntil
          )
        : state.aggregates
    const withAggregates = { ...state, aggregates }

    if (page.nextCursor) {
      return more(
        continueTraversal(
          withAggregates,
          page.nextCursor,
          seenIds,
          "projectsSync"
        )
      )
    }
    if (state.phase === "completionDiscovery") {
      return more(nextPhase(withAggregates, "completions", seenIds))
    }
    assertExactSet(
      state.expectedIds,
      seenIds,
      "completion occurrence",
      "projectsSync"
    )
    return more(nextPhase(withAggregates, "projectDiscovery"))
  }

  let page
  try {
    page = await client.fetchProjectsPage(state.cursor)
  } catch (error) {
    invalidCursor(error, state.cursor, "projectsSync")
  }
  const pageIds = page.resources.map((project) => project.id)
  if (state.phase === "projects") {
    assertExpectedPage(state.expectedIds, pageIds, "project", "projectsSync")
  }
  const seenIds = appendIds(state.seenIds, pageIds, "project", "projectsSync")

  if (state.phase === "projectDiscovery") {
    if (page.nextCursor) {
      return more(
        continueTraversal(state, page.nextCursor, seenIds, "projectsSync")
      )
    }
    return more(nextPhase(state, "projects", seenIds))
  }

  const aggregates = structuredClone(state.aggregates)
  const changes = page.resources.map((project) => {
    const change = projectToChange(
      project,
      aggregates[project.id],
      state.observedAt,
      state.timeZone
    )
    delete aggregates[project.id]
    return change
  })
  const withAggregates = { ...state, aggregates }

  if (page.nextCursor) {
    return more(
      continueTraversal(
        withAggregates,
        page.nextCursor,
        seenIds,
        "projectsSync"
      ),
      changes
    )
  }
  assertExactSet(state.expectedIds, seenIds, "project", "projectsSync")
  if (Object.values(aggregates).some((aggregate) => aggregate.openTasks > 0)) {
    throw new SyncConsistencyError(
      "projectsSync",
      "Todoist project inventory omitted a project referenced by an active task.",
      true
    )
  }
  return { changes, hasMore: false as const }
}

export async function executeProjects(
  previousState: ProjectSyncState | undefined,
  client: TodoistClient,
  readExpectedUserId: ExpectedUserProvider = () => getExpectedTodoistUserId(),
  now: Date | string = new Date()
) {
  try {
    return await executeProjectsOnce(
      previousState,
      client,
      readExpectedUserId,
      now
    )
  } catch (error) {
    const canRestart =
      previousState &&
      !previousState.restartAttempted &&
      (previousState.phase !== "projects" || previousState.seenIds.length === 0)
    if (
      error instanceof SyncConsistencyError &&
      error.restartable &&
      canRestart
    ) {
      const user = await authenticatedState(client, readExpectedUserId)
      return more({
        ...initialProjectState(user, now),
        restartAttempted: true as const,
      })
    }
    throw error
  }
}
