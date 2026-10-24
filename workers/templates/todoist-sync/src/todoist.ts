// Typed Todoist API v1 client for active tasks, active projects, and a bounded
// completion window. It deliberately uses the public HTTP contract directly
// so the cookbook exposes snapshot and cursor behavior rather than hiding it.

import { RateLimitError } from "@notionhq/workers"

const TODOIST_API_BASE_URL = "https://api.todoist.com/api/v1"
const TODOIST_PAGE_SIZE = 200
const MAX_SUCCESS_RESPONSE_BYTES = 8 * 1_024 * 1_024
const MAX_ERROR_RESPONSE_BYTES = 64 * 1_024
const REQUEST_TIMEOUT_MS = 30_000
const MAX_CURSOR_CHARACTERS = 2_048
const MAX_USER_ID_CHARACTERS = 256
const DEFAULT_RATE_LIMIT_DELAY_SECONDS = 60

export type TodoistDue = {
  date: string
  isRecurring: boolean
}

export type TodoistDuration = {
  amount: number
  unit: "minute" | "day"
}

export class InvalidCursorError extends Error {
  constructor() {
    super("Todoist rejected an expired or invalid pagination cursor.")
    this.name = "InvalidCursorError"
  }
}

export type TodoistTask = {
  id: string
  projectId: string
  parentId: string | null
  content: string
  description: string
  labels: string[]
  priority: number
  addedAt: string | null
  updatedAt: string | null
  due: TodoistDue | null
  deadline: string | null
  duration: TodoistDuration | null
}

export type TodoistCompletedTask = {
  id: string
  projectId: string
  content: string
  completedAt: string
  isDeleted: boolean
}

export type TodoistAuthenticatedUser = {
  id: string
  timeZone: string
}

export type TodoistProject = {
  id: string
  name: string
  description: string
  updatedAt: string | null
}

export type TodoistTasksPage = {
  resources: TodoistTask[]
  nextCursor: string | undefined
}

export type TodoistCompletedTasksPage = {
  resources: TodoistCompletedTask[]
  nextCursor: string | undefined
}

export type TodoistProjectsPage = {
  resources: TodoistProject[]
  nextCursor: string | undefined
}

export type TodoistClient = {
  fetchAuthenticatedUser(): Promise<TodoistAuthenticatedUser>
  fetchTasksPage(cursor?: string): Promise<TodoistTasksPage>
  fetchCompletedTasksPage(options: {
    since: string
    until: string
    cursor?: string
  }): Promise<TodoistCompletedTasksPage>
  fetchProjectsPage(cursor?: string): Promise<TodoistProjectsPage>
}

export type TodoistClientOptions = {
  beforeRequest: () => Promise<void>
  fetch?: typeof globalThis.fetch
  getApiToken?: () => string
  baseUrl?: string
  requestTimeoutMs?: number
}

type JsonObject = Record<string, unknown>

function object(value: unknown, context: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Todoist API returned invalid ${context}.`)
  }
  return value as JsonObject
}

function string(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new Error(`Todoist API returned invalid ${context}.`)
  }
  return value
}

function identifier(value: unknown, context: string): string {
  const id = string(value, context).trim()
  if (!id || Array.from(id).length > MAX_USER_ID_CHARACTERS) {
    throw new Error(`Todoist API returned invalid ${context}.`)
  }
  return id
}

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  )
}

function validDateTime(value: string, requireOffset: boolean): boolean {
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/iu
  )
  if (!match || !validCalendarDate(match[1]!)) return false
  const offset = match[2]
  if (requireOffset && !offset) return false
  return Number.isFinite(Date.parse(offset ? value : `${value}Z`))
}

function absoluteTimestamp(value: unknown, context: string): string {
  const timestamp = string(value, context)
  if (!validDateTime(timestamp, true)) {
    throw new Error(`Todoist API returned invalid ${context}.`)
  }
  return timestamp
}

function boolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Todoist API returned invalid ${context}.`)
  }
  return value
}

function number(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Todoist API returned invalid ${context}.`)
  }
  return value
}

function integerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  context: string
): number {
  const parsed = number(value, context)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Todoist API returned invalid ${context}.`)
  }
  return parsed
}

function optionalString(value: unknown, context: string): string | null {
  return value === undefined || value === null ? null : string(value, context)
}

function optionalTimestamp(value: unknown, context: string): string | null {
  return value === undefined || value === null
    ? null
    : absoluteTimestamp(value, context)
}

function optionalText(value: unknown, context: string): string {
  return optionalString(value, context) ?? ""
}

function stringArray(value: unknown, context: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new Error(`Todoist API returned invalid ${context}.`)
  }
  return value.map((item, index) => string(item, `${context}[${index}]`))
}

