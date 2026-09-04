import {
  browseUrl,
  fetchBulkChangelogsPage,
  fetchSprintIssuesPage,
} from "./jira.js"
import type {
  JiraBoardConfiguration,
  JiraChangeHistory,
  JiraIssue,
  JiraSprint,
} from "./jira.js"
import type {
  NormalizedCompletion,
  NormalizedEstimate,
  NormalizedSprintIssueTimeline,
  NormalizedSprintMembership,
  SprintAnalyticsInput,
} from "./sprint-analytics.js"

type WaitFn = () => Promise<void>

export type SprintAnalyticsFetchOptions = {
  sprint: JiraSprint
  boardName: string
  boardConfig: JiraBoardConfiguration
  sprintFieldId?: string
  fallbackEstimateFieldId?: string
  storyPointFieldIds?: string[]
  priorSprintVelocities: number[]
  evaluatedAt: string
  baseUrl: string
  sprintNamesById: Record<string, string>
  waitFn?: WaitFn
}

type FieldChange = {
  at: string
  from?: string | null
  fromString?: string | null
  to?: string | null
  toString?: string | null
}

function historyTimestamp(value: string | number): string {
  if (typeof value === "number") {
    const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value
    return new Date(milliseconds).toISOString()
  }

  const milliseconds = Date.parse(value)
  if (Number.isNaN(milliseconds)) {
    throw new Error(`Invalid Jira changelog timestamp: ${value}`)
  }
  return new Date(milliseconds).toISOString()
}

function fieldChanges(
  histories: JiraChangeHistory[],
  fieldId: string,
  fieldName?: string
): FieldChange[] {
  const normalizedName = fieldName?.toLowerCase()
  const changes: FieldChange[] = []

  for (const history of histories) {
    const at = historyTimestamp(history.created)
    for (const item of history.items) {
      if (
        item.fieldId !== fieldId &&
        (!normalizedName || item.field.toLowerCase() !== normalizedName)
      ) {
        continue
      }
      changes.push({
        at,
        from: item.from,
        fromString: item.fromString,
        to: item.to,
        toString: item.toString,
      })
    }
  }

  return changes.sort((left, right) => left.at.localeCompare(right.at))
}

function sprintIds(value: string | null | undefined): number[] {
  if (!value) return []

  const explicitIds = [...value.matchAll(/\bid=(\d+)/g)].map((match) =>
    Number(match[1])
  )
  if (explicitIds.length > 0) return [...new Set(explicitIds)]

  return [...new Set((value.match(/\d+/g) ?? []).map((match) => Number(match)))]
}

function currentSprintIds(issue: JiraIssue, sprintFieldId?: string): number[] {
  if (!sprintFieldId) return []
  const value = issue.fields[sprintFieldId]
  if (!Array.isArray(value)) return []

  const ids: number[] = []
  for (const sprint of value) {
    if (typeof sprint === "number") {
      ids.push(sprint)
    } else if (typeof sprint === "string") {
      ids.push(...sprintIds(sprint))
    } else if (sprint && typeof sprint === "object") {
      const id = (sprint as Record<string, unknown>).id
      if (typeof id === "number") ids.push(id)
      if (typeof id === "string" && /^\d+$/.test(id)) ids.push(Number(id))
    }
  }
  return [...new Set(ids)]
}

function normalizeMemberships(
  sprintId: number,
  issue: JiraIssue,
  changes: FieldChange[],
  sprintFieldId?: string
): NormalizedSprintMembership[] {
  const earliestPossibleEntry = issue.fields.created || null

  if (changes.length === 0) {
    // The sprint endpoint itself proves membership even if Jira does not
    // expose the custom field or its history for this issue.
    return [{ enteredAt: earliestPossibleEntry, exitedAt: null }]
  }

  const memberships: NormalizedSprintMembership[] = []
  let active = sprintIds(changes[0].from).includes(sprintId)
  let enteredAt: string | null = active ? earliestPossibleEntry : null

  for (const change of changes) {
    const before = sprintIds(change.from).includes(sprintId)
    const after = sprintIds(change.to).includes(sprintId)

    if (!before && after && !active) {
      active = true
      enteredAt = change.at
    } else if (before && !after && active) {
      memberships.push({ enteredAt, exitedAt: change.at })
      active = false
      enteredAt = null
    } else {
      active = after
    }
  }

  if (active) memberships.push({ enteredAt, exitedAt: null })

  if (
    memberships.length === 0 &&
    currentSprintIds(issue, sprintFieldId).includes(sprintId)
  ) {
    memberships.push({ enteredAt: earliestPossibleEntry, exitedAt: null })
  }

  return memberships
}

