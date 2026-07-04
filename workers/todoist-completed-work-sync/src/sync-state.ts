// Pure state transitions for bounded completion-date windows and immediate
// Todoist cursor pagination. Paginated completion windows are replayed once
// before their durable timestamp checkpoint advances.

import {
  MAX_CURSOR_CHARACTERS,
  MAX_USER_ID_CHARACTERS,
  type TodoistProjectCollection,
} from "./todoist.js"

const DAY_MS = 86_400_000
export const COMPLETED_WINDOW_DAYS = 30
export const COMPLETED_WINDOW_MS = COMPLETED_WINDOW_DAYS * DAY_MS
export const COMPLETED_OVERLAP_MS = DAY_MS
export const COMPLETED_RECONCILIATION_MS = DAY_MS
export const CONSISTENCY_BUFFER_MS = 60_000
export const DEFAULT_HISTORY_LOOKBACK_DAYS = 365
export const MAX_CURSOR_PAGES = 1_000
export const MAX_RECENT_CURSORS = 32
export const MAX_SYNC_STATE_BYTES = 200 * 1_024

export type TodoistSyncConfig = {
  historyStart: string
}

export type CompletedWindowState = {
  phase: "window"
  userId: string
  historyStart: string
  reconciliation: boolean
  lastReconciledAt?: string
  cycleSince: string
  cycleUntil: string
  windowSince: string
  windowUntil: string
  pass?: "primary" | "replay"
  cursor?: string
  recentCursors?: string[]
  pageCount?: number
  cursorRecoveryCount?: number
}

export type CompletedCheckpointState = {
  phase: "checkpoint"
  userId: string
  historyStart: string
  since: string
  lastReconciledAt?: string
}

export type CompletedSyncState = CompletedWindowState | CompletedCheckpointState

export type ProjectsScanState = {
  phase: TodoistProjectCollection
  userId: string
  cursor?: string
  recentCursors?: string[]
  pageCount?: number
  cursorRecoveryCount?: number
}

export type ProjectsCheckpointState = {
  phase: "checkpoint"
  userId: string
}

export type ProjectsSyncState = ProjectsScanState | ProjectsCheckpointState

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
    throw new Error(`Todoist ${context} must be a valid date or timestamp.`)
  }
  return milliseconds
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString()
}

function validatedUserId(value: unknown, resource: string): string {
  const userId = typeof value === "string" ? value.trim() : ""
  if (!userId) {
    throw new Error(`Todoist ${resource} sync state has an invalid user ID.`)
  }
  if (Array.from(userId).length > MAX_USER_ID_CHARACTERS) {
    throw new Error(`Todoist ${resource} sync state has an oversized user ID.`)
  }
  return userId
}

export function getExpectedTodoistUserId(
  env: NodeJS.ProcessEnv = process.env
): string {
  const userId = env.TODOIST_USER_ID?.trim() ?? ""
  if (!userId) {
    throw new Error("TODOIST_USER_ID is not set.")
  }
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

function stateBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function assertStateSize(value: unknown, resource: string): void {
  if (stateBytes(value) > MAX_SYNC_STATE_BYTES) {
    throw new Error(`Todoist ${resource} sync state exceeded its size bound.`)
  }
}

function assertCursorValue(
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

type CursorBearingState = {
  cursor?: string
  recentCursors?: string[]
  pageCount?: number
  cursorRecoveryCount?: number
}

function assertCursorState(state: CursorBearingState, resource: string): void {
  if (state.cursor !== undefined) assertCursorValue(state.cursor, resource)

  if (
    state.recentCursors !== undefined &&
    !Array.isArray(state.recentCursors)
  ) {
    throw new Error(
      `Todoist ${resource} sync state has invalid cursor history.`
    )
  }
  const recent = state.recentCursors ?? []
  if (recent.length > MAX_RECENT_CURSORS) {
    throw new Error(
      `Todoist ${resource} sync state exceeded its cursor history bound.`
    )
  }
  const unique = new Set<string>()
  for (const cursor of recent) {
    assertCursorValue(cursor, resource)
    if (unique.has(cursor)) {
      throw new Error(`Todoist ${resource} sync state repeated a cursor.`)
    }
    unique.add(cursor)
  }
  if (state.cursor && recent.at(-1) !== state.cursor) {
    throw new Error(`Todoist ${resource} sync state has inconsistent cursors.`)
  }

  const pageCount = state.pageCount ?? 0
  if (
    !Number.isSafeInteger(pageCount) ||
    pageCount < 0 ||
    pageCount >= MAX_CURSOR_PAGES ||
    (state.cursor === undefined && pageCount !== 0) ||
    (state.cursor !== undefined && pageCount === 0)
  ) {
    throw new Error(`Todoist ${resource} sync state has an invalid page count.`)
  }
  const cursorRecoveryCount = state.cursorRecoveryCount ?? 0
  if (cursorRecoveryCount !== 0 && cursorRecoveryCount !== 1) {
    throw new Error(
      `Todoist ${resource} sync state has an invalid cursor recovery count.`
    )
  }
  assertStateSize(state, resource)
}

function parseHistoryStart(value: string): string {
  const trimmed = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return iso(timestamp(`${trimmed}T00:00:00Z`, "history start"))
  }
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(trimmed)) {
    throw new Error(
      "TODOIST_HISTORY_START timestamps must include Z or a UTC offset."
    )
  }
  return iso(timestamp(trimmed, "history start"))
}

