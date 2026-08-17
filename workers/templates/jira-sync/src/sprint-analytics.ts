import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"
import { dateOnly } from "./helpers.js"

export const ALL_SPRINTS_INITIAL_TITLE = "Jira Sprint Performance"
export const ALL_SPRINTS_PRIMARY_KEY = "Sprint ID"

export const allSprintsSchema: Schema.Schema<typeof ALL_SPRINTS_PRIMARY_KEY> = {
  databaseIcon: notionIcon("chart-line"),
  properties: {
    Name: Schema.title(),
    State: Schema.select([
      { name: "Active" },
      { name: "Closed" },
      { name: "Future" },
    ]),
    Board: Schema.richText(),
    Goal: Schema.richText(),
    "Start Date": Schema.date(),
    "End Date": Schema.date(),
    "Complete Date": Schema.date(),
    "Committed Issues": Schema.number(),
    "Committed Points": Schema.number(),
    "Current Issues": Schema.number(),
    "Current Points": Schema.number(),
    "Completed Issues": Schema.number(),
    "Completed Points": Schema.number(),
    "Added Issues": Schema.number(),
    "Added Points": Schema.number(),
    "Removed Issues": Schema.number(),
    "Removed Points": Schema.number(),
    "Estimate Change": Schema.number(),
    "Net Scope Change": Schema.number(),
    "Scope Change %": Schema.number("percent"),
    "Rolled Over Issues": Schema.number(),
    "Rolled Over Points": Schema.number(),
    "Completion %": Schema.number("percent"),
    "Predictability %": Schema.number("percent"),
    Velocity: Schema.number(),
    "3-Sprint Velocity": Schema.number(),
    "5-Sprint Velocity": Schema.number(),
    "Delivery Forecast": Schema.select([
      { name: "Not Started" },
      { name: "On Track" },
      { name: "At Risk" },
      { name: "Off Track" },
      { name: "Delivered" },
      { name: "Partially Delivered" },
      { name: "Missed" },
      { name: "No Scope" },
      { name: "Insufficient Data" },
    ]),
    "Forecast Completion %": Schema.number("percent"),
    "Days Remaining": Schema.number(),
    "Estimation Basis": Schema.select([
      { name: "Story Points" },
      { name: "Issue Count" },
    ]),
    "Data Quality": Schema.select([
      { name: "Complete" },
      { name: "Partial" },
      { name: "Limited" },
    ]),
    "Unestimated Issues": Schema.number(),
    "Metrics Updated": Schema.date(),
    "Board ID": Schema.richText(),
    "Sprint ID": Schema.richText(),
  },
}

export type SprintAnalyticsState = "active" | "closed" | "future"

/**
 * A period during which an issue belonged to this sprint. `enteredAt: null`
 * means it was already in the sprint before the available history starts;
 * `exitedAt: null` means it had not left by `evaluatedAt`.
 */
export type NormalizedSprintMembership = {
  enteredAt: string | null
  exitedAt: string | null
}

/**
 * A point-in-time estimate. `at: null` is the baseline before the first known
 * change. A null value is an explicitly unestimated issue, not missing data.
 */
export type NormalizedEstimate = {
  at: string | null
  value: number | null
}

/**
 * A point-in-time completion state based on the board's Done column. `at:
 * null` is the baseline state before the first known transition.
 */
export type NormalizedCompletion = {
  at: string | null
  completed: boolean
}

export type NormalizedSprintIssueTimeline = {
  id: string
  key: string
  summary: string
  url?: string
  isSubtask?: boolean
  memberships: NormalizedSprintMembership[]
  estimates: NormalizedEstimate[]
  completion: NormalizedCompletion[]
  rollover?: {
    sprintId: string
    sprintName: string
  } | null
}

export type SprintAnalyticsHistoryQuality = {
  candidateSetComplete?: boolean
  membershipComplete?: boolean
  estimatesComplete?: boolean
  completionComplete?: boolean
  rolloverComplete?: boolean
  notes?: string[]
}

/**
 * Jira-specific changelog and board responses should be normalized into this
 * input before calling the analytics helpers. `priorSprintVelocities` must be
 * from the same board, newest first, and must not include the current sprint.
 */
