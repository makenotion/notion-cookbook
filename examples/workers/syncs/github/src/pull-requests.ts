// Pull Requests sync — tracks PRs across one or more repositories.
//
// IMPORTANT: This file and the schema must stay in sync. Every property name
// here needs a matching entry in the schema, and vice versa.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import type { GitHubPullRequest } from "./github.js"
import { dateOnly } from "./helpers.js"

export const INITIAL_TITLE = "GitHub Pull Requests"
export const PRIMARY_KEY = "PR Key"

export const pullRequestSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  properties: {
    Title: Schema.title(),

    "PR Key": Schema.richText(),

    "PR Link": Schema.url(),

    State: Schema.select([
      { name: "Open" },
      { name: "Closed" },
      { name: "Merged" },
    ]),

    Draft: Schema.checkbox(),

    Author: Schema.richText(),

    Assignees: Schema.multiSelect([]),

    Reviewers: Schema.multiSelect([]),

    Labels: Schema.multiSelect([]),

    Milestone: Schema.richText(),

    "Base Branch": Schema.richText(),

    "Head Branch": Schema.richText(),

    Additions: Schema.number(),

    Deletions: Schema.number(),

    Comments: Schema.number(),

    Repository: Schema.richText(),

    Created: Schema.date(),

    Updated: Schema.date(),

    Merged: Schema.date(),
  },
}

function prState(pr: GitHubPullRequest): string {
  if (pr.merged_at) return "Merged"
  return pr.state === "open" ? "Open" : "Closed"
}

export function pullRequestToChange(pr: GitHubPullRequest, repo: string) {
  return {
    type: "upsert" as const,
    key: `${repo}#${pr.number}`,
    upstreamUpdatedAt: pr.updated_at,
    pageContentMarkdown: pr.body ?? "",
    properties: {
      Title: Builder.title(pr.title),
      "PR Key": Builder.richText(`${repo}#${pr.number}`),
      "PR Link": Builder.url(pr.html_url),
      State: Builder.select(prState(pr)),
      Draft: Builder.checkbox(pr.draft),
      ...(pr.user ? { Author: Builder.richText(pr.user.login) } : {}),
      ...(pr.assignees.length > 0
        ? {
            Assignees: Builder.multiSelect(
              ...pr.assignees.map((a) => a.login)
            ),
          }
        : {}),
      ...(pr.requested_reviewers.length > 0
        ? {
            Reviewers: Builder.multiSelect(
              ...pr.requested_reviewers.map((r) => r.login)
            ),
          }
        : {}),
      ...(pr.labels.length > 0
        ? { Labels: Builder.multiSelect(...pr.labels.map((l) => l.name)) }
        : {}),
      ...(pr.milestone
        ? { Milestone: Builder.richText(pr.milestone.title) }
        : {}),
      "Base Branch": Builder.richText(pr.base.ref),
      "Head Branch": Builder.richText(pr.head.ref),
      Additions: Builder.number(pr.additions),
      Deletions: Builder.number(pr.deletions),
      Comments: Builder.number(pr.review_comments + pr.comments),
      Repository: Builder.richText(repo),
      Created: Builder.date(dateOnly(pr.created_at)),
      Updated: Builder.date(dateOnly(pr.updated_at)),
      ...(pr.merged_at
        ? { Merged: Builder.date(dateOnly(pr.merged_at)) }
        : {}),
    },
  }
}