function parseDue(value: unknown, context: string): TodoistDue | null {
  if (value === undefined || value === null) return null
  const due = object(value, context)
  const date = string(due.date, `${context}.date`)
  if (!validCalendarDate(date) && !validDateTime(date, false)) {
    throw new Error(`Todoist API returned invalid ${context}.date.`)
  }
  return {
    date,
    isRecurring: boolean(due.is_recurring, `${context}.is_recurring`),
  }
}

function parseDeadline(value: unknown, context: string): string | null {
  if (value === undefined || value === null) return null
  const deadline = object(value, context)
  const date = string(deadline.date, `${context}.date`)
  if (!validCalendarDate(date)) {
    throw new Error(`Todoist API returned invalid ${context}.date.`)
  }
  return date
}

function parseDuration(
  value: unknown,
  context: string
): TodoistDuration | null {
  if (value === undefined || value === null) return null
  const duration = object(value, context)
  const amount = number(duration.amount, `${context}.amount`)
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`Todoist API returned invalid ${context}.amount.`)
  }
  const unit = string(duration.unit, `${context}.unit`)
  if (unit !== "minute" && unit !== "day") {
    throw new Error(`Todoist API returned invalid ${context}.unit.`)
  }
  return {
    amount,
    unit,
  }
}

function parseTask(value: unknown, index: number): TodoistTask {
  const context = `task ${index}`
  const task = object(value, context)
  return {
    id: identifier(task.id, `${context}.id`),
    projectId: identifier(task.project_id, `${context}.project_id`),
    parentId:
      task.parent_id === undefined || task.parent_id === null
        ? null
        : identifier(task.parent_id, `${context}.parent_id`),
    content: string(task.content, `${context}.content`),
    description: optionalText(task.description, `${context}.description`),
    labels: stringArray(task.labels, `${context}.labels`),
    priority: integerInRange(task.priority, 1, 4, `${context}.priority`),
    addedAt: optionalTimestamp(task.added_at, `${context}.added_at`),
    updatedAt: optionalTimestamp(task.updated_at, `${context}.updated_at`),
    due: parseDue(task.due, `${context}.due`),
    deadline: parseDeadline(task.deadline, `${context}.deadline`),
    duration: parseDuration(task.duration, `${context}.duration`),
  }
}

function parseCompletedTask(
  value: unknown,
  index: number
): TodoistCompletedTask {
  const context = `completed task ${index}`
  const task = object(value, context)
  return {
    id: identifier(task.id, `${context}.id`),
    projectId: identifier(task.project_id, `${context}.project_id`),
    content: string(task.content, `${context}.content`),
    completedAt: absoluteTimestamp(
      task.completed_at,
      `${context}.completed_at`
    ),
    isDeleted: boolean(task.is_deleted, `${context}.is_deleted`),
  }
}

function parseAuthenticatedUser(value: unknown): TodoistAuthenticatedUser {
  const user = object(value, "authenticated user")
  const id = string(user.id, "authenticated user.id").trim()
  if (!id) {
    throw new Error("Todoist API returned an empty authenticated user.id.")
  }
  if (Array.from(id).length > MAX_USER_ID_CHARACTERS) {
    throw new Error("Todoist API returned an oversized authenticated user.id.")
  }
  const timeZoneInfo = object(user.tz_info, "authenticated user.tz_info")
  const timeZone = string(
    timeZoneInfo.timezone,
    "authenticated user.tz_info.timezone"
  ).trim()
  if (!timeZone) {
    throw new Error(
      "Todoist API returned an empty authenticated user timezone."
    )
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format()
  } catch {
    throw new Error(
      "Todoist API returned an invalid authenticated user timezone."
    )
  }
  return { id, timeZone }
}

function parseProject(value: unknown, index: number): TodoistProject {
  const context = `project ${index}`
  const project = object(value, context)
  return {
    id: identifier(project.id, `${context}.id`),
    name: string(project.name, `${context}.name`),
    description: optionalText(project.description, `${context}.description`),
    updatedAt: optionalTimestamp(project.updated_at, `${context}.updated_at`),
  }
}

function nextCursor(value: unknown, context: string): string | undefined {
  if (value === null) return undefined
  const cursor = string(value, `${context}.next_cursor`)
  if (!cursor.trim() || cursor !== cursor.trim()) {
    throw new Error(`Todoist API returned an empty ${context}.next_cursor.`)
  }
  if (Array.from(cursor).length > MAX_CURSOR_CHARACTERS) {
    throw new Error(`Todoist API returned an oversized ${context}.next_cursor.`)
  }
  return cursor
}