export function getTodoistSyncConfig(
  env: NodeJS.ProcessEnv = process.env,
  now: Date | string = new Date()
): TodoistSyncConfig {
  const nowMs = timestamp(now, "configuration time")
  const configuredStart = env.TODOIST_HISTORY_START?.trim()
  return {
    historyStart: configuredStart
      ? parseHistoryStart(configuredStart)
      : iso(nowMs - DEFAULT_HISTORY_LOOKBACK_DAYS * DAY_MS),
  }
}

function assertCompletedWindow(state: CompletedWindowState): void {
  validatedUserId(state.userId, "completed-work")
  const historyStart = timestamp(
    state.historyStart ?? state.cycleSince,
    "history start"
  )
  const cycleSince = timestamp(state.cycleSince, "cycle start")
  const cycleUntil = timestamp(state.cycleUntil, "cycle end")
  const windowSince = timestamp(state.windowSince, "window start")
  const windowUntil = timestamp(state.windowUntil, "window end")

  if (
    historyStart > cycleSince ||
    cycleSince > windowSince ||
    windowSince >= windowUntil ||
    windowUntil > cycleUntil ||
    windowUntil - windowSince > COMPLETED_WINDOW_MS
  ) {
    throw new Error("Todoist completed-work sync state has invalid bounds.")
  }
  if (
    state.reconciliation !== undefined &&
    typeof state.reconciliation !== "boolean"
  ) {
    throw new Error(
      "Todoist completed-work sync state has an invalid reconciliation flag."
    )
  }
  if (state.lastReconciledAt !== undefined) {
    timestamp(state.lastReconciledAt, "last reconciliation")
  }
  if (
    state.pass !== undefined &&
    state.pass !== "primary" &&
    state.pass !== "replay"
  ) {
    throw new Error("Todoist completed-work sync state has an invalid pass.")
  }
  assertCursorState(state, "completed-work")
}

function windowState(
  userId: string,
  historyStart: string,
  cycleSinceMs: number,
  cycleUntilMs: number,
  reconciliation: boolean,
  lastReconciledAt?: string
): CompletedWindowState {
  return {
    phase: "window",
    userId,
    historyStart,
    reconciliation,
    ...(lastReconciledAt ? { lastReconciledAt } : {}),
    cycleSince: iso(cycleSinceMs),
    cycleUntil: iso(cycleUntilMs),
    windowSince: iso(cycleSinceMs),
    windowUntil: iso(
      Math.min(cycleSinceMs + COMPLETED_WINDOW_MS, cycleUntilMs)
    ),
    pass: "primary",
  }
}

