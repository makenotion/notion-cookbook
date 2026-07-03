// Last-known active and archived Todoist projects. The project sync is
// intentionally incremental so deleted projects do not erase user enrichment
// or historical task context in Notion.

import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"
import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"

import {
  boundedText,
  dateProperty,
  humanize,
  optionLabel,
  textWasTruncated,
} from "./helpers.js"
import type { TodoistProject, TodoistProjectCollection } from "./todoist.js"

export const INITIAL_TITLE = "Todoist Projects"
export const PRIMARY_KEY = "Todoist Project ID"

export const projectSchema = {
  databaseIcon: notionIcon("folder"),
  properties: {
    Project: Schema.title(),
    State: Schema.select([
      { name: "Active", color: "green" },
      { name: "Archived", color: "gray" },
    ]),
    Kind: Schema.select([{ name: "Personal" }, { name: "Workspace" }]),
    "Workspace Status": Schema.select([]),
    Color: Schema.select([]),
    Favorite: Schema.checkbox(),
    Shared: Schema.checkbox(),
    Inbox: Schema.checkbox(),
    View: Schema.select([]),
    Role: Schema.select([]),
    Description: Schema.richText(),
    "Description Truncated": Schema.checkbox(),
    Created: Schema.date(),
    Updated: Schema.date(),
    "Workspace ID": Schema.richText(),
    "Parent Project ID": Schema.richText(),
    "Todoist Project ID": Schema.richText(),
  },
} satisfies Schema.Schema<typeof PRIMARY_KEY>

export function projectToChange(
  project: TodoistProject,
  collection: TodoistProjectCollection
): SyncChangeUpsert<typeof PRIMARY_KEY, typeof projectSchema.properties> {
  if (project.isDeleted) {
    throw new Error("Deleted Todoist projects are not valid project upserts.")
  }
  const name = boundedText(project.name) ?? project.id
  const color = optionLabel(humanize(project.color))
  const view = optionLabel(humanize(project.viewStyle))
  const role = optionLabel(humanize(project.role))
  const status = optionLabel(humanize(project.status))
  const description = boundedText(project.description)
  const state =
    collection === "archived" || project.isArchived ? "Archived" : "Active"

  return {
    type: "upsert",
    key: project.id,
    upstreamUpdatedAt: project.updatedAt ?? project.createdAt ?? undefined,
    icon:
      state === "Archived"
        ? Builder.notionIcon("archive", "gray")
        : Builder.notionIcon("folder"),
    properties: {
      Project: Builder.title(name),
      State: Builder.select(state),
      Kind: Builder.select(project.workspaceId ? "Workspace" : "Personal"),
      "Workspace Status": status ? Builder.select(status) : [],
      Color: color ? Builder.select(color) : [],
      Favorite: Builder.checkbox(project.isFavorite),
      Shared: Builder.checkbox(project.isShared),
      Inbox: Builder.checkbox(project.inboxProject),
      View: view ? Builder.select(view) : [],
      Role: role ? Builder.select(role) : [],
      Description: description ? Builder.richText(description) : [],
      "Description Truncated": Builder.checkbox(
        textWasTruncated(project.description)
      ),
      Created: dateProperty(project.createdAt, `project ${project.id} created`),
      Updated: dateProperty(project.updatedAt, `project ${project.id} updated`),
      "Workspace ID": project.workspaceId
        ? Builder.richText(project.workspaceId)
        : [],
      "Parent Project ID": project.parentId
        ? Builder.richText(project.parentId)
        : [],
      "Todoist Project ID": Builder.richText(project.id),
    },
  }
}
