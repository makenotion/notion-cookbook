// Linear GraphQL API client. This module deliberately uses the public GraphQL
// API directly instead of the Linear SDK so that the example shows the full
// pagination, pacing, and rate-limit behavior required by a production sync.

import { RateLimitError } from "@notionhq/workers"

const API_URL = "https://api.linear.app/graphql"
const PAGE_SIZE = 50
// Initiative rows embed the first 50 contributing projects. A smaller outer
// page keeps the worst-case query comfortably below Linear's complexity cap.
const INITIATIVE_PAGE_SIZE = 20
const MAX_NESTED_LABEL_REQUESTS_PER_PAGE = 20
export const MAX_NESTED_INITIATIVE_PROJECT_REQUESTS_PER_PAGE = 20

export type BeforeRequest = () => Promise<void>

export type LinearPageInfo = {
  hasNextPage: boolean
  endCursor: string | null
}

export type LinearConnection<T> = {
  nodes: T[]
  pageInfo: LinearPageInfo
}

export type LinearPage<T> = {
  resources: T[]
  hasMore: boolean
  nextCursor: string | undefined
}

export type LinearUser = {
  name: string | null
  displayName: string | null
}

export type LinearStatusUpdate = {
  body: string
  createdAt: string
  updatedAt: string
  url: string
  user: LinearUser | null
}

export type LinearProjectStatus = {
  name: string
  type: string
}

export type LinearProject = {
  id: string
  name: string
  slugId: string
  url: string
  status: LinearProjectStatus | null
  health: string | null
  lastUpdate: LinearStatusUpdate | null
  lead: LinearUser | null
  priority: number | null
  priorityLabel: string | null
  progress: number | null
  startDate: string | null
  targetDate: string | null
  startedAt: string | null
  completedAt: string | null
  canceledAt: string | null
  createdAt: string
  updatedAt: string
  description: string | null
  content: string | null
  archivedAt: string | null
  trashed: boolean | null
}

export type LinearIssueState = {
  name: string
  type: string
}

export type LinearLabel = {
  name: string
}

export type LinearIssue = {
  id: string
  identifier: string
  title: string
  url: string
  description: string | null
  state: LinearIssueState | null
  priority: number
  priorityLabel: string
  assignee: LinearUser | null
  team: { name: string; key: string } | null
  project: { name: string } | null
  cycle: { name: string; number: number } | null
  labels: LinearConnection<LinearLabel>
  estimate: number | null
  dueDate: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
  canceledAt: string | null
  archivedAt: string | null
  trashed: boolean | null
}

export type LinearInitiative = {
  id: string
  name: string
  slugId: string
  url: string
  status: string | null
  health: string | null
  lastUpdate: LinearStatusUpdate | null
  owner: LinearUser | null
  projects: LinearConnection<LinearInitiativeProject>
  targetDate: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
  description: string | null
  content: string | null
  archivedAt: string | null
  trashed: boolean | null
}

export type LinearInitiativeProject = {
  id: string
  name: string
  url: string
  updatedAt: string
  archivedAt: string | null
  trashed: boolean | null
}

export type FetchIssuesOptions = {
  after?: string
  updatedSince?: string
  updatedBefore?: string
}

type GraphQLError = {
  message?: string
  type?: string
  extensions?: {
    code?: string
    type?: string
    [key: string]: unknown
  }
}

type GraphQLResponse<T> = {
  data?: T | null
  errors?: GraphQLError[]
}

function getApiKey(): string {
  const apiKey = process.env.LINEAR_API_KEY?.trim()
  if (!apiKey) {
    throw new Error("LINEAR_API_KEY is not set.")
  }
  return apiKey
}

/**
 * Parse the standard Retry-After header. It can be either delta-seconds or an
 * HTTP date. Workers' RateLimitError expects the resulting delay in seconds.
 */
export function parseRetryAfterSeconds(
  value: string | null,
  now = Date.now()
): number | undefined {
  if (!value?.trim()) return undefined

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds)
  }

  const retryAt = Date.parse(value)
  if (!Number.isFinite(retryAt)) return undefined
  return Math.max(0, Math.ceil((retryAt - now) / 1_000))
}

type RateLimitHeaderPair = {
  remaining: string
  reset: string
}

