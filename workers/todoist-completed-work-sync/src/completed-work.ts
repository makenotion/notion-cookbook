// Completed Todoist tasks as a durable work journal. Property order is kept
// aligned between the schema and transform for straightforward review.

import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"
import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"

import {
  boundedText,
  dateProperty,
  durationMinutes,
  elapsedDays,
  latestTimestamp,
  optionLabels,
  textWasTruncated,
  todoistTaskUrl,
} from "./helpers.js"
import type { TodoistCompletedTask } from "./todoist.js"

export const INITIAL_TITLE = "Todoist Completed Work"
export const PRIMARY_KEY = "Completion ID"

export const completedWorkSchema = {
  databaseIcon: notionIcon("checkmark-square", "green"),
  properties: {
    Task: Schema.title(),
    Completed: Schema.date(),
    Project: Schema.relation("projects", {
      twoWay: true,
      relatedPropertyName: "Completed Work",
    }),
    Labels: Schema.multiSelect([]),
    "Days to Complete": Schema.number(),
    "Postponed Count": Schema.number(),
    Due: Schema.date(),
    Priority: Schema.select([
      { name: "P1 · Urgent", color: "red" },
      { name: "P2 · High", color: "orange" },
      { name: "P3 · Medium", color: "blue" },
      { name: "P4 · Normal", color: "gray" },
    ]),
    "Planned Duration (min)": Schema.number(),
    Deadline: Schema.date(),
    Description: Schema.richText(),
    "Task Link": Schema.url(),
    Recurring: Schema.checkbox(),
    "Completion Count": Schema.number(),
    "Due Text": Schema.richText(),
    "Is Subtask": Schema.checkbox(),
    Created: Schema.date(),
    Updated: Schema.date(),
    "Description Truncated": Schema.checkbox(),
    "Responsible User ID": Schema.richText(),
    "Completed By User ID": Schema.richText(),
    "Parent Task ID": Schema.richText(),
    "Section ID": Schema.richText(),
    "Todoist Project ID": Schema.richText(),
    "Todoist Task ID": Schema.richText(),
    "Completion ID": Schema.richText(),
  },
} satisfies Schema.Schema<typeof PRIMARY_KEY>

const PRIORITY_LABELS: Record<number, string> = {
  4: "P1 · Urgent",
  3: "P2 · High",
  2: "P3 · Medium",
  1: "P4 · Normal",
}

function normalizedCompletionTimestamp(task: TodoistCompletedTask): string {
  const completedAt = task.completedAt?.trim()
  if (!completedAt || !Number.isFinite(Date.parse(completedAt))) {
    throw new Error(
      `Todoist task ${task.id} has no valid completion timestamp.`
    )
  }
  return new Date(completedAt).toISOString()
}

function completionIdentityTimestamp(task: TodoistCompletedTask): string {
  const normalized = normalizedCompletionTimestamp(task)
  const fraction = task.completedAt
    ?.trim()
    .match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/iu)?.[1]
  const subMilliseconds = fraction?.slice(3).replace(/0+$/u, "") ?? ""
  return subMilliseconds
    ? normalized.replace(/Z$/u, `${subMilliseconds}Z`)
    : normalized
}

/** Stable identity for one completion occurrence, including recurring work. */
export function completionId(task: TodoistCompletedTask): string {
  const taskId = task.id.trim()
  if (!taskId) throw new Error("Todoist completed task has an empty task ID.")
  return `todoist:${taskId}:completed:${completionIdentityTimestamp(task)}`
}

export function completedTaskToChange(
  task: TodoistCompletedTask,
  userTimeZone?: string
): SyncChangeUpsert<typeof PRIMARY_KEY, typeof completedWorkSchema.properties> {
  if (task.isDeleted) {
    throw new Error(
      "Deleted Todoist tasks are not valid completed-work upserts."
    )
  }
  const completedAtUtc = normalizedCompletionTimestamp(task)
  const occurrenceId = completionId(task)

  const title = boundedText(task.content) ?? task.id
  const description = boundedText(task.description)
  const labels = optionLabels("labels", task.labels)
  const priority = PRIORITY_LABELS[task.priority]
  const plannedMinutes = durationMinutes(task.duration)
  const recurring = task.due?.isRecurring ?? false
  const daysToComplete = recurring
    ? null
    : elapsedDays(task.addedAt, completedAtUtc)

  return {
    type: "upsert",
    key: occurrenceId,
    upstreamUpdatedAt:
      latestTimestamp(task.updatedAt, completedAtUtc) ?? completedAtUtc,
    icon: Builder.notionIcon("checkmark", "green"),
    // Intentionally no pageContentMarkdown: users can own the page body and
    // add properties without a later provider upsert overwriting either.
    properties: {
      Task: Builder.title(title),
      Completed: Builder.dateTime(completedAtUtc, "UTC"),
      Project: [Builder.relation(task.projectId)],
      Labels: labels.length > 0 ? Builder.multiSelect(...labels) : [],
      "Days to Complete":
        daysToComplete !== null ? Builder.number(daysToComplete) : [],
      "Postponed Count": Builder.number(task.postponedCount),
      Due: dateProperty(
        task.due?.date,
        `task ${task.id} due`,
        task.due?.timeZone ?? userTimeZone
      ),
      Priority: priority ? Builder.select(priority) : [],
      "Planned Duration (min)":
        plannedMinutes !== null ? Builder.number(plannedMinutes) : [],
      Deadline: dateProperty(task.deadline, `task ${task.id} deadline`),
      Description: description ? Builder.richText(description) : [],
      "Task Link": Builder.url(todoistTaskUrl(task.id)),
      Recurring: Builder.checkbox(recurring),
      "Completion Count": Builder.number(task.completedCount),
      "Due Text": task.due?.string
        ? Builder.richText(boundedText(task.due.string) ?? "")
        : [],
      "Is Subtask": Builder.checkbox(Boolean(task.parentId)),
      Created: dateProperty(task.addedAt, `task ${task.id} created`),
      Updated: dateProperty(task.updatedAt, `task ${task.id} updated`),
      "Description Truncated": Builder.checkbox(
        textWasTruncated(task.description)
      ),
      "Responsible User ID": task.responsibleUserId
        ? Builder.richText(task.responsibleUserId)
        : [],
      "Completed By User ID": task.completedByUserId
        ? Builder.richText(task.completedByUserId)
        : [],
      "Parent Task ID": task.parentId ? Builder.richText(task.parentId) : [],
      "Section ID": task.sectionId ? Builder.richText(task.sectionId) : [],
      "Todoist Project ID": Builder.richText(task.projectId),
      "Todoist Task ID": Builder.richText(task.id),
      "Completion ID": Builder.richText(occurrenceId),
    },
  }
}

/** Keep the freshest snapshot when a live cursor page repeats one occurrence. */
export function dedupeCompletedTasks(
  tasks: ReadonlyArray<TodoistCompletedTask>
): TodoistCompletedTask[] {
  const byId = new Map<string, TodoistCompletedTask>()
  for (const task of tasks) {
    const identity = completionId(task)
    const previous = byId.get(identity)
    const previousTime = latestTimestamp(
      previous?.updatedAt,
      previous?.completedAt
    )
    const candidateTime = latestTimestamp(task.updatedAt, task.completedAt)
    if (
      !previous ||
      (candidateTime &&
        (!previousTime ||
          Date.parse(candidateTime) >= Date.parse(previousTime)))
    ) {
      byId.set(identity, task)
    }
  }
  return [...byId.values()]
}
