// Active Todoist projects enriched with compact, explainable task and recent
// completion summaries for project review in Notion.

import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"
import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"

import {
  boundedText,
  classifyDue,
  dateProperty,
  durationMinutes,
  todoistProjectUrl,
} from "./helpers.js"
import type {
  TodoistCompletedTask,
  TodoistProject,
  TodoistTask,
} from "./todoist.js"

export const INITIAL_TITLE = "Todoist Projects"
export const PRIMARY_KEY = "Todoist Project ID"
export const MAX_RECENT_COMPLETIONS = 5
export const MAX_RECENT_COMPLETION_TITLE_CHARACTERS = 120

export type RecentCompletion = {
  occurrenceId: string
  title: string
  completedAt: string
}

export type NextDue = {
  date: string
  sortKey: string
}

export type ProjectAggregate = {
  projectId: string
  openTasks: number
  overdue: number
  dueNextSevenDays: number
  completedLastSevenDays: number
  recentCompletions: RecentCompletion[]
  nextDue: NextDue | null
  nextDeadline: string | null
  unscheduled: number
  p1Tasks: number
  plannedMinutesNextSevenDays: number
  lastCompleted: string | null
}

export type ProjectAggregateMap = Record<string, ProjectAggregate>

export const projectSchema = {
  databaseIcon: notionIcon("folder", "red"),
  properties: {
    Project: Schema.title(),
    "Open Tasks": Schema.number(),
    Overdue: Schema.number(),
    "Due Next 7 Days": Schema.number(),
    "Completed Last 7 Days": Schema.number(),
    "Recent Completions": Schema.richText(),
    "Next Deadline": Schema.date(),
    "Next Due": Schema.date(),
    Unscheduled: Schema.number(),
    "P1 Tasks": Schema.number(),
    "Planned Minutes Next 7 Days": Schema.number(),
    "Last Completed": Schema.date(),
    Description: Schema.richText(),
    "Open in Todoist": Schema.url(),
    Updated: Schema.date(),
    "Todoist Project ID": Schema.richText(),
  },
} satisfies Schema.Schema<typeof PRIMARY_KEY>

function aggregateFor(
  aggregates: ProjectAggregateMap,
  projectId: string
): ProjectAggregate {
  const existing = aggregates[projectId]
  if (existing) return existing
  const aggregate: ProjectAggregate = {
    projectId,
    openTasks: 0,
    overdue: 0,
    dueNextSevenDays: 0,
    completedLastSevenDays: 0,
    recentCompletions: [],
    nextDue: null,
    nextDeadline: null,
    unscheduled: 0,
    p1Tasks: 0,
    plannedMinutesNextSevenDays: 0,
    lastCompleted: null,
  }
  aggregates[projectId] = aggregate
  return aggregate
}

export function aggregateTasks(
  prior: ProjectAggregateMap,
  tasks: ReadonlyArray<TodoistTask>,
  userTimeZone: string,
  observedAt: Date | string
): ProjectAggregateMap {
  const aggregates = structuredClone(prior)

  for (const task of tasks) {
    const aggregate = aggregateFor(aggregates, task.projectId)
    const due = classifyDue(task.due, userTimeZone, observedAt)
    aggregate.openTasks += 1
    if (due.status === "Overdue") aggregate.overdue += 1
    if (due.status === "No due date") aggregate.unscheduled += 1
    if (due.dueNextSevenDays) {
      aggregate.dueNextSevenDays += 1
      aggregate.plannedMinutesNextSevenDays +=
        durationMinutes(task.duration) ?? 0
    }
    if (task.priority === 4) aggregate.p1Tasks += 1

    if (
      task.due?.date &&
      due.sortKey &&
      due.status !== "Overdue" &&
      (!aggregate.nextDue || due.sortKey < aggregate.nextDue.sortKey)
    ) {
      aggregate.nextDue = {
        date: task.due.date,
        sortKey: due.sortKey,
      }
    }
    if (
      task.deadline &&
      (!aggregate.nextDeadline || task.deadline < aggregate.nextDeadline)
    ) {
      aggregate.nextDeadline = task.deadline
    }
  }

  return aggregates
}

export function completionOccurrenceId(task: TodoistCompletedTask): string {
  return `${task.id}:${task.completedAt}`
}

