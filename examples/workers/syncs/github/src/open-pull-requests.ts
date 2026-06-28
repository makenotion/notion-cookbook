// Open Pull Requests sync — tracks active PRs with review and CI status.
//
// This table only contains open PRs and is enriched with per-PR data
// (review decisions and check run results) that the list endpoint does
// not provide. Because only open PRs are fetched, the extra API calls
// stay well within rate limits even at a 2-minute sync interval.

import * as Schema from "@notionhq/workers/schema"
import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"
import type { GitHubPullRequest, GitHubReview, GitHubCheckRun } from "./github.js"
import { dateOnly } from "./helpers.js"

export const INITIAL_TITLE = "Open GitHub PRs"
export const PRIMARY_KEY = "PR Key"

export const openPullRequestSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  databaseIcon: notionIcon("pull-request"),
  properties: {
    Title: Schema.title(),

    "Review State": Schema.select([
      { name: "Approved" },
      { name: "Changes Requested" },
    ]),

    "CI Status": Schema.select([
      { name: "Success" },
      { name: "Failure" },
      { name: "Pending" },
    ]),

    Author: Schema.richText(),

    Reviewers: Schema.multiSelect([]),

    Updated: Schema.date(),

    "PR Key": Schema.richText(),

    "PR Link": Schema.url(),

    Draft: Schema.checkbox(),

    Assignees: Schema.multiSelect([]),

    Labels: Schema.multiSelect([]),

    Milestone: Schema.richText(),

    "Base Branch": Schema.richText(),

    "Head Branch": Schema.richText(),

    Repository: Schema.richText(),

    Created: Schema.date(),
  },
}

export function reviewState(reviews: GitHubReview[]): string | undefined {
  const latest = new Map<string, string>()
  for (const r of reviews) {
    const login = r.user?.login
    if (!login) continue
    if (r.state === "COMMENTED" || r.state === "PENDING") continue
    if (r.state === "DISMISSED") {
      latest.delete(login)
      continue
    }
    latest.set(login, r.state)
  }

  const states = [...latest.values()]
  if (states.includes("CHANGES_REQUESTED")) return "Changes Requested"
  if (states.includes("APPROVED")) return "Approved"
  return undefined
}

export function ciStatus(checkRuns: GitHubCheckRun[]): string | undefined {
  if (checkRuns.length === 0) return undefined
  if (checkRuns.some((c) => c.conclusion === "failure")) return "Failure"
  if (checkRuns.some((c) => c.status !== "completed")) return "Pending"
  if (checkRuns.every((c) => c.conclusion === "success")) return "Success"
  return undefined
}

export function openPullRequestToChange(
  pr: GitHubPullRequest,
  repo: string,
  reviews: GitHubReview[],
  checkRuns: GitHubCheckRun[]
) {
  const review = reviewState(reviews)
  const ci = ciStatus(checkRuns)

  return {
    type: "upsert" as const,
    key: `${repo}#${pr.number}`,
    upstreamUpdatedAt: pr.updated_at,
    pageContentMarkdown: pr.body ?? "",
    properties: {
      Title: Builder.title(pr.title),
      "PR Key": Builder.richText(`${repo}#${pr.number}`),
      "PR Link": Builder.url(pr.html_url),
      Draft: Builder.checkbox(pr.draft),
      ...(review ? { "Review State": Builder.select(review) } : {}),
      ...(ci ? { "CI Status": Builder.select(ci) } : {}),
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
      Repository: Builder.richText(repo),
      Created: Builder.date(dateOnly(pr.created_at)),
      Updated: Builder.date(dateOnly(pr.updated_at)),
    },
  }
}