// Linear has independent workspace request, endpoint request, and query
// complexity budgets. Header names have evolved, so accept the documented
// names plus the older endpoint aliases when calculating a retry delay.
const RATE_LIMIT_HEADER_PAIRS: RateLimitHeaderPair[] = [
  {
    remaining: "x-ratelimit-requests-remaining",
    reset: "x-ratelimit-requests-reset",
  },
  {
    remaining: "x-ratelimit-endpoint-requests-remaining",
    reset: "x-ratelimit-endpoint-requests-reset",
  },
  {
    remaining: "x-ratelimit-endpoint-remaining",
    reset: "x-ratelimit-endpoint-reset",
  },
  {
    remaining: "x-ratelimit-complexity-remaining",
    reset: "x-ratelimit-complexity-reset",
  },
  {
    remaining: "x-ratelimit-endpoint-complexity-remaining",
    reset: "x-ratelimit-endpoint-complexity-reset",
  },
]

/** Return the longest applicable retry delay across all exhausted budgets. */
export function rateLimitRetryAfterSeconds(
  headers: Headers,
  now = Date.now()
): number | undefined {
  const delays: number[] = []
  const retryAfter = parseRetryAfterSeconds(headers.get("retry-after"), now)
  if (retryAfter !== undefined) delays.push(retryAfter)

  for (const pair of RATE_LIMIT_HEADER_PAIRS) {
    const remainingValue = headers.get(pair.remaining)
    if (remainingValue === null) continue

    const remaining = Number(remainingValue)
    if (!Number.isFinite(remaining) || remaining > 0) continue

    // Linear documents reset timestamps as epoch milliseconds.
    const resetAt = Number(headers.get(pair.reset))
    if (!Number.isFinite(resetAt) || resetAt < 0) continue
    delays.push(Math.max(0, Math.ceil((resetAt - now) / 1_000)))
  }

  return delays.length > 0 ? Math.max(...delays) : undefined
}

function isRateLimitError(error: GraphQLError): boolean {
  const classifications = [
    error.type,
    error.extensions?.code,
    error.extensions?.type,
  ]

  return classifications.some(
    (value) =>
      typeof value === "string" &&
      value.replace(/[\s_-]/g, "").toUpperCase() === "RATELIMITED"
  )
}

function graphQLErrorMessage(errors: GraphQLError[]): string {
  const messages = errors
    .map((error) => error.message?.trim())
    .filter((message): message is string => Boolean(message))
  return messages.length > 0 ? messages.join("; ") : "Unknown GraphQL error"
}

/**
 * Execute one GraphQL operation. The pacing callback is deliberately called
 * here, immediately before fetch, so it also covers follow-up label pages.
 * GraphQL partial responses are rejected: accepting data alongside errors can
 * silently create incomplete Notion rows.
 */
async function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
  beforeRequest: BeforeRequest
): Promise<T> {
  const apiKey = getApiKey()

  await beforeRequest()
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    redirect: "error",
  })

  const text = await response.text()
  let body: GraphQLResponse<T> | undefined
  if (text) {
    try {
      body = JSON.parse(text) as GraphQLResponse<T>
    } catch {
      if (response.status === 429) {
        throw new RateLimitError({
          retryAfter: rateLimitRetryAfterSeconds(response.headers),
        })
      }
      throw new Error(
        `Linear API returned invalid JSON (${response.status}): ${text.slice(0, 500)}`
      )
    }
  }

  if (response.status === 429) {
    throw new RateLimitError({
      retryAfter: rateLimitRetryAfterSeconds(response.headers),
    })
  }

  const errors = Array.isArray(body?.errors) ? body.errors : []
  if (errors.some(isRateLimitError)) {
    throw new RateLimitError({
      retryAfter: rateLimitRetryAfterSeconds(response.headers),
    })
  }

  if (!response.ok) {
    const detail =
      errors.length > 0
        ? graphQLErrorMessage(errors)
        : text || "No response body"
    throw new Error(`Linear API error (${response.status}): ${detail}`)
  }

  if (errors.length > 0) {
    throw new Error(`Linear GraphQL error: ${graphQLErrorMessage(errors)}`)
  }
  if (!body || body.data === undefined || body.data === null) {
    throw new Error("Linear GraphQL response is missing data")
  }

  return body.data
}