export type SprintAnalyticsInput = {
  id: string
  name: string
  state: SprintAnalyticsState
  boardId?: string
  boardName?: string
  goal?: string
  startAt: string
  endAt: string
  completeAt?: string
  evaluatedAt: string
  issues: NormalizedSprintIssueTimeline[]
  estimationBasis?: "Story Points" | "Issue Count"
  priorSprintVelocities?: number[]
  historyQuality?: SprintAnalyticsHistoryQuality
}

export type DeliveryForecast =
  | "Not Started"
  | "On Track"
  | "At Risk"
  | "Off Track"
  | "Delivered"
  | "Partially Delivered"
  | "Missed"
  | "No Scope"
  | "Insufficient Data"

export type SprintDataQuality = "Complete" | "Partial" | "Limited"

export type SprintAnalytics = {
  cutoffAt: string
  committedIssueCount: number
  committedPoints: number
  currentIssueCount: number
  currentPoints: number
  completedIssueCount: number
  completedPoints: number
  addedIssueCount: number
  addedPoints: number
  removedIssueCount: number
  removedPoints: number
  estimateChange: number
  reconstructedScopePoints: number
  netScopeChangePoints: number
  scopeChangePercent: number | null
  rolledOverIssueCount: number
  rolledOverPoints: number
  completionPercent: number | null
  predictabilityPercent: number | null
  velocity: number
  rollingVelocity3: number | null
  rollingVelocity5: number | null
  deliveryForecast: DeliveryForecast
  forecastCompletionPercent: number | null
  daysRemaining: number
  estimationBasis: "Story Points" | "Issue Count"
  dataQuality: SprintDataQuality
  dataQualityNotes: string[]
  unestimatedIssueCount: number
}

type ClassifiedIssue = {
  issue: NormalizedSprintIssueTimeline
  committed: boolean
  current: boolean
  completed: boolean
  added: boolean
  removed: boolean
  rolledOver: boolean
  estimateAtCutoff: number | null
  pointsAtCutoff: number
}

type Calculation = {
  analytics: SprintAnalytics
  issues: ClassifiedIssue[]
}

const DAY_MS = 24 * 60 * 60 * 1_000

function timestamp(value: string, field: string): number {
  const result = Date.parse(value)
  if (Number.isNaN(result)) {
    throw new Error(`${field} must be an ISO 8601 timestamp; received ${value}`)
  }
  return result
}

function optionalTimestamp(value: string | null): number {
  return value === null
    ? Number.NEGATIVE_INFINITY
    : timestamp(value, "event.at")
}

function evaluationCutoff(input: SprintAnalyticsInput): number {
  const evaluatedAt = timestamp(input.evaluatedAt, "evaluatedAt")
  if (input.state !== "closed") return evaluatedAt

  return timestamp(input.completeAt ?? input.endAt, "completeAt")
}

function isMemberAt(issue: NormalizedSprintIssueTimeline, at: number): boolean {
  return issue.memberships.some((membership) => {
    const enteredAt = optionalTimestamp(membership.enteredAt)
    const exitedAt = membership.exitedAt
      ? timestamp(membership.exitedAt, "membership.exitedAt")
      : Number.POSITIVE_INFINITY
    return enteredAt <= at && at < exitedAt
  })
}

function estimateAt(
  issue: NormalizedSprintIssueTimeline,
  at: number
): number | null {
  let selected: NormalizedEstimate | undefined
  let selectedAt = Number.NEGATIVE_INFINITY

  for (const estimate of issue.estimates) {
    const effectiveAt = optionalTimestamp(estimate.at)
    if (effectiveAt <= at && effectiveAt >= selectedAt) {
      selected = estimate
      selectedAt = effectiveAt
    }
  }

  return selected?.value ?? null
}

function completedAt(
  issue: NormalizedSprintIssueTimeline,
  at: number
): boolean {
  let selected: NormalizedCompletion | undefined
  let selectedAt = Number.NEGATIVE_INFINITY

  for (const state of issue.completion) {
    const effectiveAt = optionalTimestamp(state.at)
    if (effectiveAt <= at && effectiveAt >= selectedAt) {
      selected = state
      selectedAt = effectiveAt
    }
  }

  return selected?.completed ?? false
}

function points(value: number | null): number {
  return value ?? 0
}

