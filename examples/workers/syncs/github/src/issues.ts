// Issues sync — tracks GitHub issues across one or more repositories.
//
// IMPORTANT: This file and the schema must stay in sync. Every property name
// here needs a matching entry in the schema, and vice versa.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import type { GitHubIssue } from "./github.js"
import { dateOnly } from "./helpers.js"

export const INITIAL_TITLE = "GitHub Issues"
export const PRIMARY_KEY = "Issue Key"

export const issueSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  properties: {
    Title: Schema.title(),

    "Issue Key": Schema.richText(),

    "Issue Link": Schema.url(),

    State: Schema.select([{ name: "Open" }, { name: "Closed" }]),

    "State Reason": Schema.select([
      { name: "Completed" },
      { name: "Not planned" },
      { name: "Reopened" },
    ]),

    Author: Schema.richText(),

    Assignees: Schema.multiSelect([]),

    Labels: Schema.multiSelect([]),

    Milestone: Schema.richText(),

    Comments: Schema.number(),

    Reactions: Schema.number(),

    Repository: Schema.richText(),

    Created: Schema.date(),

    Updated: Schema.date(),

    Closed: Schema.date(),
  },
}

const STATE_REASON_LABELS: Record<string, string> = {
  completed: "Completed",
  not_planned: "Not planned",
  reopened: "Reopened",
}

export function issueToChange(issue: GitHubIssue, repo: string) {
  const stateReason = STATE_REASON_LABELS[issue.state_reason ?? ""]

  return {
    type: "upsert" as const,
    key: `${repo}#${issue.number}`,
    upstreamUpdatedAt: issue.updated_at,
    pageContentMarkdown: issue.body ?? "",
    properties: {
      Title: Builder.title(issue.title),
      "Issue Key": Builder.richText(`${repo}#${issue.number}`),
      "Issue Link": Builder.url(issue.html_url),
      State: Builder.select(issue.state === "open" ? "Open" : "Closed"),
      ...(stateReason
        ? { "State Reason": Builder.select(stateReason) }
        : {}),
      ...(issue.user
        ? { Author: Builder.richText(issue.user.login) }
        : {}),
      ...(issue.assignees.length > 0
        ? {
            Assignees: Builder.multiSelect(
              ...issue.assignees.map((a) => a.login)
            ),
          }
        : {}),
      ...(issue.labels.length > 0
        ? {
            Labels: Builder.multiSelect(...issue.labels.map((l) => l.name)),
          }
        : {}),
      ...(issue.milestone
        ? { Milestone: Builder.richText(issue.milestone.title) }
        : {}),
      Comments: Builder.number(issue.comments),
      Reactions: Builder.number(issue.reactions.total_count),
      Repository: Builder.richText(repo),
      Created: Builder.date(dateOnly(issue.created_at)),
      Updated: Builder.date(dateOnly(issue.updated_at)),
      ...(issue.closed_at
        ? { Closed: Builder.date(dateOnly(issue.closed_at)) }
        : {}),
    },
  }
}