function parseResourcePage<T>(
  value: unknown,
  options: {
    context: string
    resourceField: "results" | "items"
    resourceName: string
    parseResource: (value: unknown, index: number) => T
    allowMissingCursorOnEmpty?: boolean
  }
): { resources: T[]; nextCursor: string | undefined } {
  const response = object(value, options.context)
  if (!(options.resourceField in response)) {
    throw new Error(
      `Todoist API ${options.context} is missing ${options.resourceField}.`
    )
  }
  const resources = response[options.resourceField]
  if (!Array.isArray(resources)) {
    throw new Error(`Todoist API returned invalid ${options.resourceName}.`)
  }
  if (
    !("next_cursor" in response) &&
    !(options.allowMissingCursorOnEmpty && resources.length === 0)
  ) {
    throw new Error(`Todoist API ${options.context} is missing next_cursor.`)
  }
  return {
    resources: resources.map(options.parseResource),
    // The completion-history endpoint has been observed omitting next_cursor
    // on an empty terminal page. Replacement inventories never get that
    // exception because an ambiguous empty page could sweep every managed row.
    nextCursor:
      "next_cursor" in response
        ? nextCursor(response.next_cursor, options.context)
        : undefined,
  }
}

function parseTasksPage(value: unknown): TodoistTasksPage {
  return parseResourcePage(value, {
    context: "tasks response",
    resourceField: "results",
    resourceName: "task results",
    parseResource: parseTask,
  })
}

function parseCompletedTasksPage(value: unknown): TodoistCompletedTasksPage {
  return parseResourcePage(value, {
    context: "completed tasks response",
    resourceField: "items",
    resourceName: "completed task items",
    parseResource: parseCompletedTask,
    allowMissingCursorOnEmpty: true,
  })
}

function parseProjectsPage(value: unknown): TodoistProjectsPage {
  return parseResourcePage(value, {
    context: "projects response",
    resourceField: "results",
    resourceName: "project results",
    parseResource: parseProject,
  })
}

function parseRetryAfterSeconds(
  value: string | null,
  now = Date.now()
): number | undefined {
  if (!value?.trim()) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)

  const retryAt = Date.parse(value)
  return Number.isFinite(retryAt)
    ? Math.max(0, Math.ceil((retryAt - now) / 1_000))
    : undefined
}

function bodyRetryAfter(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  const extra = (value as JsonObject).error_extra
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) {
    return undefined
  }
  const candidate = (extra as JsonObject).retry_after
  const seconds = typeof candidate === "number" ? candidate : Number(candidate)
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.ceil(seconds)
    : undefined
}

function isInvalidCursorResponse(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const body = value as JsonObject
  const extra = body.error_extra
  return (
    body.error_tag === "INVALID_ARGUMENT_VALUE" &&
    !!extra &&
    typeof extra === "object" &&
    !Array.isArray(extra) &&
    (extra as JsonObject).argument === "cursor"
  )
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status >= 500
}

function safeErrorIdentifier(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  const body = value as JsonObject
  for (const field of ["error_tag", "error_code"] as const) {
    const candidate = body[field]
    if (
      (typeof candidate === "string" || typeof candidate === "number") &&
      /^[A-Za-z0-9_.:-]{1,80}$/.test(String(candidate))
    ) {
      return `${field}=${candidate}`
    }
  }
  return undefined
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number
): Promise<{ text: string; exceeded: boolean }> {
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel()
    return { text: "", exceeded: true }
  }
  if (!response.body) return { text: "", exceeded: false }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ""

  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maximumBytes) {
        await reader.cancel()
        return { text: "", exceeded: true }
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    return { text, exceeded: false }
  } finally {
    reader.releaseLock()
  }
}

function requireApiToken(): string {
  const token = process.env.TODOIST_API_TOKEN?.trim()
  if (!token) throw new Error("TODOIST_API_TOKEN is not set.")
  return token
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
  const authenticated = authenticatedUserId.trim()
  const expected = expectedUserId.trim()
  if (
    !authenticated ||
    !expected ||
    Array.from(authenticated).length > MAX_USER_ID_CHARACTERS ||
    Array.from(expected).length > MAX_USER_ID_CHARACTERS
  ) {
    throw new Error("Todoist account ID is invalid.")
  }
  if (authenticated !== expected) {
    throw new Error(
      "Todoist account does not match TODOIST_USER_ID; restore the expected account token or deploy a separate Worker."
    )
  }
}