function connectionToPage<T>(
  connection: LinearConnection<T>,
  after: string | undefined,
  resourceName: string
): LinearPage<T> {
  if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) {
    throw new Error(`Linear ${resourceName} response has an invalid connection`)
  }

  const { hasNextPage, endCursor } = connection.pageInfo
  if (typeof hasNextPage !== "boolean") {
    throw new Error(
      `Linear ${resourceName} response is missing pageInfo.hasNextPage`
    )
  }
  if (hasNextPage && !endCursor) {
    throw new Error(
      `Linear ${resourceName} pagination response is missing endCursor`
    )
  }
  if (hasNextPage && endCursor === after) {
    throw new Error(`Linear ${resourceName} pagination repeated cursor`)
  }

  return {
    resources: connection.nodes,
    hasMore: hasNextPage,
    nextCursor: hasNextPage ? endCursor ?? undefined : undefined,
  }
}

const PROJECTS_QUERY = /* GraphQL */ `
  query Projects($after: String) {
    projects(
      first: ${PAGE_SIZE}
      after: $after
      orderBy: createdAt
      includeArchived: true
    ) {
      nodes {
        id
        name
        slugId
        url
        status {
          name
          type
        }
        health
        lastUpdate {
          body
          createdAt
          updatedAt
          url
          user {
            name
            displayName
          }
        }
        lead {
          name
          displayName
        }
        priority
        priorityLabel
        progress
        startDate
        targetDate
        startedAt
        completedAt
        canceledAt
        createdAt
        updatedAt
        description
        content
        archivedAt
        trashed
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`

export async function fetchProjectsPage(
  beforeRequest: BeforeRequest,
  after?: string
): Promise<LinearPage<LinearProject>> {
  const data = await graphql<{
    projects: LinearConnection<LinearProject>
  }>(PROJECTS_QUERY, after ? { after } : {}, beforeRequest)

  return connectionToPage(data.projects, after, "projects")
}

const ISSUES_QUERY = /* GraphQL */ `
  query Issues(
    $after: String
    $filter: IssueFilter
    $orderBy: PaginationOrderBy!
  ) {
    issues(
      first: ${PAGE_SIZE}
      after: $after
      orderBy: $orderBy
      includeArchived: true
      filter: $filter
    ) {
      nodes {
        id
        identifier
        title
        url
        description
        state {
          name
          type
        }
        priority
        priorityLabel
        assignee {
          name
          displayName
        }
        team {
          name
          key
        }
        project {
          name
        }
        cycle {
          name
          number
        }
        labels(first: ${PAGE_SIZE}, includeArchived: true) {
          nodes {
            name
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
        estimate
        dueDate
        createdAt
        updatedAt
        startedAt
        completedAt
        canceledAt
        archivedAt
        trashed
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`

const ISSUE_LABELS_QUERY = /* GraphQL */ `
  query IssueLabels($issueId: String!, $after: String!) {
    issue(id: $issueId) {
      labels(
        first: ${PAGE_SIZE}
        after: $after
        includeArchived: true
      ) {
        nodes {
          name
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`

function assertLabelsConnection(
  labels: LinearConnection<LinearLabel>,
  issueId: string
): void {
  if (!labels || !Array.isArray(labels.nodes) || !labels.pageInfo) {
    throw new Error(`Linear issue ${issueId} has an invalid labels connection`)
  }
  if (typeof labels.pageInfo.hasNextPage !== "boolean") {
    throw new Error(
      `Linear issue ${issueId} labels response is missing hasNextPage`
    )
  }
  if (labels.pageInfo.hasNextPage && !labels.pageInfo.endCursor) {
    throw new Error(
      `Linear issue ${issueId} labels pagination is missing endCursor`
    )
  }
}

