import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"
import type { IssueFieldConfig, JiraIssue } from "./jira.js"
import {
  browseUrl,
  extractTextFromAdf,
  getEpicName,
  getSprintName,
  getStoryPoints,
} from "./jira.js"
import { dateOnly } from "./helpers.js"

export const INITIAL_TITLE = "Jira Issues"
export const PRIMARY_KEY = "Jira Issue ID"

export const issueSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  databaseIcon: notionIcon("bug"),
  properties: {
    Summary: Schema.title(),

    Status: Schema.select([
      { name: "To Do" },
      { name: "In Progress" },
      { name: "In Review" },
      { name: "Done" },
    ]),

    "Issue Type": Schema.select([
      { name: "Bug" },
      { name: "Story" },
      { name: "Task" },
      { name: "Epic" },
      { name: "Sub-task" },
    ]),

    Assignee: Schema.richText(),

    Sprint: Schema.richText(),

    Updated: Schema.date(),

    "Status Category": Schema.select([
      { name: "To Do" },
      { name: "In Progress" },
      { name: "Done" },
    ]),

    Priority: Schema.select([
      { name: "Highest" },
      { name: "High" },
      { name: "Medium" },
      { name: "Low" },
      { name: "Lowest" },
    ]),

    Reporter: Schema.richText(),

    Project: Schema.richText(),

    "Issue Link": Schema.url(),

    Labels: Schema.multiSelect([]),

    Components: Schema.multiSelect([]),

    "Fix Versions": Schema.multiSelect([]),

    Resolution: Schema.select([]),

    "Due Date": Schema.date(),

    Epic: Schema.richText(),

    "Story Points": Schema.number(),

    Created: Schema.date(),

    "Issue Key": Schema.richText(),

    "Jira Issue ID": Schema.richText(),
  },
}

export function issueToChange(
  issue: JiraIssue,
  baseUrl: string,
  fieldConfig: IssueFieldConfig
) {
  const f = issue.fields
  const storyPoints = getStoryPoints(issue, fieldConfig)
  const epicName = getEpicName(issue, fieldConfig)
  const sprintName = getSprintName(issue, fieldConfig)
  const statusCategory = f.status?.statusCategory?.name ?? null

  return {
    type: "upsert" as const,
    key: issue.id,
    upstreamUpdatedAt: f.updated,
    pageContentMarkdown: extractTextFromAdf(f.description),
    properties: {
      Summary: Builder.title(f.summary ?? ""),
      ...(f.status ? { Status: Builder.select(f.status.name) } : {}),
      ...(f.issuetype
        ? { "Issue Type": Builder.select(f.issuetype.name) }
        : {}),
      ...(f.assignee
        ? { Assignee: Builder.richText(f.assignee.displayName) }
        : {}),
      ...(sprintName ? { Sprint: Builder.richText(sprintName) } : {}),
      Updated: Builder.date(dateOnly(f.updated)),
      ...(statusCategory
        ? { "Status Category": Builder.select(statusCategory) }
        : {}),
      ...(f.priority ? { Priority: Builder.select(f.priority.name) } : {}),
      ...(f.reporter
        ? { Reporter: Builder.richText(f.reporter.displayName) }
        : {}),
      ...(f.project ? { Project: Builder.richText(f.project.name) } : {}),
      "Issue Link": Builder.url(browseUrl(baseUrl, issue.key)),
      ...(f.labels.length > 0
        ? { Labels: Builder.multiSelect(...f.labels) }
        : {}),
      ...(f.components.length > 0
        ? {
            Components: Builder.multiSelect(...f.components.map((c) => c.name)),
          }
        : {}),
      ...(f.fixVersions.length > 0
        ? {
            "Fix Versions": Builder.multiSelect(
              ...f.fixVersions.map((v) => v.name)
            ),
          }
        : {}),
      ...(f.resolution
        ? { Resolution: Builder.select(f.resolution.name) }
        : {}),
      ...(f.duedate ? { "Due Date": Builder.date(dateOnly(f.duedate)) } : {}),
      ...(epicName ? { Epic: Builder.richText(epicName) } : {}),
      ...(storyPoints != null
        ? { "Story Points": Builder.number(storyPoints) }
        : {}),
      Created: Builder.date(dateOnly(f.created)),
      "Issue Key": Builder.richText(issue.key),
      "Jira Issue ID": Builder.richText(issue.id),
    },
  }
}
