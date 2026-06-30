// Jira Cloud REST API client. Handles authentication and paginated fetching
// for issues, sprints, and projects.
//
// Uses two API surfaces:
//   - Platform REST API v3 (/rest/api/3) for issues and projects
//   - Agile REST API (/rest/agile/1.0) for boards and sprints
//
// To add a new resource:
//   1. Add a type for the response shape
//   2. Add a fetch function
//   3. Wire it into index.ts

import { RateLimitError } from "@notionhq/workers"

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is not set.`)
  }
  return value
}

function optionalEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined
}

export function getBaseUrl(): string {
  const domain = requireEnv("JIRA_DOMAIN")
  return `https://${domain}.atlassian.net`
}

function getAuthHeader(): string {
  const email = requireEnv("JIRA_EMAIL")
  const token = requireEnv("JIRA_API_TOKEN")
  return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Authorization: getAuthHeader(),
      Accept: "application/json",
    },
  })

  const text = await response.text()
  if (response.status === 429) {
    throw new RateLimitError({
      retryAfter: parseRetryAfter(response.headers.get("Retry-After")),
    })
  }
  if (!response.ok) {
    throw new JiraApiError(response.status, text)
  }

  return JSON.parse(text) as T
}

class JiraApiError extends Error {
  constructor(
    readonly status: number,
    body: string
  ) {
    super(`Jira API error (${status}): ${body || "No response body"}`)
    this.name = "JiraApiError"
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds)
  }

  const retryAt = Date.parse(value)
  if (Number.isNaN(retryAt)) return undefined
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000))
}

export function browseUrl(baseUrl: string, key: string): string {
  return `${baseUrl}/browse/${key}`
}

// Jira Software fields are custom fields whose IDs vary by site. Resolve them
// from Jira's field metadata once per issue sync cycle, with optional env vars
// taking precedence when a site has multiple matching fields.
export type IssueFieldConfig = {
  sprintField?: string
  storyPointsFields: string[]
  epicField?: string
}

export type JiraFieldDefinition = {
  id: string
  name: string
  schema?: {
    custom?: string
    type?: string
  }
}

const SPRINT_FIELD_TYPE = "com.pyxis.greenhopper.jira:gh-sprint"
const EPIC_FIELD_TYPE = "com.pyxis.greenhopper.jira:gh-epic-link"

export async function fetchIssueFieldConfig(): Promise<IssueFieldConfig> {
  const fields = await fetchJson<JiraFieldDefinition[]>(
    `${getBaseUrl()}/rest/api/3/field`
  )
  return resolveIssueFieldConfig(fields)
}

export function resolveIssueFieldConfig(
  fields: JiraFieldDefinition[]
): IssueFieldConfig {
  const sprintField =
    optionalEnv("JIRA_SPRINT_FIELD") ??
    fields.find((field) => field.schema?.custom === SPRINT_FIELD_TYPE)?.id

  const storyPointsOverride = optionalEnv("JIRA_STORY_POINTS_FIELD")
  const storyPointsFields = storyPointsOverride
    ? storyPointsOverride
        .split(",")
        .map((field) => field.trim())
        .filter(Boolean)
    : fields
        .filter((field) => {
          const name = field.name.trim().toLowerCase()
          return (
            field.schema?.type === "number" &&
            (name === "story points" || name === "story point estimate")
          )
        })
        .map((field) => field.id)

  const epicField =
    optionalEnv("JIRA_EPIC_FIELD") ??
    fields.find((field) => field.schema?.custom === EPIC_FIELD_TYPE)?.id

  return {
    sprintField,
    storyPointsFields: [...new Set(storyPointsFields)],
    epicField,
  }
}

// ---------------------------------------------------------------------------
// Issues — searched via JQL
// https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/
// ---------------------------------------------------------------------------

export type JiraIssue = {
  id: string
  key: string
  self: string
  fields: {
    summary: string
    status: { name: string; statusCategory?: { name: string } } | null
    issuetype: {
      name: string
      subtask?: boolean
      hierarchyLevel?: number
    } | null
    priority: { name: string } | null
    assignee: { displayName: string } | null
    reporter: { displayName: string } | null
    project: { key: string; name: string } | null
    labels: string[]
    components: { name: string }[]
    fixVersions: { name: string }[]
    resolution: { name: string } | null
    description: unknown
    duedate: string | null
    created: string
    updated: string
    parent?: { key: string; fields?: { summary: string } } | null
    [key: string]: unknown
  }
}

