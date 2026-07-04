// Replacement-safe cursor and aggregation state. Every cycle pins its user,
// timezone, and observation window until the final page succeeds.

import { createHash } from "node:crypto"

import {
  MAX_AGGREGATED_ITEMS,
  MAX_AGGREGATED_PROJECTS,
  MAX_RECENT_COMPLETIONS,
  type ProjectAggregateMap,
} from "./projects.js"
import { MAX_CURSOR_CHARACTERS, MAX_USER_ID_CHARACTERS } from "./todoist.js"

const DAY_MS = 86_400_000
export const COMPLETION_LOOKBACK_MS = 7 * DAY_MS
export const CONSISTENCY_BUFFER_MS = 60_000
export const MAX_CURSOR_PAGES = 1_000
export const MAX_SYNC_STATE_BYTES = 200 * 1_024
const MAX_ID_CHARACTERS = 256
const STATE_VERSION = 1

type CursorState = {
  cursor?: string
  cursorFingerprints?: string[]
  pageCount?: number
}

type SnapshotState = CursorState & {
  version: typeof STATE_VERSION
  userId: string
  timeZone: string
  observedAt: string
  restartCount?: number
}

export type TaskSyncState = SnapshotState & {
  phase: "discovery" | "publish"
  expectedTaskIds: string[]
  seenTaskIds: string[]
}

export type ProjectSummaryPhase =
  | "taskDiscovery"
  | "tasks"
  | "completions"
  | "projectDiscovery"
  | "projects"

export type ProjectSummaryState = SnapshotState & {
  phase: ProjectSummaryPhase
  completionSince: string
  completionUntil: string
  aggregates: ProjectAggregateMap
  expectedTaskIds: string[]
  seenTaskIds: string[]
  seenCompletionIds: string[]
  expectedProjectIds: string[]
  seenProjectIds: string[]
}

export class CursorPaginationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CursorPaginationError"
  }
}