function average(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((total, value) => total + value, 0) / values.length
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

function calculateDataQuality(
  input: SprintAnalyticsInput,
  unestimatedIssueCount: number
): { quality: SprintDataQuality; notes: string[] } {
  const quality = input.historyQuality
  const notes = [...(quality?.notes ?? [])]

  if (
    quality?.candidateSetComplete === false &&
    !notes.some((note) =>
      note.toLowerCase().includes("removed before synchronization")
    )
  ) {
    notes.push("Issues removed before synchronization may be missing.")
  }
  if (quality?.membershipComplete === false) {
    notes.push("Sprint membership history is incomplete.")
  }
  if (quality?.completionComplete === false) {
    notes.push("Completion history is incomplete.")
  }
  if (quality?.estimatesComplete === false) {
    notes.push("Estimate history is incomplete.")
  }
  if (quality?.rolloverComplete === false) {
    notes.push("Rollover detection is incomplete.")
  }
  if (unestimatedIssueCount > 0) {
    notes.push(`${unestimatedIssueCount} in-scope issue(s) have no estimate.`)
  }

  const limited =
    quality?.membershipComplete === false ||
    quality?.completionComplete === false
  const partial =
    quality?.candidateSetComplete === false ||
    quality?.estimatesComplete === false ||
    quality?.rolloverComplete === false ||
    unestimatedIssueCount > 0

  return {
    quality: limited ? "Limited" : partial ? "Partial" : "Complete",
    notes: [...new Set(notes)],
  }
}

function forecast(
  input: SprintAnalyticsInput,
  completedPoints: number,
  completedIssueCount: number,
  currentPoints: number,
  currentIssueCount: number,
  rollingVelocity3: number | null,
  startAt: number,
  endAt: number,
  cutoffAt: number
): {
  label: DeliveryForecast
  completion: number | null
  basis: "Story Points" | "Issue Count"
} {
  const usePoints =
    input.estimationBasis === "Story Points" ||
    (input.estimationBasis === undefined && currentPoints > 0)
  const scope = usePoints ? currentPoints : currentIssueCount
  const completed = usePoints ? completedPoints : completedIssueCount
  const basis = usePoints ? "Story Points" : "Issue Count"

  if (scope === 0) {
    return { label: "No Scope", completion: null, basis }
  }

  if (input.state === "future" || cutoffAt < startAt) {
    return { label: "Not Started", completion: 0, basis }
  }

  if (input.state === "closed") {
    const completion = completed / scope
    const label =
      completion >= 1
        ? "Delivered"
        : completion >= 0.8
          ? "Partially Delivered"
          : "Missed"
    return { label, completion, basis }
  }

  if (rollingVelocity3 == null) {
    return { label: "Insufficient Data", completion: null, basis }
  }

  const duration = Math.max(1, endAt - startAt)
  const elapsedFraction = Math.min(
    1,
    Math.max(0, (cutoffAt - startAt) / duration)
  )
  const remainingFraction = 1 - elapsedFraction

  const projected = completed + rollingVelocity3 * remainingFraction

  const completion = Math.min(1, projected / scope)
  const label =
    completion >= 1 ? "On Track" : completion >= 0.8 ? "At Risk" : "Off Track"
  return { label, completion, basis }
}

function calculate(input: SprintAnalyticsInput): Calculation {
  const startAt = timestamp(input.startAt, "startAt")
  const endAt = timestamp(input.endAt, "endAt")
  const cutoffAt = evaluationCutoff(input)
  if (endAt <= startAt) {
    throw new Error("endAt must be after startAt")
  }

  const includedIssues = input.issues.filter((issue) => !issue.isSubtask)
  const classified: ClassifiedIssue[] = includedIssues.map((issue) => {
    const committed = isMemberAt(issue, startAt)
    const current =
      isMemberAt(issue, cutoffAt) ||
      (input.state === "closed" && Boolean(issue.rollover))
    const added = issue.memberships.some((membership) => {
      if (!membership.enteredAt) return false
      const enteredAt = timestamp(membership.enteredAt, "membership.enteredAt")
      return enteredAt > startAt && enteredAt <= cutoffAt
    })
    const removed = issue.memberships.some((membership) => {
      if (!membership.exitedAt) return false
      const exitedAt = timestamp(membership.exitedAt, "membership.exitedAt")
      return exitedAt > startAt && exitedAt < cutoffAt
    })
    const completed = current && completedAt(issue, cutoffAt)
    const rolledOver =
      input.state === "closed" &&
      current &&
      !completed &&
      Boolean(issue.rollover)
    const estimateAtCutoff = estimateAt(issue, cutoffAt)

    return {
      issue,
      committed,
      current,
      completed,
      added,
      removed,
      rolledOver,
      estimateAtCutoff,
      pointsAtCutoff: points(estimateAtCutoff),
    }
  })

  const committed = classified.filter((item) => item.committed)
  const current = classified.filter((item) => item.current)
  const completed = classified.filter((item) => item.completed)
  const added = classified.filter((item) => item.added)
  const removed = classified.filter((item) => item.removed)
  const rolledOver = classified.filter((item) => item.rolledOver)

  const committedPoints = committed.reduce(
    (total, item) => total + points(estimateAt(item.issue, startAt)),
    0
  )
  const currentPoints = current.reduce(
    (total, item) => total + item.pointsAtCutoff,
    0
  )
  const completedPoints = completed.reduce(
    (total, item) => total + item.pointsAtCutoff,
    0
  )

  let addedPoints = 0
  let removedPoints = 0
  let estimateChange = 0

  for (const item of classified) {
    const enteredAt = item.issue.memberships
      .map((membership) => membership.enteredAt)
      .filter((value): value is string => value !== null)
      .map((value) => timestamp(value, "membership.enteredAt"))
      .filter((value) => value > startAt && value <= cutoffAt)
      .sort((left, right) => left - right)[0]
    if (enteredAt !== undefined) {
      addedPoints += points(estimateAt(item.issue, enteredAt))
    }

    const exitedAt = item.issue.memberships
      .map((membership) => membership.exitedAt)
      .filter((value): value is string => value !== null)
      .map((value) => timestamp(value, "membership.exitedAt"))
      .filter((value) => value > startAt && value < cutoffAt)
      .sort((left, right) => left - right)[0]
    if (exitedAt !== undefined) {
      removedPoints += points(estimateAt(item.issue, exitedAt))
    }

    const estimateEvents = item.issue.estimates
      .filter((event) => event.at !== null)
      .map((event) => ({
        ...event,
        time: timestamp(event.at as string, "estimate.at"),
      }))
      .filter((event) => event.time > startAt && event.time <= cutoffAt)
      .sort((a, b) => a.time - b.time)

    for (const event of estimateEvents) {
      // Looking one millisecond before the change prevents an estimate set at
      // the exact moment an issue enters the sprint from being double-counted.
      if (!isMemberAt(item.issue, event.time - 1)) continue
      const before = points(estimateAt(item.issue, event.time - 1))
      estimateChange += points(event.value) - before
    }
  }

  const rolledOverPoints = rolledOver.reduce(
    (total, item) => total + item.pointsAtCutoff,
    0
  )
  const unestimatedIssueCount = current.filter(
    (item) => item.estimateAtCutoff === null
  ).length
  const previousVelocities = input.priorSprintVelocities ?? []
  const usePoints =
    input.estimationBasis === "Story Points" ||
    (input.estimationBasis === undefined && currentPoints > 0)
  const velocity = usePoints ? completedPoints : completed.length
  const velocities =
    input.state === "closed"
      ? [velocity, ...previousVelocities]
      : previousVelocities
  const rollingVelocity3 =
    velocities.length >= 3 ? average(velocities.slice(0, 3)) : null
  const rollingVelocity5 =
    velocities.length >= 5 ? average(velocities.slice(0, 5)) : null
  const forecastResult = forecast(
    input,
    completedPoints,
    completed.length,
    currentPoints,
    current.length,
    rollingVelocity3,
    startAt,
    endAt,
    cutoffAt
  )
  const quality = calculateDataQuality(input, unestimatedIssueCount)
  const netScopeChangePoints = currentPoints - committedPoints

  return {
    issues: classified,
    analytics: {
      cutoffAt: new Date(cutoffAt).toISOString(),
      committedIssueCount: committed.length,
      committedPoints,
      currentIssueCount: current.length,
      currentPoints,
      completedIssueCount: completed.length,
      completedPoints,
      addedIssueCount: added.length,
      addedPoints,
      removedIssueCount: removed.length,
      removedPoints,
      estimateChange,
      reconstructedScopePoints:
        committedPoints + addedPoints - removedPoints + estimateChange,
      netScopeChangePoints,
      scopeChangePercent: usePoints
        ? ratio(netScopeChangePoints, committedPoints)
        : ratio(current.length - committed.length, committed.length),
      rolledOverIssueCount: rolledOver.length,
      rolledOverPoints,
      completionPercent:
        forecastResult.basis === "Story Points"
          ? ratio(completedPoints, currentPoints)
          : ratio(completed.length, current.length),
      predictabilityPercent:
        forecastResult.basis === "Story Points"
          ? ratio(completedPoints, committedPoints)
          : ratio(completed.length, committed.length),
      velocity,
      rollingVelocity3,
      rollingVelocity5,
      deliveryForecast: forecastResult.label,
      forecastCompletionPercent: forecastResult.completion,
      daysRemaining:
        input.state === "closed"
          ? 0
          : Math.max(0, Math.ceil((endAt - cutoffAt) / DAY_MS)),
      estimationBasis: forecastResult.basis,
      dataQuality: quality.quality,
      dataQualityNotes: quality.notes,
      unestimatedIssueCount,
    },
  }
}

export function calculateSprintAnalytics(
  input: SprintAnalyticsInput
): SprintAnalytics {
  return calculate(input).analytics
}

export type SprintRosterOptions = {
  maxIssuesPerGroup?: number
}

function issueMarkdown(
  item: ClassifiedIssue,
  estimationBasis: "Story Points" | "Issue Count"
): string {
  const key = item.issue.url
    ? `[${item.issue.key}](${item.issue.url})`
    : item.issue.key
  const summary = item.issue.summary.replace(/[\r\n]+/g, " ").trim()
  const estimate =
    estimationBasis === "Issue Count"
      ? "1 issue"
      : item.estimateAtCutoff === null
        ? "unestimated"
        : `${item.pointsAtCutoff} pt${item.pointsAtCutoff === 1 ? "" : "s"}`
  const rollover = item.issue.rollover
    ? ` → ${item.issue.rollover.sprintName}`
    : ""
  return `- ${key} — ${summary} — ${estimate}${rollover}`
}

function rawIssueMarkdown(issue: NormalizedSprintIssueTimeline): string {
  const key = issue.url ? `[${issue.key}](${issue.url})` : issue.key
  const summary = issue.summary.replace(/[\r\n]+/g, " ").trim()
  return `- ${key} — ${summary}`
}

function section(
  title: string,
  items: ClassifiedIssue[],
  maxIssues: number,
  estimationBasis: "Story Points" | "Issue Count"
): string {
  if (items.length === 0) return ""

  const shown = items
    .slice(0, maxIssues)
    .map((item) => issueMarkdown(item, estimationBasis))
  if (items.length > shown.length) {
    shown.push(`- …and ${items.length - shown.length} more`)
  }
  return `## ${title}\n\n${shown.join("\n")}`
}

function rawIssueSection(
  title: string,
  issues: NormalizedSprintIssueTimeline[],
  maxIssues: number
): string {
  if (issues.length === 0) return ""

  const shown = issues.slice(0, maxIssues).map(rawIssueMarkdown)
  if (issues.length > shown.length) {
    shown.push(`- …and ${issues.length - shown.length} more`)
  }
  return `## ${title}\n\n${shown.join("\n")}`
}

export function renderSprintIssueRoster(
  input: SprintAnalyticsInput,
  options: SprintRosterOptions = {}
): string {
  const result = calculate(input)
  const maxIssues = Math.max(1, options.maxIssuesPerGroup ?? 100)
  const issues = result.issues
  const estimationBasis = result.analytics.estimationBasis
  const committed = issues.filter((item) => item.committed)
  const added = issues.filter((item) => !item.committed && item.added)
  const sections = [
    input.goal ? `## Sprint Goal\n\n${input.goal.trim()}` : "",
    section(
      "Committed and completed",
      committed.filter((item) => item.completed),
      maxIssues,
      estimationBasis
    ),
    section(
      "Committed and incomplete",
      committed.filter(
        (item) => !item.completed && !item.removed && !item.rolledOver
      ),
      maxIssues,
      estimationBasis
    ),
    section(
      "Added after start and completed",
      added.filter((item) => item.completed),
      maxIssues,
      estimationBasis
    ),
    section(
      "Added after start and incomplete",
      added.filter(
        (item) => !item.completed && !item.removed && !item.rolledOver
      ),
      maxIssues,
      estimationBasis
    ),
    section(
      "Removed from sprint",
      issues.filter((item) => item.removed),
      maxIssues,
      estimationBasis
    ),
    section(
      "Rolled over",
      issues.filter((item) => item.rolledOver),
      maxIssues,
      estimationBasis
    ),
    rawIssueSection(
      "Subtasks",
      input.issues.filter((issue) => issue.isSubtask),
      maxIssues
    ),
  ].filter(Boolean)

  if (result.analytics.dataQualityNotes.length > 0) {
    sections.push(
      `## Data quality\n\n${result.analytics.dataQualityNotes
        .map((note) => `- ${note}`)
        .join("\n")}`
    )
  }

  return sections.join("\n\n")
}

const STATE_LABELS: Record<SprintAnalyticsState, string> = {
  active: "Active",
  closed: "Closed",
  future: "Future",
}

export function sprintAnalyticsToChange(input: SprintAnalyticsInput) {
  const metrics = calculateSprintAnalytics(input)
  const pointProperties: Record<string, ReturnType<typeof Builder.number>> = {}
  if (metrics.estimationBasis === "Story Points") {
    pointProperties["Committed Points"] = Builder.number(
      metrics.committedPoints
    )
    pointProperties["Current Points"] = Builder.number(metrics.currentPoints)
    pointProperties["Completed Points"] = Builder.number(
      metrics.completedPoints
    )
    pointProperties["Added Points"] = Builder.number(metrics.addedPoints)
    pointProperties["Removed Points"] = Builder.number(metrics.removedPoints)
    pointProperties["Estimate Change"] = Builder.number(metrics.estimateChange)
    pointProperties["Rolled Over Points"] = Builder.number(
      metrics.rolledOverPoints
    )
  }
  return {
    type: "upsert" as const,
    key: input.id,
    upstreamUpdatedAt: input.evaluatedAt,
    pageContentMarkdown: renderSprintIssueRoster(input),
    properties: {
      Name: Builder.title(input.name),
      State: Builder.select(STATE_LABELS[input.state]),
      ...(input.boardName ? { Board: Builder.richText(input.boardName) } : {}),
      ...(input.goal ? { Goal: Builder.richText(input.goal) } : {}),
      "Start Date": Builder.date(dateOnly(input.startAt)),
      "End Date": Builder.date(dateOnly(input.endAt)),
      ...(input.completeAt
        ? { "Complete Date": Builder.date(dateOnly(input.completeAt)) }
        : {}),
      "Committed Issues": Builder.number(metrics.committedIssueCount),
      "Current Issues": Builder.number(metrics.currentIssueCount),
      "Completed Issues": Builder.number(metrics.completedIssueCount),
      "Added Issues": Builder.number(metrics.addedIssueCount),
      "Removed Issues": Builder.number(metrics.removedIssueCount),
      ...pointProperties,
      "Net Scope Change": Builder.number(metrics.netScopeChangePoints),
      ...(metrics.scopeChangePercent != null
        ? { "Scope Change %": Builder.number(metrics.scopeChangePercent) }
        : {}),
      "Rolled Over Issues": Builder.number(metrics.rolledOverIssueCount),
      ...(metrics.completionPercent != null
        ? { "Completion %": Builder.number(metrics.completionPercent) }
        : {}),
      ...(metrics.predictabilityPercent != null
        ? {
            "Predictability %": Builder.number(metrics.predictabilityPercent),
          }
        : {}),
      ...(input.state === "closed"
        ? { Velocity: Builder.number(metrics.velocity) }
        : {}),
      ...(metrics.rollingVelocity3 != null
        ? { "3-Sprint Velocity": Builder.number(metrics.rollingVelocity3) }
        : {}),
      ...(metrics.rollingVelocity5 != null
        ? { "5-Sprint Velocity": Builder.number(metrics.rollingVelocity5) }
        : {}),
      "Delivery Forecast": Builder.select(metrics.deliveryForecast),
      ...(metrics.forecastCompletionPercent != null
        ? {
            "Forecast Completion %": Builder.number(
              metrics.forecastCompletionPercent
            ),
          }
        : {}),
      "Days Remaining": Builder.number(metrics.daysRemaining),
      "Estimation Basis": Builder.select(metrics.estimationBasis),
      "Data Quality": Builder.select(metrics.dataQuality),
      "Unestimated Issues": Builder.number(metrics.unestimatedIssueCount),
      "Metrics Updated": Builder.dateTime(input.evaluatedAt),
      ...(input.boardId ? { "Board ID": Builder.richText(input.boardId) } : {}),
      "Sprint ID": Builder.richText(input.id),
    },
  }
}