export function currentCompletedWindow(
  previousState: CompletedSyncState | undefined,
  config: TodoistSyncConfig,
  authenticatedUserId: string,
  now: Date | string = new Date()
): CompletedWindowState {
  const userId = validatedUserId(authenticatedUserId, "completed-work")
  const previousPhase: unknown = previousState?.phase
  if (
    previousState &&
    previousPhase !== "window" &&
    previousPhase !== "checkpoint"
  ) {
    throw new Error("Todoist completed-work sync state has an invalid phase.")
  }
  if (previousState?.phase === "window") {
    assertCompletedWindow(previousState)
    assertSameUser(previousState.userId, userId, "completed-work")
    const configuredHistoryStartMs = timestamp(
      config.historyStart,
      "history start"
    )
    return {
      phase: "window",
      userId,
      historyStart:
        previousState.historyStart ??
        iso(
          Math.min(
            configuredHistoryStartMs,
            timestamp(previousState.cycleSince, "cycle start")
          )
        ),
      reconciliation: previousState.reconciliation ?? false,
      ...(previousState.lastReconciledAt
        ? { lastReconciledAt: previousState.lastReconciledAt }
        : {}),
      cycleSince: previousState.cycleSince,
      cycleUntil: previousState.cycleUntil,
      windowSince: previousState.windowSince,
      windowUntil: previousState.windowUntil,
      pass: previousState.pass ?? "primary",
      ...(previousState.cursor ? { cursor: previousState.cursor } : {}),
      ...(previousState.recentCursors
        ? { recentCursors: previousState.recentCursors }
        : {}),
      ...(previousState.pageCount !== undefined
        ? { pageCount: previousState.pageCount }
        : {}),
      ...(previousState.cursorRecoveryCount
        ? { cursorRecoveryCount: previousState.cursorRecoveryCount }
        : {}),
    }
  }

  if (previousState?.phase === "checkpoint") {
    assertSameUser(previousState.userId, userId, "completed-work")
    timestamp(previousState.since, "checkpoint")
    if (previousState.historyStart !== undefined) {
      timestamp(previousState.historyStart, "history start")
    }
    if (previousState.lastReconciledAt !== undefined) {
      timestamp(previousState.lastReconciledAt, "last reconciliation")
    }
    assertStateSize(previousState, "completed-work")
  }

  const cycleUntilMs =
    timestamp(now, "cycle observation time") - CONSISTENCY_BUFFER_MS
  const historyStart =
    previousState?.phase === "checkpoint"
      ? (previousState.historyStart ?? config.historyStart)
      : config.historyStart
  const historyStartMs = timestamp(historyStart, "history start")
  const lastReconciledAt =
    previousState?.phase === "checkpoint"
      ? previousState.lastReconciledAt
      : undefined
  const reconciliation =
    !lastReconciledAt ||
    cycleUntilMs - timestamp(lastReconciledAt, "last reconciliation") >=
      COMPLETED_RECONCILIATION_MS
  const cycleSinceMs = reconciliation
    ? historyStartMs
    : timestamp(previousState?.since ?? historyStart, "cycle start")
  if (cycleSinceMs >= cycleUntilMs) {
    throw new Error(
      "Todoist completion history start must be before the buffered cycle end."
    )
  }
  return windowState(
    userId,
    iso(historyStartMs),
    cycleSinceMs,
    cycleUntilMs,
    reconciliation,
    lastReconciledAt
  )
}

function cursorState(
  state: CursorBearingState,
  nextCursor: string,
  resource: string
): { cursor: string; recentCursors: string[]; pageCount: number } {
  const cursor = nextCursor
  assertCursorValue(cursor, resource)
  assertCursorState(state, resource)

  const recent = [...(state.recentCursors ?? [])]
  if (recent.includes(cursor)) {
    throw new CursorPaginationError(
      `Todoist ${resource} pagination repeated a cursor.`
    )
  }
  const pageCount = (state.pageCount ?? 0) + 1
  if (pageCount >= MAX_CURSOR_PAGES) {
    throw new CursorPaginationError(
      `Todoist ${resource} exceeded ${MAX_CURSOR_PAGES} pages.`
    )
  }
  recent.push(cursor)
  const next = {
    cursor,
    recentCursors: recent.slice(-MAX_RECENT_CURSORS),
    pageCount,
  }
  assertStateSize(next, resource)
  return next
}