export function createTodoistClient(
  options: TodoistClientOptions
): TodoistClient {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const getApiToken = options.getApiToken ?? requireApiToken
  const baseUrl = (options.baseUrl ?? TODOIST_API_BASE_URL).replace(/\/$/, "")
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("Todoist request timeout must be a positive integer.")
  }

  async function fetchJson(url: URL): Promise<unknown> {
    const token = getApiToken().trim()
    if (!token) throw new Error("TODOIST_API_TOKEN is not set.")

    await options.beforeRequest()
    const signal = AbortSignal.timeout(requestTimeoutMs)
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "User-Agent": "notion-cookbook-todoist-sync",
        },
        redirect: "error",
        signal,
      })
    } catch {
      if (signal.aborted) {
        throw new Error(
          `Todoist API request timed out after ${requestTimeoutMs}ms.`
        )
      }
      throw new Error(
        "Todoist API request failed before a response was received."
      )
    }
    const maximumBytes = response.ok
      ? MAX_SUCCESS_RESPONSE_BYTES
      : MAX_ERROR_RESPONSE_BYTES
    let body: { text: string; exceeded: boolean }
    try {
      body = await readBoundedBody(response, maximumBytes)
    } catch {
      if (signal.aborted) {
        throw new Error(
          `Todoist API request timed out after ${requestTimeoutMs}ms.`
        )
      }
      throw new Error("Todoist API response body could not be read.")
    }
    const raw = body.text
    let parsed: unknown
    if (raw && !body.exceeded) {
      try {
        parsed = JSON.parse(raw) as unknown
      } catch {
        if (response.ok) {
          throw new Error(
            `Todoist API returned invalid JSON (${response.status}).`
          )
        }
      }
    }

    if (response.status === 429) {
      throw new RateLimitError({
        retryAfter:
          Math.max(
            parseRetryAfterSeconds(response.headers.get("retry-after")) ?? 0,
            bodyRetryAfter(parsed) ?? 0
          ) || DEFAULT_RATE_LIMIT_DELAY_SECONDS,
      })
    }
    if (!response.ok) {
      const headerRetryAfter = parseRetryAfterSeconds(
        response.headers.get("retry-after")
      )
      if (body.exceeded) {
        if (
          isRetryableStatus(response.status) &&
          headerRetryAfter !== undefined
        ) {
          throw new RateLimitError({
            retryAfter: headerRetryAfter || DEFAULT_RATE_LIMIT_DELAY_SECONDS,
          })
        }
        throw new Error(
          `Todoist API error (${response.status}). Response body exceeded the safe size limit.`
        )
      }
      if (
        response.status === 400 &&
        url.searchParams.has("cursor") &&
        isInvalidCursorResponse(parsed)
      ) {
        throw new InvalidCursorError()
      }
      const errorRetryAfter = bodyRetryAfter(parsed)
      const retryAfter = Math.max(headerRetryAfter ?? 0, errorRetryAfter ?? 0)
      if (
        isRetryableStatus(response.status) &&
        (headerRetryAfter !== undefined || errorRetryAfter !== undefined)
      ) {
        throw new RateLimitError({
          retryAfter: retryAfter || DEFAULT_RATE_LIMIT_DELAY_SECONDS,
        })
      }
      const retryHint = retryAfter ? ` Retry after ${retryAfter} seconds.` : ""
      const identifier = safeErrorIdentifier(parsed)
      const detail = identifier ? ` ${identifier}.` : ""
      throw new Error(
        `Todoist API error (${response.status}).${detail}${retryHint}`
      )
    }
    if (body.exceeded) {
      throw new Error(
        `Todoist API response exceeded the ${MAX_SUCCESS_RESPONSE_BYTES}-byte safety limit.`
      )
    }
    if (!raw) throw new Error("Todoist API returned an empty response.")
    return parsed
  }

  return {
    async fetchAuthenticatedUser() {
      return parseAuthenticatedUser(await fetchJson(new URL(`${baseUrl}/user`)))
    },

    async fetchTasksPage(cursor) {
      const url = new URL(`${baseUrl}/tasks`)
      url.searchParams.set("limit", String(TODOIST_PAGE_SIZE))
      if (cursor) url.searchParams.set("cursor", cursor)
      return parseTasksPage(await fetchJson(url))
    },

    async fetchCompletedTasksPage({ since, until, cursor }) {
      const url = new URL(`${baseUrl}/tasks/completed/by_completion_date`)
      url.searchParams.set("since", since)
      url.searchParams.set("until", until)
      url.searchParams.set("limit", String(TODOIST_PAGE_SIZE))
      if (cursor) url.searchParams.set("cursor", cursor)
      return parseCompletedTasksPage(await fetchJson(url))
    },

    async fetchProjectsPage(cursor) {
      const url = new URL(`${baseUrl}/projects`)
      url.searchParams.set("limit", String(TODOIST_PAGE_SIZE))
      if (cursor) url.searchParams.set("cursor", cursor)
      return parseProjectsPage(await fetchJson(url))
    },
  }
}