function timestamp(value: Date | string, context: string): number {
  const milliseconds =
    value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Todoist ${context} must be a valid timestamp.`)
  }
  return milliseconds
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString()
}

function validTimeZone(value: unknown, context: string): string {
  const timeZone = typeof value === "string" ? value.trim() : ""
  if (!timeZone) throw new Error(`Todoist ${context} has an empty timezone.`)
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format()
  } catch {
    throw new Error(`Todoist ${context} has an invalid timezone.`)
  }
  return timeZone
}

function validId(value: unknown, context: string): string {
  const id = typeof value === "string" ? value.trim() : ""
  if (!id) throw new Error(`Todoist ${context} has an empty ID.`)
  if (Array.from(id).length > MAX_ID_CHARACTERS) {
    throw new Error(`Todoist ${context} has an oversized ID.`)
  }
  return id
}

function validatedUserId(value: unknown, resource: string): string {
  const userId = validId(value, `${resource} sync state`)
  if (Array.from(userId).length > MAX_USER_ID_CHARACTERS) {
    throw new Error(`Todoist ${resource} sync state has an oversized user ID.`)
  }
  return userId
}

export function getExpectedTodoistUserId(
  env: NodeJS.ProcessEnv = process.env
): string {
  const userId = env.TODOIST_USER_ID?.trim() ?? ""
  if (!userId) throw new Error("TODOIST_USER_ID is not set.")
  if (Array.from(userId).length > MAX_USER_ID_CHARACTERS) {
    throw new Error("TODOIST_USER_ID is oversized.")
  }
  return userId
}

export function assertExpectedTodoistUserId(
  authenticatedUserId: string,
  expectedUserId: string
): void {
  const authenticated = validatedUserId(
    authenticatedUserId,
    "deployment account"
  )
  const expected = expectedUserId.trim()
  if (!expected || Array.from(expected).length > MAX_USER_ID_CHARACTERS) {
    throw new Error("TODOIST_USER_ID is invalid.")
  }
  if (authenticated !== expected) {
    throw new Error(
      "Todoist account does not match TODOIST_USER_ID; restore the expected account token or deploy a separate Worker."
    )
  }
}

function stateBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function assertStateSize(value: unknown, resource: string): void {
  if (stateBytes(value) > MAX_SYNC_STATE_BYTES) {
    throw new Error(`Todoist ${resource} sync state exceeded its size bound.`)
  }
}

function cursorFingerprint(cursor: string): string {
  return createHash("sha256").update(cursor).digest("hex").slice(0, 16)
}

function assertCursor(
  value: unknown,
  resource: string
): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error(`Todoist ${resource} sync state has an empty cursor.`)
  }
  if (Array.from(value).length > MAX_CURSOR_CHARACTERS) {
    throw new Error(`Todoist ${resource} sync state has an oversized cursor.`)
  }
}

function assertStringList(
  value: unknown,
  resource: string,
  maximum: number
): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`Todoist ${resource} sync state has an invalid ID list.`)
  }
  const unique = new Set<string>()
  for (const candidate of value) {
    const id = validId(candidate, resource)
    if (unique.has(id)) {
      throw new Error(`Todoist ${resource} sync state repeated an ID.`)
    }
    unique.add(id)
  }
}

function assertCursorState(state: CursorState, resource: string): void {
  if (state.cursor !== undefined) assertCursor(state.cursor, resource)
  const fingerprints = state.cursorFingerprints ?? []
  if (!Array.isArray(fingerprints) || fingerprints.length > MAX_CURSOR_PAGES) {
    throw new Error(`Todoist ${resource} sync state has invalid cursors.`)
  }
  const unique = new Set<string>()
  for (const fingerprint of fingerprints) {
    if (
      typeof fingerprint !== "string" ||
      !/^[a-f0-9]{16}$/u.test(fingerprint)
    ) {
      throw new Error(`Todoist ${resource} sync state has invalid cursors.`)
    }
    if (unique.has(fingerprint)) {
      throw new Error(`Todoist ${resource} sync state repeated a cursor.`)
    }
    unique.add(fingerprint)
  }

  const pageCount = state.pageCount ?? 0
  if (
    !Number.isSafeInteger(pageCount) ||
    pageCount < 0 ||
    pageCount > MAX_CURSOR_PAGES ||
    pageCount !== fingerprints.length ||
    (state.cursor === undefined && pageCount !== 0) ||
    (state.cursor !== undefined &&
      fingerprints.at(-1) !== cursorFingerprint(state.cursor))
  ) {
    throw new Error(`Todoist ${resource} sync state has invalid pagination.`)
  }
}

function assertRestartCount(value: unknown, resource: string): void {
  if (value !== undefined && value !== 0 && value !== 1) {
    throw new Error(`Todoist ${resource} sync state has invalid recovery.`)
  }
}

function assertSnapshotState(state: SnapshotState, resource: string): void {
  if (state.version !== STATE_VERSION) {
    throw new Error(`Todoist ${resource} sync state has an invalid version.`)
  }
  validatedUserId(state.userId, resource)
  validTimeZone(state.timeZone, `${resource} sync state`)
  timestamp(state.observedAt, `${resource} observation time`)
  assertRestartCount(state.restartCount, resource)
  assertCursorState(state, resource)
}

function nonnegativeInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Todoist project summary has invalid ${context}.`)
  }
  return value as number
}