export function nextCompletedSyncState(
  state: CompletedWindowState,
  nextCursor: string | undefined
): CompletedSyncState {
  assertCompletedWindow(state)
  if (nextCursor) {
    const nextState = {
      ...state,
      ...cursorState(state, nextCursor, "completed-work"),
    }
    assertStateSize(nextState, "completed-work")
    return nextState
  }

  if ((state.pass ?? "primary") === "primary" && state.cursor) {
    return {
      phase: "window",
      userId: state.userId,
      historyStart: state.historyStart,
      reconciliation: state.reconciliation,
      ...(state.lastReconciledAt
        ? { lastReconciledAt: state.lastReconciledAt }
        : {}),
      cycleSince: state.cycleSince,
      cycleUntil: state.cycleUntil,
      windowSince: state.windowSince,
      windowUntil: state.windowUntil,
      pass: "replay",
    }
  }

  const cycleUntilMs = timestamp(state.cycleUntil, "cycle end")
  const windowUntilMs = timestamp(state.windowUntil, "window end")
  if (windowUntilMs < cycleUntilMs) {
    return {
      phase: "window",
      userId: state.userId,
      historyStart: state.historyStart,
      reconciliation: state.reconciliation,
      ...(state.lastReconciledAt
        ? { lastReconciledAt: state.lastReconciledAt }
        : {}),
      cycleSince: state.cycleSince,
      cycleUntil: state.cycleUntil,
      windowSince: state.windowUntil,
      windowUntil: iso(
        Math.min(windowUntilMs + COMPLETED_WINDOW_MS, cycleUntilMs)
      ),
      pass: "primary",
    }
  }

  const cycleSinceMs = timestamp(state.cycleSince, "cycle start")
  return {
    phase: "checkpoint",
    userId: state.userId,
    historyStart: state.historyStart,
    since: iso(Math.max(cycleSinceMs, cycleUntilMs - COMPLETED_OVERLAP_MS)),
    ...(state.reconciliation
      ? { lastReconciledAt: state.cycleUntil }
      : state.lastReconciledAt
        ? { lastReconciledAt: state.lastReconciledAt }
        : {}),
  }
}

export type CursorRecovery<T> = {
  nextState: T
  retryImmediately: boolean
}

export function recoverCompletedCursor(
  state: CompletedWindowState
): CursorRecovery<CompletedWindowState> {
  assertCompletedWindow(state)
  const retryImmediately = (state.cursorRecoveryCount ?? 0) === 0
  return {
    retryImmediately,
    nextState: {
      phase: "window",
      userId: state.userId,
      historyStart: state.historyStart,
      reconciliation: state.reconciliation,
      ...(state.lastReconciledAt
        ? { lastReconciledAt: state.lastReconciledAt }
        : {}),
      cycleSince: state.cycleSince,
      cycleUntil: state.cycleUntil,
      windowSince: state.windowSince,
      windowUntil: state.windowUntil,
      pass: state.pass ?? "primary",
      ...(retryImmediately ? { cursorRecoveryCount: 1 } : {}),
    },
  }
}

export function currentProjectsSyncState(
  previousState: ProjectsSyncState | undefined,
  authenticatedUserId: string
): ProjectsScanState {
  const userId = validatedUserId(authenticatedUserId, "projects")
  if (!previousState) return { phase: "active", userId }

  assertSameUser(previousState.userId, userId, "projects")
  if (previousState.phase === "checkpoint") {
    assertStateSize(previousState, "projects")
    return { phase: "active", userId }
  }
  if (previousState.phase !== "active" && previousState.phase !== "archived") {
    throw new Error("Todoist projects sync state has an invalid phase.")
  }
  assertCursorState(previousState, `${previousState.phase} projects`)
  return previousState
}

export function nextProjectsSyncState(
  state: ProjectsScanState,
  nextCursor: string | undefined
): ProjectsSyncState {
  if (state.phase !== "active" && state.phase !== "archived") {
    throw new Error("Todoist projects sync state has an invalid phase.")
  }
  assertCursorState(state, `${state.phase} projects`)
  if (nextCursor) {
    const nextState = {
      ...state,
      ...cursorState(state, nextCursor, `${state.phase} projects`),
    }
    assertStateSize(nextState, `${state.phase} projects`)
    return nextState
  }
  return state.phase === "active"
    ? { phase: "archived", userId: state.userId }
    : { phase: "checkpoint", userId: state.userId }
}

export function recoverProjectsCursor(
  state: ProjectsScanState
): CursorRecovery<ProjectsScanState> {
  if (state.phase !== "active" && state.phase !== "archived") {
    throw new Error("Todoist projects sync state has an invalid phase.")
  }
  assertCursorState(state, `${state.phase} projects`)
  const retryImmediately = (state.cursorRecoveryCount ?? 0) === 0
  return {
    retryImmediately,
    nextState: {
      phase: state.phase,
      userId: state.userId,
      ...(retryImmediately ? { cursorRecoveryCount: 1 } : {}),
    },
  }
}
