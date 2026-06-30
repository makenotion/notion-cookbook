// Linear initiatives — leadership-level goals above individual projects.
// Keep the schema and transform property order in sync.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"

import type { LinearInitiative } from "./linear.js"
import {
  dateOnly,
  dateTime,
  formatLinearLabel,
  healthLabel,
  longFormContent,
  personDisplay,
  resourcePageContent,
  uniqueVisibleProjects,
} from "./helpers.js"

export const INITIAL_TITLE = "Linear Initiatives"
export const PRIMARY_KEY = "Linear Initiative ID"

export const initiativeSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  databaseIcon: notionIcon("trophy"),
  properties: {
    Name: Schema.title(),

    Status: Schema.select([
      { name: "Proposed" },
      { name: "Planned" },
      { name: "Active" },
      { name: "Completed" },
      { name: "Canceled" },
    ]),

    Health: Schema.select([
      { name: "On Track" },
      { name: "At Risk" },
      { name: "Off Track" },
    ]),

    Owner: Schema.richText(),

    "Initiative Link": Schema.url(),

    "Project Count": Schema.number(),

    "Target Date": Schema.date(),

    "Last Update At": Schema.date(),

    "Last Update Link": Schema.url(),

    Updated: Schema.date(),

    Started: Schema.date(),

    Completed: Schema.date(),

    Created: Schema.date(),

    Archived: Schema.checkbox(),

    "Slug ID": Schema.richText(),

    "Linear Initiative ID": Schema.richText(),
  },
}

export function initiativeToChange(initiative: LinearInitiative) {
  const rawStatus = initiative.status?.trim()
  const status = rawStatus ? formatLinearLabel(rawStatus) : null
  const health = healthLabel(initiative.health)
  const owner = personDisplay(initiative.owner)
  const url = initiative.url?.trim()
  const updated = dateTime(initiative.updatedAt)
  const lastUpdateAt = dateTime(initiative.lastUpdate?.updatedAt)
  const lastUpdateLink = initiative.lastUpdate?.url?.trim()
  const projects = uniqueVisibleProjects(initiative.projects.nodes)
  const targetDate = dateOnly(initiative.targetDate)
  const started = dateTime(initiative.startedAt)
  const completed = dateTime(initiative.completedAt)
  const created = dateTime(initiative.createdAt)
  const slugId = initiative.slugId?.trim()

  return {
    type: "upsert" as const,
    key: initiative.id,
    // This row includes a derived project set. Association removals can make a
    // max-child timestamp move backward, so the hourly replacement deliberately
    // refreshes Initiatives instead of supplying an unsafe freshness watermark.
    pageContentMarkdown: resourcePageContent({
      overview: longFormContent(initiative.content, initiative.description),
      overviewHeading: "Initiative overview",
      resourceUrl: url ?? "",
      latestUpdate: initiative.lastUpdate,
      contributingProjects: projects,
    }),
    properties: {
      Name: Builder.title(initiative.name),
      ...(status ? { Status: Builder.select(status) } : {}),
      ...(health ? { Health: Builder.select(health) } : {}),
      ...(owner ? { Owner: Builder.richText(owner) } : {}),
      ...(url ? { "Initiative Link": Builder.url(url) } : {}),
      "Project Count": Builder.number(projects.length),
      ...(targetDate ? { "Target Date": Builder.date(targetDate) } : {}),
      ...(lastUpdateAt
        ? { "Last Update At": Builder.dateTime(lastUpdateAt) }
        : {}),
      ...(lastUpdateLink
        ? { "Last Update Link": Builder.url(lastUpdateLink) }
        : {}),
      ...(updated ? { Updated: Builder.dateTime(updated) } : {}),
      ...(started ? { Started: Builder.dateTime(started) } : {}),
      ...(completed ? { Completed: Builder.dateTime(completed) } : {}),
      ...(created ? { Created: Builder.dateTime(created) } : {}),
      Archived: Builder.checkbox(Boolean(initiative.archivedAt)),
      ...(slugId ? { "Slug ID": Builder.richText(slugId) } : {}),
      "Linear Initiative ID": Builder.richText(initiative.id),
    },
  }
}