export function aggregateCompletions(
  prior: ProjectAggregateMap,
  tasks: ReadonlyArray<TodoistCompletedTask>,
  since: Date | string,
  until: Date | string
): ProjectAggregateMap {
  const sinceMs = new Date(since).getTime()
  const untilMs = new Date(until).getTime()
  if (
    !Number.isFinite(sinceMs) ||
    !Number.isFinite(untilMs) ||
    sinceMs >= untilMs
  ) {
    throw new Error("Todoist completion aggregation has invalid bounds.")
  }
  const aggregates = structuredClone(prior)

  for (const task of tasks) {
    const completedAtMs = Date.parse(task.completedAt)
    if (
      !Number.isFinite(completedAtMs) ||
      completedAtMs < sinceMs ||
      completedAtMs >= untilMs
    ) {
      throw new Error(
        `Todoist completion ${task.id} falls outside the requested window.`
      )
    }
    if (task.isDeleted) continue
    const aggregate = aggregateFor(aggregates, task.projectId)
    const occurrenceId = completionOccurrenceId(task)
    aggregate.completedLastSevenDays += 1
    if (
      !aggregate.lastCompleted ||
      completedAtMs > Date.parse(aggregate.lastCompleted)
    ) {
      aggregate.lastCompleted = task.completedAt
    }

    aggregate.recentCompletions.push({
      occurrenceId,
      title:
        boundedText(task.content, MAX_RECENT_COMPLETION_TITLE_CHARACTERS) ??
        task.id,
      completedAt: task.completedAt,
    })
    aggregate.recentCompletions.sort(
      (left, right) =>
        Date.parse(right.completedAt) - Date.parse(left.completedAt) ||
        left.occurrenceId.localeCompare(right.occurrenceId)
    )
    aggregate.recentCompletions = aggregate.recentCompletions.slice(
      0,
      MAX_RECENT_COMPLETIONS
    )
  }

  return aggregates
}

function recentCompletionSummary(aggregate: ProjectAggregate): string | null {
  const visible = aggregate.recentCompletions.map((item) => item.title)
  const remaining = Math.max(
    0,
    aggregate.completedLastSevenDays - visible.length
  )
  if (remaining > 0) visible.push(`+${remaining} more`)
  return boundedText(visible.join(" · "))
}

export function projectToChange(
  project: TodoistProject,
  aggregate: ProjectAggregate | undefined,
  observedAt: Date | string,
  userTimeZone: string
): SyncChangeUpsert<typeof PRIMARY_KEY, typeof projectSchema.properties> {
  const summary = aggregate ?? aggregateFor({}, project.id)
  const recent = recentCompletionSummary(summary)
  const description = boundedText(project.description)

  return {
    type: "upsert",
    key: project.id,
    upstreamUpdatedAt: new Date(observedAt).toISOString(),
    icon: Builder.notionIcon("folder", "red"),
    properties: {
      Project: Builder.title(boundedText(project.name) ?? project.id),
      "Open Tasks": Builder.number(summary.openTasks),
      Overdue: Builder.number(summary.overdue),
      "Due Next 7 Days": Builder.number(summary.dueNextSevenDays),
      "Completed Last 7 Days": Builder.number(summary.completedLastSevenDays),
      "Recent Completions": recent ? Builder.richText(recent) : [],
      "Next Deadline": dateProperty(
        summary.nextDeadline,
        `project ${project.id} next deadline`
      ),
      "Next Due": dateProperty(
        summary.nextDue?.date,
        `project ${project.id} next due`,
        userTimeZone
      ),
      Unscheduled: Builder.number(summary.unscheduled),
      "P1 Tasks": Builder.number(summary.p1Tasks),
      "Planned Minutes Next 7 Days": Builder.number(
        summary.plannedMinutesNextSevenDays
      ),
      "Last Completed": dateProperty(
        summary.lastCompleted,
        `project ${project.id} last completed`,
        userTimeZone
      ),
      Description: description ? Builder.richText(description) : [],
      "Open in Todoist": Builder.url(todoistProjectUrl(project.id)),
      Updated: dateProperty(
        project.updatedAt,
        `project ${project.id} updated`,
        userTimeZone
      ),
      "Todoist Project ID": Builder.richText(project.id),
    },
  }
}