const ISSUE_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "priority",
  "assignee",
  "reporter",
  "project",
  "labels",
  "components",
  "fixVersions",
  "resolution",
  "description",
  "duedate",
  "created",
  "updated",
  "parent",
]

export function getIssueFields(config: IssueFieldConfig): string[] {
  return [
    ...new Set(
      [
        ...ISSUE_FIELDS,
        config.sprintField,
        ...config.storyPointsFields,
        config.epicField,
      ].filter((field): field is string => Boolean(field))
    ),
  ]
}

// Jira Cloud v3 returns descriptions in Atlassian Document Format (ADF),
// a JSON tree structure. This extracts readable plain text from it.
export function extractTextFromAdf(adf: unknown): string {
  if (!adf || typeof adf !== "object") return ""
  const node = adf as Record<string, unknown>

  if (node.type === "text" && typeof node.text === "string") {
    return node.text
  }
  if (node.type === "hardBreak") {
    return "\n"
  }

  const content = node.content
  if (!Array.isArray(content)) return ""

  const parts: string[] = []
  for (const child of content) {
    const text = extractTextFromAdf(child)
    if (text) parts.push(text)
  }

  if (node.type === "paragraph" || node.type === "heading") {
    return parts.join("") + "\n"
  }
  if (node.type === "bulletList" || node.type === "orderedList") {
    return parts.map((p) => `- ${p.trim()}`).join("\n") + "\n"
  }
  if (node.type === "listItem") {
    return parts.join("")
  }
  if (node.type === "codeBlock") {
    return "```\n" + parts.join("") + "\n```\n"
  }

  return parts.join("")
}

export function getStoryPoints(
  issue: JiraIssue,
  config: IssueFieldConfig
): number | null {
  for (const field of config.storyPointsFields) {
    const value = issue.fields[field]
    if (typeof value === "number") return value
  }
  return null
}

export function getSprintName(
  issue: JiraIssue,
  config: IssueFieldConfig
): string | null {
  if (!config.sprintField) return null
  const value = issue.fields[config.sprintField]
  if (!Array.isArray(value)) return null

  const sprints = value.filter(
    (sprint): sprint is { name: string; state?: string } =>
      Boolean(
        sprint &&
          typeof sprint === "object" &&
          typeof (sprint as Record<string, unknown>).name === "string"
      )
  )
  const current =
    sprints.find((sprint) => sprint.state === "active") ??
    sprints.find((sprint) => sprint.state === "future") ??
    sprints[sprints.length - 1]
  return current?.name ?? null
}

export function getEpicName(
  issue: JiraIssue,
  config: IssueFieldConfig
): string | null {
  const customValue = config.epicField
    ? issue.fields[config.epicField]
    : undefined
  const customEpic = typeof customValue === "string" ? customValue : null

  // A subtask's direct parent is a story/task, not its epic. Use an explicit
  // Epic Link value when Jira exposes one instead of mislabeling that parent.
  if (
    issue.fields.issuetype?.subtask ||
    issue.fields.issuetype?.hierarchyLevel === -1
  ) {
    return customEpic
  }

  // Only standard issues have an Epic as their direct parent. Higher-level
  // issue types can have an Initiative or another custom hierarchy parent.
  const hierarchyLevel = issue.fields.issuetype?.hierarchyLevel
  if (hierarchyLevel === 0 || hierarchyLevel === undefined) {
    if (issue.fields.parent?.fields?.summary) {
      return issue.fields.parent.fields.summary
    }
    if (issue.fields.parent?.key) {
      return issue.fields.parent.key
    }
  }
  return customEpic
}

function buildJql(): string {
  const projects = optionalEnv("JIRA_PROJECTS")
  if (projects) {
    const keys = projects
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean)
      .map((key) => `"${key.replace(/"/g, '\\"')}"`)
    if (keys.length > 0) {
      return `project IN (${keys.join(",")}) ORDER BY updated DESC`
    }
  }

  // Enhanced search rejects unbounded JQL. Jira issue timestamps cannot
  // predate Unix time, so this preserves the documented all-projects behavior.
  return 'created >= "1970-01-01" ORDER BY updated DESC'
}

type IssueSearchResponse = {
  issues: JiraIssue[]
  isLast?: boolean
  nextPageToken?: string
  warnings?: {
    type?: string
    message?: string
  }[]
}

const INCOMPLETE_SEARCH_WARNINGS = new Set([
  "CLAUSE_LIMIT_EXCEEDED",
  "CLAUSE_RESULT_TRUNCATED",
])

