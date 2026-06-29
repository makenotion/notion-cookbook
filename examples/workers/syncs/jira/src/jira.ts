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
  if (!response.ok) {
    throw new Error(
      `Jira API error (${response.status}): ${text || "No response body"}`
    )
  }

  return JSON.parse(text) as T
}

export function browseUrl(baseUrl: string, key: string): string {
  return `${baseUrl}/browse/${key}`
}

// Custom field IDs cached at module level — these never change within a process.
// Most Jira Cloud instances use customfield_10016 for story points.
const STORY_POINTS_FIELD = optionalEnv("JIRA_STORY_POINTS_FIELD") ?? "customfield_10016"
const EPIC_FIELD = optionalEnv("JIRA_EPIC_FIELD")

// ---------------------------------------------------------------------------
// Issues — searched via JQL
// https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/
// ---------------------------------------------------------------------------

export type JiraIssue = {
  key: string
  self: string
  fields: {
    summary: string
    status: { name: string; statusCategory?: { name: string } } | null
    issuetype: { name: string } | null
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
    sprint?: { name: string; state: string } | null
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
  "sprint",
  "parent",
]

export function getIssueFields(): string[] {
  const fields = [...ISSUE_FIELDS]
  if (STORY_POINTS_FIELD) fields.push(STORY_POINTS_FIELD)
  if (EPIC_FIELD) fields.push(EPIC_FIELD)
  return fields
}

// Jira Cloud v3 returns descriptions in Atlassian Document Format (ADF),
// a JSON tree structure. This extracts readable plain text from it.
export function extractTextFromAdf(adf: unknown): string {
  if (!adf || typeof adf !== "object") return ""
  const node = adf as Record<string, unknown>

  if (node.type === "text" && typeof node.text === "string") {
    return node.text
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

export function getStoryPoints(issue: JiraIssue): number | null {
  if (!STORY_POINTS_FIELD) return null
  const value = issue.fields[STORY_POINTS_FIELD]
  return typeof value === "number" ? value : null
}

export function getEpicName(issue: JiraIssue): string | null {
  if (EPIC_FIELD) {
    const value = issue.fields[EPIC_FIELD]
    if (typeof value === "string") return value
  }
  if (issue.fields.parent?.fields?.summary) {
    return issue.fields.parent.fields.summary
  }
  if (issue.fields.parent?.key) {
    return issue.fields.parent.key
  }
  return null
}

function buildJql(): string {
  const projects = optionalEnv("JIRA_PROJECTS")
  if (projects) {
    const keys = projects.split(",").map((k) => k.trim()).filter(Boolean)
    return `project IN (${keys.join(",")}) ORDER BY updated DESC`
  }
  return "ORDER BY updated DESC"
}

type IssueSearchResponse = {
  issues: JiraIssue[]
  startAt: number
  maxResults: number
  total: number
}

export async function fetchIssuesPage(
  startAt?: number
): Promise<{ issues: JiraIssue[]; hasMore: boolean; nextStartAt: number }> {
  const baseUrl = getBaseUrl()
  const fields = getIssueFields()
  const s = startAt ?? 0
  const url = new URL(`${baseUrl}/rest/api/3/search`)
  url.searchParams.set("jql", buildJql())
  url.searchParams.set("fields", fields.join(","))
  url.searchParams.set("maxResults", "100")
  url.searchParams.set("startAt", String(s))

  const body = await fetchJson<IssueSearchResponse>(url.toString())
  return {
    issues: body.issues,
    hasMore: s + body.issues.length < body.total,
    nextStartAt: s + body.issues.length,
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
    if (err instanceof Error && err.message.includes("404")) {
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
  const url = `${baseUrl}/rest/api/3/project/search?startAt=${s}&maxResults=50`

  const body = await fetchJson<ProjectSearchResponse>(url)
  return {
    projects: body.values,
    hasMore: !body.isLast,
    nextStartAt: s + body.maxResults,
  }
}