function numberValue(value: string | null | undefined): number | null {
  if (value == null || value.trim() === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeEstimates(
  issue: JiraIssue,
  estimateFieldId: string | undefined,
  changes: FieldChange[],
  issueCount: boolean
): NormalizedEstimate[] {
  if (issueCount) return [{ at: null, value: 1 }]

  const currentValue = estimateFieldId
    ? issue.fields[estimateFieldId]
    : undefined
  const currentEstimate = typeof currentValue === "number" ? currentValue : null

  if (changes.length === 0) {
    return [{ at: null, value: currentEstimate }]
  }

  return [
    {
      at: null,
      value: numberValue(changes[0].from ?? changes[0].fromString),
    },
    ...changes.map((change) => ({
      at: change.at,
      value: numberValue(change.to ?? change.toString),
    })),
  ]
}

function normalizeCompletion(
  issue: JiraIssue,
  changes: FieldChange[],
  doneStatusIds: Set<string>
): NormalizedCompletion[] {
  const currentDone = Boolean(
    issue.fields.status?.id && doneStatusIds.has(issue.fields.status.id)
  )
  if (changes.length === 0) {
    return [{ at: null, completed: currentDone }]
  }

  return [
    {
      at: null,
      completed: Boolean(changes[0].from && doneStatusIds.has(changes[0].from)),
    },
    ...changes.map((change) => ({
      at: change.at,
      completed: Boolean(change.to && doneStatusIds.has(change.to)),
    })),
  ]
}

function findRollover(
  sprintId: number,
  completeAt: string | undefined,
  changes: FieldChange[],
  sprintNamesById: Record<string, string>
): { sprintId: string; sprintName: string } | null {
  if (!completeAt) return null
  const completeTime = Date.parse(completeAt)
  const lowerBound = completeTime - 5 * 60 * 1_000
  const upperBound = completeTime + 5 * 60 * 1_000

  for (const change of changes) {
    const changeTime = Date.parse(change.at)
    if (changeTime < lowerBound || changeTime > upperBound) continue
    const before = new Set(sprintIds(change.from))
    if (!before.has(sprintId)) continue
    const added = sprintIds(change.to).filter(
      (candidate) =>
        candidate !== sprintId &&
        !before.has(candidate) &&
        Object.prototype.hasOwnProperty.call(sprintNamesById, String(candidate))
    )
    if (added.length === 0) continue

    const nextSprintId = String(added[0])
    return {
      sprintId: nextSprintId,
      sprintName: sprintNamesById[nextSprintId] ?? `Sprint ${nextSprintId}`,
    }
  }
  return null
}

export function normalizeSprintIssueTimeline(
  issue: JiraIssue,
  histories: JiraChangeHistory[],
  options: {
    sprint: JiraSprint
    sprintFieldId?: string
    estimateFieldId?: string
    estimationType?: string
    doneStatusIds: string[]
    baseUrl: string
    sprintNamesById: Record<string, string>
  }
): NormalizedSprintIssueTimeline {
  const sprintChanges = options.sprintFieldId
    ? fieldChanges(histories, options.sprintFieldId, "sprint")
    : []
  const estimateChanges = options.estimateFieldId
    ? fieldChanges(histories, options.estimateFieldId)
    : []
  const statusChanges = fieldChanges(histories, "status", "status")

  return {
    id: issue.id,
    key: issue.key,
    summary: issue.fields.summary,
    url: browseUrl(options.baseUrl, issue.key),
    isSubtask: Boolean(
      issue.fields.issuetype?.subtask ||
        issue.fields.issuetype?.hierarchyLevel === -1
    ),
    memberships: normalizeMemberships(
      options.sprint.id,
      issue,
      sprintChanges,
      options.sprintFieldId
    ),
    estimates: normalizeEstimates(
      issue,
      options.estimateFieldId,
      estimateChanges,
      options.estimationType === "issueCount"
    ),
    completion: normalizeCompletion(
      issue,
      statusChanges,
      new Set(options.doneStatusIds)
    ),
    rollover: findRollover(
      options.sprint.id,
      options.sprint.state === "closed"
        ? (options.sprint.completeDate ?? undefined)
        : undefined,
      sprintChanges,
      options.sprintNamesById
    ),
  }
}

async function fetchAllSprintIssues(
  sprintId: number,
  fields: string[],
  waitFn?: WaitFn
): Promise<JiraIssue[]> {
  const issues: JiraIssue[] = []
  let nextPageToken: string | undefined

  do {
    if (waitFn) await waitFn()
    const page = await fetchSprintIssuesPage(sprintId, {
      fields,
      nextPageToken,
    })
    issues.push(...page.issues)
    nextPageToken = page.hasMore ? page.nextPageToken : undefined
  } while (nextPageToken)

  return issues
}

async function fetchAllChangelogs(
  issueIds: string[],
  fieldIds: string[],
  waitFn?: WaitFn
): Promise<Map<string, JiraChangeHistory[]>> {
  const result = new Map<string, JiraChangeHistory[]>()

  for (let offset = 0; offset < issueIds.length; offset += 1_000) {
    const chunk = issueIds.slice(offset, offset + 1_000)
    let nextPageToken: string | undefined

    do {
      if (waitFn) await waitFn()
      const page = await fetchBulkChangelogsPage(chunk, {
        fieldIds,
        nextPageToken,
      })
      for (const issue of page.issueChangeLogs) {
        const histories = result.get(issue.issueId) ?? []
        histories.push(...issue.changeHistories)
        result.set(issue.issueId, histories)
      }
      nextPageToken = page.hasMore ? page.nextPageToken : undefined
    } while (nextPageToken)
  }

  return result
}

export async function fetchSprintAnalyticsInput(
  options: SprintAnalyticsFetchOptions
): Promise<SprintAnalyticsInput> {
  const sprintFieldId = options.sprintFieldId
  const boardUsesIssueCount =
    options.boardConfig.estimationType === "issueCount" ||
    options.boardConfig.estimationType === "none"
  const configuredEstimateIsStoryPoints = Boolean(
    options.boardConfig.estimationType === "field" &&
      (options.boardConfig.estimationFieldName
        ?.toLowerCase()
        .includes("story point") ||
        (options.boardConfig.estimationFieldId &&
          [
            ...(options.storyPointFieldIds ?? []),
            options.fallbackEstimateFieldId,
          ]
            .filter(Boolean)
            .includes(options.boardConfig.estimationFieldId)))
  )
  const useStoryPoints =
    !boardUsesIssueCount &&
    (configuredEstimateIsStoryPoints ||
      (!options.boardConfig.estimationType &&
        Boolean(options.fallbackEstimateFieldId)))
  const estimateFieldId = useStoryPoints
    ? (options.boardConfig.estimationFieldId ?? options.fallbackEstimateFieldId)
    : undefined
  const fields = [
    "summary",
    "status",
    "issuetype",
    "created",
    sprintFieldId,
    estimateFieldId,
  ].filter((field): field is string => Boolean(field))
  const issues = await fetchAllSprintIssues(
    options.sprint.id,
    fields,
    options.waitFn
  )
  const fieldIds = [sprintFieldId, estimateFieldId, "status"].filter(
    (field): field is string => Boolean(field)
  )
  const histories =
    issues.length > 0
      ? await fetchAllChangelogs(
          issues.map((issue) => issue.id),
          fieldIds,
          options.waitFn
        )
      : new Map<string, JiraChangeHistory[]>()

  const startAt =
    options.sprint.startDate ?? options.sprint.endDate ?? options.evaluatedAt
  const endAt = options.sprint.endDate ?? options.evaluatedAt

  return {
    id: String(options.sprint.id),
    name: options.sprint.name,
    state: options.sprint.state as SprintAnalyticsInput["state"],
    boardId: String(options.sprint.originBoardId),
    boardName: options.boardName,
    goal: options.sprint.goal ?? undefined,
    startAt,
    endAt,
    completeAt: options.sprint.completeDate ?? undefined,
    evaluatedAt: options.evaluatedAt,
    issues: issues.map((issue) =>
      normalizeSprintIssueTimeline(issue, histories.get(issue.id) ?? [], {
        sprint: options.sprint,
        sprintFieldId,
        estimateFieldId,
        estimationType: useStoryPoints ? "field" : "issueCount",
        doneStatusIds: options.boardConfig.doneStatusIds,
        baseUrl: options.baseUrl,
        sprintNamesById: options.sprintNamesById,
      })
    ),
    estimationBasis: useStoryPoints ? "Story Points" : "Issue Count",
    priorSprintVelocities: options.priorSprintVelocities,
    historyQuality: {
      candidateSetComplete: false,
      membershipComplete: Boolean(sprintFieldId),
      estimatesComplete: Boolean(!useStoryPoints || estimateFieldId),
      completionComplete: options.boardConfig.doneStatusIds.length > 0,
      rolloverComplete: Boolean(
        sprintFieldId &&
          (options.sprint.state !== "closed" || options.sprint.completeDate)
      ),
      notes: [
        "Historical metrics are reconstructed from issues still associated with this sprint; issues removed before synchronization may be missing.",
        ...(options.boardConfig.estimationType === "field" && !useStoryPoints
          ? [
              `The board's ${
                options.boardConfig.estimationFieldName ?? "configured estimate"
              } is not a Story Points field, so this scorecard uses issue counts.`,
            ]
          : []),
      ],
    },
  }
}
