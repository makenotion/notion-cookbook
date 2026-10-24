// Linear projects — the strategic delivery view for PMs and stakeholders.
// Keep the schema and transform property order in sync.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"

import type { LinearProject } from "./linear.js"
import {
  dateOnly,
  dateTime,
  healthLabel,
  latestTimestamp,
  longFormContent,
  personDisplay,
  priorityLabel,
  projectStatusLabel,
  resourcePageContent,
} from "./helpers.js"

export const INITIAL_TITLE = "Linear Projects"
export const PRIMARY_KEY = "Linear Project ID"

export const projectSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  databaseIcon: notionIcon("target"),
  properties: {
    Name: Schema.title(),

    // Project status names are workspace-defined.
    Status: Schema.select([]),

    Health: Schema.select([
      { name: "On Track" },
      { name: "At Risk" },
      { name: "Off Track" },
    ]),

    Lead: Schema.richText(),

    "Project Link": Schema.url(),

    "Progress %": Schema.number(),

    "Target Date": Schema.date(),

    Updated: Schema.date(),

    "Last Update At": Schema.date(),

    "Last Update Link": Schema.url(),

    "Status Category": Schema.select([
      { name: "Backlog" },
      { name: "Planned" },
      { name: "Started" },
      { name: "Paused" },
      { name: "Completed" },
      { name: "Canceled" },
    ]),

    Priority: Schema.select([
      { name: "No Priority" },
      { name: "Urgent" },
      { name: "High" },
      { name: "Medium" },
      { name: "Low" },
    ]),

    "Start Date": Schema.date(),

    Started: Schema.date(),

    Completed: Schema.date(),

    Canceled: Schema.date(),

    Created: Schema.date(),

    Archived: Schema.checkbox(),

    "Slug ID": Schema.richText(),

    "Linear Project ID": Schema.richText(),
  },
}

function progressPercent(progress: number | null | undefined): number | null {
  if (progress == null || !Number.isFinite(progress)) return null
  return Math.min(100, Math.max(0, progress * 100))
}

export function projectToChange(project: LinearProject) {
  const status = project.status?.name?.trim()
  const statusCategory = projectStatusLabel(project.status?.type)
  const health = healthLabel(project.health)
  const lead = personDisplay(project.lead)
  const url = project.url?.trim()
  const updated = dateTime(project.updatedAt)
  const lastUpdateAt = dateTime(project.lastUpdate?.updatedAt)
  const lastUpdateLink = project.lastUpdate?.url?.trim()
  const priority = priorityLabel(project.priority, project.priorityLabel)
  const progress = progressPercent(project.progress)
  const startDate = dateOnly(project.startDate)
  const targetDate = dateOnly(project.targetDate)
  const started = dateTime(project.startedAt)
  const completed = dateTime(project.completedAt)
  const canceled = dateTime(project.canceledAt)
  const created = dateTime(project.createdAt)
  const slugId = project.slugId?.trim()
  const upstreamUpdatedAt = latestTimestamp(
    project.updatedAt,
    project.lastUpdate?.updatedAt
  )

  return {
    type: "upsert" as const,
    key: project.id,
    upstreamUpdatedAt,
    pageContentMarkdown: resourcePageContent({
      overview: longFormContent(project.content, project.description),
      overviewHeading: "Project overview",
      resourceUrl: url ?? "",
      latestUpdate: project.lastUpdate,
    }),
    properties: {
      Name: Builder.title(project.name),
      ...(status ? { Status: Builder.select(status) } : {}),
      ...(health ? { Health: Builder.select(health) } : {}),
      ...(lead ? { Lead: Builder.richText(lead) } : {}),
      ...(url ? { "Project Link": Builder.url(url) } : {}),
      ...(progress != null ? { "Progress %": Builder.number(progress) } : {}),
      ...(targetDate ? { "Target Date": Builder.date(targetDate) } : {}),
      ...(updated ? { Updated: Builder.dateTime(updated) } : {}),
      ...(lastUpdateAt
        ? { "Last Update At": Builder.dateTime(lastUpdateAt) }
        : {}),
      ...(lastUpdateLink
        ? { "Last Update Link": Builder.url(lastUpdateLink) }
        : {}),
      ...(statusCategory
        ? { "Status Category": Builder.select(statusCategory) }
        : {}),
      ...(priority ? { Priority: Builder.select(priority) } : {}),
      ...(startDate ? { "Start Date": Builder.date(startDate) } : {}),
      ...(started ? { Started: Builder.dateTime(started) } : {}),
      ...(completed ? { Completed: Builder.dateTime(completed) } : {}),
      ...(canceled ? { Canceled: Builder.dateTime(canceled) } : {}),
      ...(created ? { Created: Builder.dateTime(created) } : {}),
      Archived: Builder.checkbox(Boolean(project.archivedAt)),
      ...(slugId ? { "Slug ID": Builder.richText(slugId) } : {}),
      "Linear Project ID": Builder.richText(project.id),
    },
  }
}