function assertAggregates(
  aggregates: unknown
): asserts aggregates is ProjectAggregateMap {
  if (
    !aggregates ||
    typeof aggregates !== "object" ||
    Array.isArray(aggregates)
  ) {
    throw new Error("Todoist project summary has invalid aggregates.")
  }
  const entries = Object.entries(aggregates)
  if (entries.length > MAX_AGGREGATED_PROJECTS) {
    throw new Error("Todoist project summary exceeded its project bound.")
  }
  for (const [projectId, value] of entries) {
    validId(projectId, "project aggregate")
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Todoist project summary has an invalid aggregate.")
    }
    const aggregate = value as ProjectAggregateMap[string]
    if (aggregate.projectId !== projectId) {
      throw new Error("Todoist project summary has a mismatched project ID.")
    }
    for (const field of [
      "openTasks",
      "overdue",
      "dueNextSevenDays",
      "completedLastSevenDays",
      "unscheduled",
      "p1Tasks",
      "plannedMinutesNextSevenDays",
    ] as const) {
      nonnegativeInteger(aggregate[field], field)
    }
    if (
      !Array.isArray(aggregate.recentCompletions) ||
      aggregate.recentCompletions.length > MAX_RECENT_COMPLETIONS ||
      aggregate.recentCompletions.length > aggregate.completedLastSevenDays
    ) {
      throw new Error("Todoist project summary has invalid recent completions.")
    }
    for (const completion of aggregate.recentCompletions) {
      validId(completion.occurrenceId, "recent completion")
      if (!completion.title.trim()) {
        throw new Error(
          "Todoist project summary has an empty completion title."
        )
      }
      timestamp(completion.completedAt, "recent completion time")
    }
    if (aggregate.lastCompleted !== null) {
      timestamp(aggregate.lastCompleted, "last completion time")
    }
    if (aggregate.nextDue !== null) {
      if (!aggregate.nextDue.date.trim() || !aggregate.nextDue.sortKey.trim()) {
        throw new Error("Todoist project summary has invalid next due data.")
      }
    }
    if (aggregate.nextDeadline !== null) {
      timestamp(`${aggregate.nextDeadline}T00:00:00Z`, "next project deadline")
    }
  }
}

function assertSameUser(
  stateUserId: string,
  authenticatedUserId: string,
  resource: string
): void {
  if (
    validatedUserId(stateUserId, resource) !==
    validatedUserId(authenticatedUserId, resource)
  ) {
    throw new Error(
      `Todoist account changed during the ${resource} sync; restore the original account token or deploy a new Worker for the other account.`
    )
  }
}

function assertSameIdentities(
  expectedIds: ReadonlyArray<string>,
  seenIds: ReadonlyArray<string>,
  resource: string
): void {
  const expected = new Set(expectedIds)
  if (
    seenIds.length !== expectedIds.length ||
    seenIds.some((id) => !expected.has(id))
  ) {
    throw new CursorPaginationError(
      `Todoist ${resource} identities changed between discovery and publish.`
    )
  }
}

function initialTaskState(
  userId: string,
  timeZone: string,
  observedAt: Date | string,
  restartCount?: number
): TaskSyncState {
  return {
    version: STATE_VERSION,
    phase: "discovery",
    userId: validatedUserId(userId, "tasks"),
    timeZone: validTimeZone(timeZone, "tasks"),
    observedAt: iso(timestamp(observedAt, "tasks observation time")),
    expectedTaskIds: [],
    seenTaskIds: [],
    ...(restartCount ? { restartCount } : {}),
  }
}

export function currentTaskSyncState(
  previousState: TaskSyncState | undefined,
  authenticatedUserId: string,
  timeZone: string,
  now: Date | string = new Date()
): TaskSyncState {
  if (!previousState || previousState.version === undefined) {
    return initialTaskState(authenticatedUserId, timeZone, now)
  }
  assertSnapshotState(previousState, "tasks")
  if (!["discovery", "publish"].includes(previousState.phase)) {
    throw new Error("Todoist tasks sync state has an invalid phase.")
  }
  assertSameUser(previousState.userId, authenticatedUserId, "tasks")
  assertStringList(
    previousState.expectedTaskIds,
    "expected tasks",
    MAX_AGGREGATED_ITEMS
  )
  assertStringList(previousState.seenTaskIds, "tasks", MAX_AGGREGATED_ITEMS)
  assertStateSize(previousState, "tasks")
  return previousState
}