async function fetchAllIssueLabels(
  issue: LinearIssue,
  beforeRequest: BeforeRequest,
  requestBudget: { remaining: number }
): Promise<LinearIssue> {
  assertLabelsConnection(issue.labels, issue.id)
  if (!issue.labels.pageInfo.hasNextPage) {
    return {
      ...issue,
      labels: {
        ...issue.labels,
        nodes: dedupeLabels(issue.labels.nodes),
      },
    }
  }

  const labels = [...issue.labels.nodes]
  const seenCursors = new Set<string>()
  let pageInfo = issue.labels.pageInfo

  while (pageInfo.hasNextPage) {
    if (requestBudget.remaining <= 0) {
      throw new Error(
        `Linear issue labels exceeded ${MAX_NESTED_LABEL_REQUESTS_PER_PAGE} follow-up requests for one issue page`
      )
    }

    const after = pageInfo.endCursor
    if (!after) {
      throw new Error(
        `Linear issue ${issue.id} labels pagination is missing endCursor`
      )
    }
    if (seenCursors.has(after)) {
      throw new Error(
        `Linear issue ${issue.id} labels pagination repeated cursor`
      )
    }
    seenCursors.add(after)
    requestBudget.remaining -= 1

    const data = await graphql<{
      issue: { labels: LinearConnection<LinearLabel> } | null
    }>(ISSUE_LABELS_QUERY, { issueId: issue.id, after }, beforeRequest)
    if (!data.issue) {
      throw new Error(
        `Linear issue ${issue.id} disappeared while paginating labels`
      )
    }

    assertLabelsConnection(data.issue.labels, issue.id)
    labels.push(...data.issue.labels.nodes)
    pageInfo = data.issue.labels.pageInfo
  }

  return {
    ...issue,
    labels: {
      nodes: dedupeLabels(labels),
      pageInfo,
    },
  }
}

function dedupeLabels(labels: LinearLabel[]): LinearLabel[] {
  const names = new Set<string>()
  return labels.filter((label) => {
    if (names.has(label.name)) return false
    names.add(label.name)
    return true
  })
}

export async function fetchIssuesPage(
  beforeRequest: BeforeRequest,
  options: FetchIssuesOptions = {}
): Promise<LinearPage<LinearIssue>> {
  const hasUpdatedAtFilter =
    options.updatedSince !== undefined || options.updatedBefore !== undefined
  const variables: Record<string, unknown> = {
    // Replacement sweeps use stable creation order; bounded incremental
    // windows must use updated order so cursor traversal matches the filter.
    orderBy: hasUpdatedAtFilter ? "updatedAt" : "createdAt",
  }
  if (options.after) variables.after = options.after

  const updatedAt: { gte?: string; lt?: string } = {}
  if (options.updatedSince !== undefined) updatedAt.gte = options.updatedSince
  if (options.updatedBefore !== undefined) updatedAt.lt = options.updatedBefore
  if (Object.keys(updatedAt).length > 0) {
    variables.filter = { updatedAt }
  }

  const data = await graphql<{
    issues: LinearConnection<LinearIssue>
  }>(ISSUES_QUERY, variables, beforeRequest)
  const page = connectionToPage(data.issues, options.after, "issues")

  // A nested connection only incurs extra API requests when an issue actually
  // has more than PAGE_SIZE labels. Bound all label follow-ups for this issue
  // page so one pathological workspace cannot create an unbounded execution.
  const resources: LinearIssue[] = []
  const nestedRequestBudget = {
    remaining: MAX_NESTED_LABEL_REQUESTS_PER_PAGE,
  }
  for (const issue of page.resources) {
    resources.push(
      await fetchAllIssueLabels(issue, beforeRequest, nestedRequestBudget)
    )
  }

  return { ...page, resources }
}

const INITIATIVES_QUERY = /* GraphQL */ `
  query Initiatives($after: String) {
    initiatives(
      first: ${INITIATIVE_PAGE_SIZE}
      after: $after
      orderBy: createdAt
      includeArchived: true
    ) {
      nodes {
        id
        name
        slugId
        url
        status
        health
        lastUpdate {
          body
          createdAt
          updatedAt
          url
          user {
            name
            displayName
          }
        }
        owner {
          name
          displayName
        }
        projects(
          first: ${PAGE_SIZE}
          orderBy: createdAt
          includeArchived: true
          includeSubInitiatives: true
        ) {
          nodes {
            id
            name
            url
            updatedAt
            archivedAt
            trashed
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
        targetDate
        startedAt
        completedAt
        createdAt
        updatedAt
        description
        content
        archivedAt
        trashed
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`

const INITIATIVE_PROJECTS_QUERY = /* GraphQL */ `
  query InitiativeProjects($initiativeId: String!, $after: String!) {
    initiative(id: $initiativeId) {
      projects(
        first: ${PAGE_SIZE}
        after: $after
        orderBy: createdAt
        includeArchived: true
        includeSubInitiatives: true
      ) {
        nodes {
          id
          name
          url
          updatedAt
          archivedAt
          trashed
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`

