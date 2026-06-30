import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"
import type { JiraSprint, BoardLookup } from "./jira.js"
import { dateOnly } from "./helpers.js"

export const INITIAL_TITLE = "Jira Sprints"
export const PRIMARY_KEY = "Sprint ID"

export const sprintSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  databaseIcon: notionIcon("run"),
  properties: {
    Name: Schema.title(),

    State: Schema.select([
      { name: "Active" },
      { name: "Closed" },
      { name: "Future" },
    ]),

    Board: Schema.richText(),

    "Start Date": Schema.date(),

    "End Date": Schema.date(),

    Goal: Schema.richText(),

    "Complete Date": Schema.date(),

    "Sprint ID": Schema.richText(),
  },
}

const STATE_LABELS: Record<string, string> = {
  active: "Active",
  closed: "Closed",
  future: "Future",
}

export function sprintToChange(sprint: JiraSprint, boards: BoardLookup) {
  const state = STATE_LABELS[sprint.state] ?? sprint.state
  const boardName = boards.get(sprint.originBoardId) ?? null

  return {
    type: "upsert" as const,
    key: String(sprint.id),
    pageContentMarkdown: sprint.goal ?? "",
    properties: {
      Name: Builder.title(sprint.name),
      State: Builder.select(state),
      ...(boardName ? { Board: Builder.richText(boardName) } : {}),
      ...(sprint.startDate
        ? { "Start Date": Builder.date(dateOnly(sprint.startDate)) }
        : {}),
      ...(sprint.endDate
        ? { "End Date": Builder.date(dateOnly(sprint.endDate)) }
        : {}),
      ...(sprint.goal ? { Goal: Builder.richText(sprint.goal) } : {}),
      ...(sprint.completeDate
        ? { "Complete Date": Builder.date(dateOnly(sprint.completeDate)) }
        : {}),
      "Sprint ID": Builder.richText(String(sprint.id)),
    },
  }
}
