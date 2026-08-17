// Linear issues — the core engineering work visible to cross-functional teams.
// Keep the schema and transform property order in sync.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"

import type { LinearIssue } from "./linear.js"
import {
  cycleDisplay,
  dateOnly,
  dateTime,
  personDisplay,
  priorityLabel,
  workflowCategoryLabel,
} from "./helpers.js"

export const INITIAL_TITLE = "Linear Issues"
export const PRIMARY_KEY = "Linear Issue ID"

export const issueSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  databaseIcon: notionIcon("checkmark-square"),
  properties: {
    Title: Schema.title(),

    "Issue Key": Schema.richText(),

    // Workflow names are workspace-defined, so options are created dynamically.
    Status: Schema.select([]),

    Priority: Schema.select([
      { name: "No Priority" },
      { name: "Urgent" },
      { name: "High" },
      { name: "Medium" },
      { name: "Low" },
    ]),

    Assignee: Schema.richText(),

    "Issue Link": Schema.url(),

    Updated: Schema.date(),

    "Workflow Category": Schema.select([
      { name: "Triage" },
      { name: "Backlog" },
      { name: "Unstarted" },
      { name: "Started" },
      { name: "Completed" },
      { name: "Canceled" },
    ]),

    Team: Schema.select([]),

    Project: Schema.select([]),

    Cycle: Schema.select([]),

    // Labels are also workspace-defined.
    Labels: Schema.multiSelect([]),

    Estimate: Schema.number(),

    "Due Date": Schema.date(),

    Started: Schema.date(),

    Completed: Schema.date(),

    Canceled: Schema.date(),

    Created: Schema.date(),

    Archived: Schema.checkbox(),

    "Linear Issue ID": Schema.richText(),
  },
}

export function issueToChange(issue: LinearIssue) {
  const status = issue.state?.name?.trim()
  const workflowCategory = workflowCategoryLabel(issue.state?.type)
  const priority = priorityLabel(issue.priority, issue.priorityLabel)
  const assignee = personDisplay(issue.assignee)
  const url = issue.url?.trim()
  const updated = dateTime(issue.updatedAt)
  const team = issue.team?.name?.trim() || issue.team?.key?.trim()
  const project = issue.project?.name?.trim()
  const cycle = cycleDisplay(issue.cycle)
  const labels = [
    ...new Set(
      issue.labels.nodes
        .map((label) => label.name.trim())
        .filter((name) => name.length > 0)
    ),
  ]
  const dueDate = dateOnly(issue.dueDate)
  const started = dateTime(issue.startedAt)
  const completed = dateTime(issue.completedAt)
  const canceled = dateTime(issue.canceledAt)
  const created = dateTime(issue.createdAt)
  const identifier = issue.identifier?.trim()

  return {
    type: "upsert" as const,
    key: issue.id,
    upstreamUpdatedAt: issue.updatedAt,
    pageContentMarkdown: issue.description ?? "",
    properties: {
      Title: Builder.title(issue.title),
      ...(identifier ? { "Issue Key": Builder.richText(identifier) } : {}),
      ...(status ? { Status: Builder.select(status) } : {}),
      ...(priority ? { Priority: Builder.select(priority) } : {}),
      ...(assignee ? { Assignee: Builder.richText(assignee) } : {}),
      ...(url ? { "Issue Link": Builder.url(url) } : {}),
      ...(updated ? { Updated: Builder.dateTime(updated) } : {}),
      ...(workflowCategory
        ? { "Workflow Category": Builder.select(workflowCategory) }
        : {}),
      ...(team ? { Team: Builder.select(team) } : {}),
      ...(project ? { Project: Builder.select(project) } : {}),
      ...(cycle ? { Cycle: Builder.select(cycle) } : {}),
      ...(labels.length > 0 ? { Labels: Builder.multiSelect(...labels) } : {}),
      ...(issue.estimate != null && Number.isFinite(issue.estimate)
        ? { Estimate: Builder.number(issue.estimate) }
        : {}),
      ...(dueDate ? { "Due Date": Builder.date(dueDate) } : {}),
      ...(started ? { Started: Builder.dateTime(started) } : {}),
      ...(completed ? { Completed: Builder.dateTime(completed) } : {}),
      ...(canceled ? { Canceled: Builder.dateTime(canceled) } : {}),
      ...(created ? { Created: Builder.dateTime(created) } : {}),
      Archived: Builder.checkbox(Boolean(issue.archivedAt)),
      "Linear Issue ID": Builder.richText(issue.id),
    },
  }
}

/** Incremental polling can observe soft-deleted issues before reconciliation. */
export function issueToSyncChange(issue: LinearIssue) {
  return issue.trashed
    ? { type: "delete" as const, key: issue.id }
    : issueToChange(issue)
}
