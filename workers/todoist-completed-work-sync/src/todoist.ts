// Typed Todoist API v1 client for completed tasks plus active and archived
// projects. It deliberately uses the public HTTP contract directly so the
// cookbook exposes date-window and cursor behavior rather than hiding it.

import { RateLimitError } from "@notionhq/workers"

export const TODOIST_API_BASE_URL = "https://api.todoist.com/api/v1"
export const TODOIST_PAGE_SIZE = 200
export const MAX_SUCCESS_RESPONSE_BYTES = 8 * 1_024 * 1_024
export const MAX_ERROR_RESPONSE_BYTES = 64 * 1_024
export const REQUEST_TIMEOUT_MS = 30_000
export const MAX_CURSOR_CHARACTERS = 2_048
export const MAX_USER_ID_CHARACTERS = 256
const DEFAULT_RATE_LIMIT_DELAY_SECONDS = 60

export type TodoistDue = {
  date: string | null
  string: string | null
  isRecurring: boolean
  timeZone: string | null
}

export type TodoistDuration = {
  amount: number
  unit: string
}

export type TodoistCompletedTask = {
  id: string
  projectId: string
  sectionId: string | null
  parentId: string | null
  content: string
  description: string
  labels: string[]
  priority: number
  addedAt: string | null
  completedAt: string | null
  completedByUserId: string | null
  responsibleUserId: string | null
  updatedAt: string | null
  due: TodoistDue | null
  deadline: string | null
  duration: TodoistDuration | null
  completedCount: number
  postponedCount: number
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
  color: string
  isArchived: boolean
  isDeleted: boolean
  isFavorite: boolean
  isShared: boolean
  inboxProject: boolean
  viewStyle: string
  role: string | null
  status: string | null
  workspaceId: string | null
  parentId: string | null
  createdAt: string | null
  updatedAt: string | null
}

export type TodoistCompletedTasksPage = {
  resources: TodoistCompletedTask[]
  nextCursor: string | undefined
}

export type TodoistProjectsPage = {
  resources: TodoistProject[]
  nextCursor: string | undefined
}

export type TodoistProjectCollection = "active" | "archived"

