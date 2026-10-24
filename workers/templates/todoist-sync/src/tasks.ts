// All open Todoist tasks as a current, read-only operational view in Notion.

import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"
import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"

import {
  boundedText,
  classifyDue,
  dateProperty,
  durationMinutes,
  optionLabels,
  todoistTaskUrl,
} from "./helpers.js"
import type { TodoistTask } from "./todoist.js"

export const INITIAL_TITLE = "Todoist Tasks"
export const PRIMARY_KEY = "Todoist Task ID"

export const taskSchema = {
  databaseIcon: notionIcon("checkmark-square", "red"),
  properties: {
    Task: Schema.title(),
    "Due Status": Schema.select([
      { name: "Overdue", color: "red" },
      { name: "Today", color: "orange" },
      { name: "Next 7 days", color: "blue" },
      { name: "Later", color: "gray" },
      { name: "No due date", color: "default" },
    ]),
    Due: Schema.date(),
    Project: Schema.relation("projects", {
      twoWay: true,
      relatedPropertyName: "Tasks",
    }),
    Priority: Schema.select([
      { name: "P1 · Urgent", color: "red" },
      { name: "P2 · High", color: "orange" },
      { name: "P3 · Medium", color: "blue" },
      { name: "P4 · Normal", color: "gray" },
    ]),
    Labels: Schema.multiSelect([]),
    Deadline: Schema.date(),
    "Planned Duration (min)": Schema.number(),
    "Open in Todoist": Schema.url(),
    Description: Schema.richText(),
    Recurring: Schema.checkbox(),
    "Is Subtask": Schema.checkbox(),
    Created: Schema.date(),
    Updated: Schema.date(),
    "Todoist Task ID": Schema.richText(),
  },
} satisfies Schema.Schema<typeof PRIMARY_KEY>

const PRIORITY_LABELS: Record<number, string> = {
  4: "P1 · Urgent",
  3: "P2 · High",
  2: "P3 · Medium",
  1: "P4 · Normal",
}

export function taskToChange(
  task: TodoistTask,
  userTimeZone: string,
  observedAt: Date | string
): SyncChangeUpsert<typeof PRIMARY_KEY, typeof taskSchema.properties> {
  const title = boundedText(task.content) ?? task.id
  const description = boundedText(task.description)
  const labels = optionLabels("labels", task.labels)
  const priority = PRIORITY_LABELS[task.priority]
  const plannedMinutes = durationMinutes(task.duration)
  const due = classifyDue(task.due, userTimeZone, observedAt)

  return {
    type: "upsert",
    key: task.id,
    // Due Status changes as time passes even when Todoist does not edit the
    // task, so every snapshot is versioned by its pinned observation time.
    upstreamUpdatedAt: new Date(observedAt).toISOString(),
    icon: Builder.notionIcon("checkmark-square", "red"),
    properties: {
      Task: Builder.title(title),
      "Due Status": Builder.select(due.status),
      Due: dateProperty(task.due?.date, `task ${task.id} due`, userTimeZone),
      Project: [Builder.relation(task.projectId)],
      Priority: priority ? Builder.select(priority) : [],
      Labels: labels.length > 0 ? Builder.multiSelect(...labels) : [],
      Deadline: dateProperty(task.deadline, `task ${task.id} deadline`),
      "Planned Duration (min)":
        plannedMinutes === null ? [] : Builder.number(plannedMinutes),
      "Open in Todoist": Builder.url(todoistTaskUrl(task.id)),
      Description: description ? Builder.richText(description) : [],
      Recurring: Builder.checkbox(task.due?.isRecurring ?? false),
      "Is Subtask": Builder.checkbox(Boolean(task.parentId)),
      Created: dateProperty(
        task.addedAt,
        `task ${task.id} created`,
        userTimeZone
      ),
      Updated: dateProperty(
        task.updatedAt,
        `task ${task.id} updated`,
        userTimeZone
      ),
      "Todoist Task ID": Builder.richText(task.id),
    },
  }
}