function initialProjectState(
  userId: string,
  timeZone: string,
  observedAt: Date | string,
  restartCount?: number
): ProjectSummaryState {
  const observationMs = timestamp(observedAt, "project observation time")
  const completionUntilMs = observationMs - CONSISTENCY_BUFFER_MS
  return {
    version: STATE_VERSION,
    phase: "taskDiscovery",
    userId: validatedUserId(userId, "projects"),
    timeZone: validTimeZone(timeZone, "projects"),
    observedAt: iso(observationMs),
    completionSince: iso(completionUntilMs - COMPLETION_LOOKBACK_MS),
    completionUntil: iso(completionUntilMs),
    aggregates: {},
    expectedTaskIds: [],
    seenTaskIds: [],
    seenCompletionIds: [],
    expectedProjectIds: [],
    seenProjectIds: [],
    ...(restartCount ? { restartCount } : {}),
  }
}

function assertProjectState(state: ProjectSummaryState): void {
  assertSnapshotState(state, "projects")
  if (
    ![
      "taskDiscovery",
      "tasks",
      "completions",
      "projectDiscovery",
      "projects",
    ].includes(state.phase)
  ) {
    throw new Error("Todoist projects sync state has an invalid phase.")
  }
  const observedAt = timestamp(state.observedAt, "project observation time")
  const completionSince = timestamp(state.completionSince, "completion start")
  const completionUntil = timestamp(state.completionUntil, "completion end")
  if (
    completionUntil !== observedAt - CONSISTENCY_BUFFER_MS ||
    completionUntil - completionSince !== COMPLETION_LOOKBACK_MS
  ) {
    throw new Error(
      "Todoist projects sync state has invalid completion bounds."
    )
  }
  assertAggregates(state.aggregates)
  assertStringList(
    state.expectedTaskIds,
    "expected project task IDs",
    MAX_AGGREGATED_ITEMS
  )
  assertStringList(state.seenTaskIds, "project task IDs", MAX_AGGREGATED_ITEMS)
  assertStringList(
    state.seenCompletionIds,
    "project completion IDs",
    MAX_AGGREGATED_ITEMS
  )
  assertStringList(
    state.expectedProjectIds,
    "expected project IDs",
    MAX_AGGREGATED_ITEMS
  )
  assertStringList(
    state.seenProjectIds,
    "seen project IDs",
    MAX_AGGREGATED_ITEMS
  )
  assertStateSize(state, "projects")
}

export function currentProjectSummaryState(
  previousState: ProjectSummaryState | undefined,
  authenticatedUserId: string,
  timeZone: string,
  now: Date | string = new Date()
): ProjectSummaryState {
  // Migrate the old incremental-project continuation by starting a fresh
  // replacement snapshot. New-version malformed state still fails closed.
  if (!previousState || previousState.version === undefined) {
    return initialProjectState(authenticatedUserId, timeZone, now)
  }
  assertProjectState(previousState)
  assertSameUser(previousState.userId, authenticatedUserId, "projects")
  return previousState
}

function nextCursorState(
  state: CursorState,
  nextCursor: string,
  resource: string
): Required<CursorState> {
  assertCursor(nextCursor, resource)
  assertCursorState(state, resource)
  const fingerprint = cursorFingerprint(nextCursor)
  const fingerprints = [...(state.cursorFingerprints ?? [])]
  if (fingerprints.includes(fingerprint)) {
    throw new CursorPaginationError(
      `Todoist ${resource} pagination repeated a cursor.`
    )
  }
  if (fingerprints.length >= MAX_CURSOR_PAGES) {
    throw new CursorPaginationError(
      `Todoist ${resource} pagination exceeded ${MAX_CURSOR_PAGES} pages.`
    )
  }
  fingerprints.push(fingerprint)
  return {
    cursor: nextCursor,
    cursorFingerprints: fingerprints,
    pageCount: fingerprints.length,
  }
}