function assertInitiativeProjectsConnection(
  projects: LinearConnection<LinearInitiativeProject>,
  initiativeId: string
): void {
  if (!projects || !Array.isArray(projects.nodes) || !projects.pageInfo) {
    throw new Error(
      `Linear initiative ${initiativeId} has an invalid projects connection`
    )
  }
  if (typeof projects.pageInfo.hasNextPage !== "boolean") {
    throw new Error(
      `Linear initiative ${initiativeId} projects response is missing hasNextPage`
    )
  }
  if (projects.pageInfo.hasNextPage && !projects.pageInfo.endCursor) {
    throw new Error(
      `Linear initiative ${initiativeId} projects pagination is missing endCursor`
    )
  }
}

function dedupeInitiativeProjects(
  projects: LinearInitiativeProject[]
): LinearInitiativeProject[] {
  const projectsById = new Map<string, LinearInitiativeProject>()
  for (const project of projects) {
    const existing = projectsById.get(project.id)
    const projectUpdatedAt = Date.parse(project.updatedAt)
    const existingUpdatedAt = existing
      ? Date.parse(existing.updatedAt)
      : Number.NaN
    if (
      !existing ||
      (Number.isFinite(projectUpdatedAt) &&
        (!Number.isFinite(existingUpdatedAt) ||
          projectUpdatedAt > existingUpdatedAt)) ||
      (projectUpdatedAt === existingUpdatedAt &&
        Boolean(existing.trashed) &&
        !project.trashed)
    ) {
      projectsById.set(project.id, project)
    }
  }
  return [...projectsById.values()]
}

async function fetchAllInitiativeProjects(
  initiative: LinearInitiative,
  beforeRequest: BeforeRequest,
  requestBudget: { remaining: number }
): Promise<LinearInitiative> {
  assertInitiativeProjectsConnection(initiative.projects, initiative.id)
  if (!initiative.projects.pageInfo.hasNextPage) {
    return {
      ...initiative,
      projects: {
        ...initiative.projects,
        nodes: dedupeInitiativeProjects(initiative.projects.nodes),
      },
    }
  }

  const projects = [...initiative.projects.nodes]
  const seenCursors = new Set<string>()
  let pageInfo = initiative.projects.pageInfo

  while (pageInfo.hasNextPage) {
    if (requestBudget.remaining <= 0) {
      throw new Error(
        `Linear initiative projects exceeded ${MAX_NESTED_INITIATIVE_PROJECT_REQUESTS_PER_PAGE} follow-up requests for one initiative page`
      )
    }

    const after = pageInfo.endCursor
    if (!after) {
      throw new Error(
        `Linear initiative ${initiative.id} projects pagination is missing endCursor`
      )
    }
    if (seenCursors.has(after)) {
      throw new Error(
        `Linear initiative ${initiative.id} projects pagination repeated cursor`
      )
    }
    seenCursors.add(after)
    requestBudget.remaining -= 1

    const data = await graphql<{
      initiative: {
        projects: LinearConnection<LinearInitiativeProject>
      } | null
    }>(
      INITIATIVE_PROJECTS_QUERY,
      { initiativeId: initiative.id, after },
      beforeRequest
    )
    if (!data.initiative) {
      throw new Error(
        `Linear initiative ${initiative.id} disappeared while paginating projects`
      )
    }

    assertInitiativeProjectsConnection(data.initiative.projects, initiative.id)
    projects.push(...data.initiative.projects.nodes)
    pageInfo = data.initiative.projects.pageInfo
  }

  return {
    ...initiative,
    projects: {
      nodes: dedupeInitiativeProjects(projects),
      pageInfo,
    },
  }
}

export async function fetchInitiativesPage(
  beforeRequest: BeforeRequest,
  after?: string
): Promise<LinearPage<LinearInitiative>> {
  const data = await graphql<{
    initiatives: LinearConnection<LinearInitiative>
  }>(INITIATIVES_QUERY, after ? { after } : {}, beforeRequest)
  const page = connectionToPage(data.initiatives, after, "initiatives")
  const nestedRequestBudget = {
    remaining: MAX_NESTED_INITIATIVE_PROJECT_REQUESTS_PER_PAGE,
  }
  const resources: LinearInitiative[] = []
  for (const initiative of page.resources) {
    resources.push(
      await fetchAllInitiativeProjects(
        initiative,
        beforeRequest,
        nestedRequestBudget
      )
    )
  }

  return { ...page, resources }
}