export async function fetchIssuesPage(
  config: IssueFieldConfig,
  nextPageToken?: string
): Promise<{
  issues: JiraIssue[]
  hasMore: boolean
  nextPageToken?: string
}> {
  const baseUrl = getBaseUrl()
  const fields = getIssueFields(config)
  const url = new URL(`${baseUrl}/rest/api/3/search/jql`)
  url.searchParams.set("jql", buildJql())
  url.searchParams.set("fields", fields.join(","))
  url.searchParams.set("maxResults", "100")
  url.searchParams.set("failFast", "true")
  if (nextPageToken) {
    url.searchParams.set("nextPageToken", nextPageToken)
  }

  const body = await fetchJson<IssueSearchResponse>(url.toString())
  const incompleteWarnings = (body.warnings ?? []).filter(
    (warning) => warning.type && INCOMPLETE_SEARCH_WARNINGS.has(warning.type)
  )
  if (incompleteWarnings.length > 0) {
    const details = incompleteWarnings
      .map((warning) => warning.message || warning.type)
      .join("; ")
    throw new Error(`Jira search returned incomplete results: ${details}`)
  }

  const nextToken = body.nextPageToken || undefined
  return {
    issues: body.issues,
    hasMore: body.isLast !== true && nextToken !== undefined,
    nextPageToken: nextToken,
  }
}

// ---------------------------------------------------------------------------
// Sprints — fetched per Scrum board via the Agile API
// https://developer.atlassian.com/cloud/jira/software/rest/api-group-sprint/
// ---------------------------------------------------------------------------

export type JiraSprint = {
  id: number
  name: string
  state: string
  startDate: string | null
  endDate: string | null
  completeDate: string | null
  goal: string | null
  originBoardId: number
}

type BoardListResponse = {
  values: { id: number; name: string }[]
  startAt: number
  maxResults: number
  isLast: boolean
}

type SprintListResponse = {
  values: JiraSprint[]
  startAt: number
  maxResults: number
  isLast: boolean
}

export type BoardLookup = Map<number, string>

export async function fetchAllBoards(
  waitFn?: () => Promise<void>
): Promise<BoardLookup> {
  const baseUrl = getBaseUrl()
  const boards: BoardLookup = new Map()
  let startAt = 0

  do {
    if (waitFn) await waitFn()
    const url = `${baseUrl}/rest/agile/1.0/board?type=scrum&startAt=${startAt}&maxResults=50`
    const body = await fetchJson<BoardListResponse>(url)

    for (const board of body.values) {
      boards.set(board.id, board.name)
    }

    if (body.isLast) break
    startAt += body.maxResults
  } while (true)

  return boards
}

export async function fetchSprintsForBoard(
  boardId: number,
  startAt?: number
): Promise<{ sprints: JiraSprint[]; hasMore: boolean; nextStartAt: number }> {
  const baseUrl = getBaseUrl()
  const s = startAt ?? 0
  const url = `${baseUrl}/rest/agile/1.0/board/${boardId}/sprint?startAt=${s}&maxResults=50`

  try {
    const body = await fetchJson<SprintListResponse>(url)
    return {
      sprints: body.values,
      hasMore: !body.isLast,
      nextStartAt: s + body.maxResults,
    }
  } catch (err) {
    if (err instanceof JiraApiError && err.status === 404) {
      return { sprints: [], hasMore: false, nextStartAt: s }
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Projects
// https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/
// ---------------------------------------------------------------------------

export type JiraProject = {
  id: string
  key: string
  name: string
  description: string | null
  self: string
  projectTypeKey: string
  lead?: { displayName: string } | null
  projectCategory?: { name: string } | null
}

type ProjectSearchResponse = {
  values: JiraProject[]
  startAt: number
  maxResults: number
  isLast: boolean
  total: number
}

export async function fetchProjectsPage(
  startAt?: number
): Promise<{ projects: JiraProject[]; hasMore: boolean; nextStartAt: number }> {
  const baseUrl = getBaseUrl()
  const s = startAt ?? 0
  const url = new URL(`${baseUrl}/rest/api/3/project/search`)
  url.searchParams.set("startAt", String(s))
  url.searchParams.set("maxResults", "50")
  url.searchParams.set("expand", "description,lead")

  const body = await fetchJson<ProjectSearchResponse>(url.toString())
  return {
    projects: body.values,
    hasMore: !body.isLast,
    nextStartAt: s + body.maxResults,
  }
}