export type TodoistClient = {
  fetchAuthenticatedUser(): Promise<TodoistAuthenticatedUser>
  fetchCompletedTasksPage(options: {
    since: string
    until: string
    cursor?: string
  }): Promise<TodoistCompletedTasksPage>
  fetchProjectsPage(
    collection: TodoistProjectCollection,
    cursor?: string
  ): Promise<TodoistProjectsPage>
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

function nullableString(value: unknown, context: string): string | null {
  return value === null ? null : string(value, context)
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

function optionalString(value: unknown, context: string): string | null {
  return value === undefined || value === null ? null : string(value, context)
}

function optionalBoolean(value: unknown, context: string): boolean {
  return value === undefined ? false : boolean(value, context)
}

function stringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Todoist API returned invalid ${context}.`)
  }
  return value.map((item, index) => string(item, `${context}[${index}]`))
}

function parseDue(value: unknown, context: string): TodoistDue | null {
  if (value === null) return null
  const due = object(value, context)
  return {
    date: optionalString(due.date, `${context}.date`),
    string: optionalString(due.string, `${context}.string`),
    isRecurring: optionalBoolean(due.is_recurring, `${context}.is_recurring`),
    timeZone: optionalString(due.timezone, `${context}.timezone`),
  }
}

function parseDeadline(value: unknown, context: string): string | null {
  if (value === null) return null
  const deadline = object(value, context)
  return optionalString(deadline.date, `${context}.date`)
}

function parseDuration(
  value: unknown,
  context: string
): TodoistDuration | null {
  if (value === null) return null
  const duration = object(value, context)
  return {
    amount: number(duration.amount, `${context}.amount`),
    unit: string(duration.unit, `${context}.unit`),
  }
}

function parseCompletedTask(
  value: unknown,
  index: number
): TodoistCompletedTask {
  const context = `completed task ${index}`
  const task = object(value, context)
  return {
    id: string(task.id, `${context}.id`),
    projectId: string(task.project_id, `${context}.project_id`),
    sectionId: nullableString(task.section_id, `${context}.section_id`),
    parentId: nullableString(task.parent_id, `${context}.parent_id`),
    content: string(task.content, `${context}.content`),
    description: string(task.description, `${context}.description`),
    labels: stringArray(task.labels, `${context}.labels`),
    priority: number(task.priority, `${context}.priority`),
    addedAt: nullableString(task.added_at, `${context}.added_at`),
    completedAt: nullableString(task.completed_at, `${context}.completed_at`),
    completedByUserId: nullableString(
      task.completed_by_uid,
      `${context}.completed_by_uid`
    ),
    responsibleUserId: nullableString(
      task.responsible_uid,
      `${context}.responsible_uid`
    ),
    updatedAt: nullableString(task.updated_at, `${context}.updated_at`),
    due: parseDue(task.due, `${context}.due`),
    deadline: parseDeadline(task.deadline, `${context}.deadline`),
    duration: parseDuration(task.duration, `${context}.duration`),
    completedCount: number(task.completed_count, `${context}.completed_count`),
    postponedCount: number(task.postponed_count, `${context}.postponed_count`),
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
    id: string(project.id, `${context}.id`),
    name: string(project.name, `${context}.name`),
    description: string(project.description, `${context}.description`),
    color: string(project.color, `${context}.color`),
    isArchived: boolean(project.is_archived, `${context}.is_archived`),
    isDeleted: boolean(project.is_deleted, `${context}.is_deleted`),
    isFavorite: boolean(project.is_favorite, `${context}.is_favorite`),
    isShared: boolean(project.is_shared, `${context}.is_shared`),
    inboxProject: optionalBoolean(
      project.inbox_project,
      `${context}.inbox_project`
    ),
    viewStyle: string(project.view_style, `${context}.view_style`),
    role: optionalString(project.role, `${context}.role`),
    status: optionalString(project.status, `${context}.status`),
    workspaceId: optionalString(
      project.workspace_id,
      `${context}.workspace_id`
    ),
    parentId: optionalString(project.parent_id, `${context}.parent_id`),
    createdAt: nullableString(project.created_at, `${context}.created_at`),
    updatedAt: nullableString(project.updated_at, `${context}.updated_at`),
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

function parseCompletedTasksPage(value: unknown): TodoistCompletedTasksPage {
  const response = object(value, "completed tasks response")
  if (!("items" in response) || !("next_cursor" in response)) {
    throw new Error(
      "Todoist API completed tasks response is missing items or next_cursor."
    )
  }
  if (!Array.isArray(response.items)) {
    throw new Error("Todoist API returned invalid completed tasks items.")
  }
  return {
    resources: response.items.map(parseCompletedTask),
    nextCursor: nextCursor(response.next_cursor, "completed tasks response"),
  }
}

function parseProjectsPage(value: unknown): TodoistProjectsPage {
  const response = object(value, "projects response")
  if (!("results" in response) || !("next_cursor" in response)) {
    throw new Error(
      "Todoist API projects response is missing results or next_cursor."
    )
  }
  if (!Array.isArray(response.results)) {
    throw new Error("Todoist API returned invalid project results.")
  }
  return {
    resources: response.results.map(parseProject),
    nextCursor: nextCursor(response.next_cursor, "projects response"),
  }
}

export function parseRetryAfterSeconds(
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
          "User-Agent": "notion-cookbook-todoist-completed-work-sync",
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
      const retryAfter = bodyRetryAfter(parsed)
      const retryHint = retryAfter ? ` Retry after ${retryAfter} seconds.` : ""
      const identifier = safeErrorIdentifier(parsed)
      const detail = body.exceeded
        ? " Response body exceeded the safe size limit."
        : identifier
          ? ` ${identifier}.`
          : ""
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

    async fetchCompletedTasksPage({ since, until, cursor }) {
      const url = new URL(`${baseUrl}/tasks/completed/by_completion_date`)
      url.searchParams.set("since", since)
      url.searchParams.set("until", until)
      url.searchParams.set("limit", String(TODOIST_PAGE_SIZE))
      if (cursor) url.searchParams.set("cursor", cursor)
      return parseCompletedTasksPage(await fetchJson(url))
    },

    async fetchProjectsPage(collection, cursor) {
      const suffix = collection === "archived" ? "/archived" : ""
      const url = new URL(`${baseUrl}/projects${suffix}`)
      url.searchParams.set("limit", String(TODOIST_PAGE_SIZE))
      if (cursor) url.searchParams.set("cursor", cursor)
      return parseProjectsPage(await fetchJson(url))
    },
  }
}