export function nextTaskSyncState(
  state: TaskSyncState,
  nextCursor: string | undefined,
  seenTaskIds: string[]
): TaskSyncState | undefined {
  currentTaskSyncState(state, state.userId, state.timeZone, state.observedAt)
  assertStringList(seenTaskIds, "tasks", MAX_AGGREGATED_ITEMS)
  const base: TaskSyncState = {
    ...state,
    seenTaskIds,
  }
  assertStateSize(base, "tasks")
  if (nextCursor) {
    const nextState: TaskSyncState = {
      ...base,
      ...nextCursorState(state, nextCursor, `${state.phase} tasks`),
    }
    assertStateSize(nextState, "tasks")
    return nextState
  }
  if (state.phase === "discovery") {
    const nextState: TaskSyncState = {
      ...base,
      phase: "publish",
      expectedTaskIds: [...seenTaskIds].sort(),
      seenTaskIds: [],
      cursor: undefined,
      cursorFingerprints: undefined,
      pageCount: undefined,
    }
    currentTaskSyncState(
      nextState,
      nextState.userId,
      nextState.timeZone,
      nextState.observedAt
    )
    return nextState
  }
  assertSameIdentities(state.expectedTaskIds, seenTaskIds, "task")
  return undefined
}

export function nextProjectSummaryState(
  state: ProjectSummaryState,
  nextCursor: string | undefined,
  updates: {
    aggregates?: ProjectAggregateMap
    seenTaskIds?: string[]
    seenCompletionIds?: string[]
    seenProjectIds?: string[]
  } = {}
): ProjectSummaryState | undefined {
  assertProjectState(state)
  const base = {
    ...state,
    aggregates: updates.aggregates ?? state.aggregates,
    seenTaskIds: updates.seenTaskIds ?? state.seenTaskIds,
    seenCompletionIds: updates.seenCompletionIds ?? state.seenCompletionIds,
    seenProjectIds: updates.seenProjectIds ?? state.seenProjectIds,
  }
  assertProjectState(base)
  if (nextCursor) {
    const nextState = {
      ...base,
      ...nextCursorState(state, nextCursor, `${state.phase} projects`),
    }
    assertProjectState(nextState)
    return nextState
  }
  let nextState: ProjectSummaryState | undefined
  switch (state.phase) {
    case "taskDiscovery":
      nextState = {
        ...base,
        phase: "tasks",
        expectedTaskIds: [...base.seenTaskIds].sort(),
        seenTaskIds: [],
        cursor: undefined,
        cursorFingerprints: undefined,
        pageCount: undefined,
      }
      break
    case "tasks":
      assertSameIdentities(
        state.expectedTaskIds,
        base.seenTaskIds,
        "active-task"
      )
      nextState = {
        ...base,
        phase: "completions",
        expectedTaskIds: [],
        seenTaskIds: [],
        cursor: undefined,
        cursorFingerprints: undefined,
        pageCount: undefined,
      }
      break
    case "completions":
      nextState = {
        ...base,
        phase: "projectDiscovery",
        seenCompletionIds: [],
        cursor: undefined,
        cursorFingerprints: undefined,
        pageCount: undefined,
      }
      break
    case "projectDiscovery":
      nextState = {
        ...base,
        phase: "projects",
        expectedProjectIds: [...base.seenProjectIds].sort(),
        seenProjectIds: [],
        cursor: undefined,
        cursorFingerprints: undefined,
        pageCount: undefined,
      }
      break
    case "projects":
      assertSameIdentities(
        state.expectedProjectIds,
        base.seenProjectIds,
        "project"
      )
      nextState = undefined
      break
  }
  if (!nextState) return undefined
  assertProjectState(nextState)
  return nextState
}

export function restartTaskSyncState(state: TaskSyncState): TaskSyncState {
  currentTaskSyncState(state, state.userId, state.timeZone, state.observedAt)
  if ((state.restartCount ?? 0) >= 1) {
    throw new CursorPaginationError(
      "Todoist tasks pagination failed again after one bounded restart."
    )
  }
  return initialTaskState(state.userId, state.timeZone, state.observedAt, 1)
}

export function restartProjectSummaryState(
  state: ProjectSummaryState
): ProjectSummaryState {
  assertProjectState(state)
  if ((state.restartCount ?? 0) >= 1) {
    throw new CursorPaginationError(
      "Todoist project-summary pagination failed again after one bounded restart."
    )
  }
  return initialProjectState(state.userId, state.timeZone, state.observedAt, 1)
}
