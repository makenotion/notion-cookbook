import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"
import type { JiraProject } from "./jira.js"
import { browseUrl } from "./jira.js"

export const INITIAL_TITLE = "Jira Projects"
export const PRIMARY_KEY = "Jira Project ID"

export const projectSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  databaseIcon: notionIcon("folder"),
  properties: {
    Name: Schema.title(),

    "Project Key": Schema.richText(),

    Lead: Schema.richText(),

    Category: Schema.select([]),

    "Project Type": Schema.select([
      { name: "Software" },
      { name: "Business" },
      { name: "Service Desk" },
    ]),

    "Project Link": Schema.url(),

    "Jira Project ID": Schema.richText(),
  },
}

const TYPE_LABELS: Record<string, string> = {
  software: "Software",
  business: "Business",
  service_desk: "Service Desk",
}

export function projectToChange(project: JiraProject, baseUrl: string) {
  const projectType =
    TYPE_LABELS[project.projectTypeKey] ?? project.projectTypeKey

  return {
    type: "upsert" as const,
    key: project.id,
    pageContentMarkdown: project.description ?? "",
    properties: {
      Name: Builder.title(project.name),
      "Project Key": Builder.richText(project.key),
      ...(project.lead
        ? { Lead: Builder.richText(project.lead.displayName) }
        : {}),
      ...(project.projectCategory
        ? { Category: Builder.select(project.projectCategory.name) }
        : {}),
      "Project Type": Builder.select(projectType),
      "Project Link": Builder.url(browseUrl(baseUrl, project.key)),
      "Jira Project ID": Builder.richText(project.id),
    },
  }
}
