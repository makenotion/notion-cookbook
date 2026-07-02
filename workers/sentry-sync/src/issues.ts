// Sentry issue groups — a rolling operational view for triage and review.
// Keep schema and transform property order aligned.

import * as Builder from "@notionhq/workers/builder"
import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"
import * as Schema from "@notionhq/workers/schema"

import {
  dateTime,
  issuePageContent,
  nonnegativeNumber,
  propertyText,
  safeHttpUrl,
  selectText,
  summedStats,
  titleText,
} from "./helpers.js"
import type { SentryIssue } from "./sentry.js"

export const INITIAL_TITLE = "Sentry Issues"
export const PRIMARY_KEY = "Sentry Issue ID"

export const issueSchema = {
  databaseIcon: notionIcon("bug"),
  properties: {
    Issue: Schema.title(),

    Status: Schema.select([
      { name: "Unresolved" },
      { name: "Resolved" },
      { name: "Ignored" },
      { name: "Pending Deletion" },
      { name: "Pending Merge" },
      { name: "Reprocessing" },
    ]),

    Assignee: Schema.richText(),

    "Issue Link": Schema.url(),

    "Last Seen": Schema.date(),

    Priority: Schema.select([
      { name: "High" },
      { name: "Medium" },
      { name: "Low" },
    ]),

    // Sentry's native lifecycle detail: new, ongoing, regressed, escalating,
    // or an archive condition. Unknown future values remain visible.
    "Status Detail": Schema.select([]),

    Level: Schema.select([
      { name: "Fatal" },
      { name: "Error" },
      { name: "Warning" },
      { name: "Info" },
      { name: "Debug" },
    ]),

    Unhandled: Schema.checkbox(),

    "Events (24h)": Schema.number(),

    "Events (30d)": Schema.number(),

    "Users (30d)": Schema.number(),

    "Lifetime Events": Schema.number(),

    "Lifetime Users": Schema.number(),

    Project: Schema.select([]),

    Category: Schema.select([]),

    "Issue Type": Schema.select([]),

    Platform: Schema.select([]),

    Culprit: Schema.richText(),

    "First Seen": Schema.date(),

    "Issue Key": Schema.richText(),

    "Sentry Issue ID": Schema.richText(),
  },
} satisfies Schema.Schema<typeof PRIMARY_KEY>

type IssueChange = SyncChangeUpsert<
  typeof PRIMARY_KEY,
  typeof issueSchema.properties
> & { pageContentMarkdown: string }

export function issueToChange(issue: SentryIssue): IssueChange {
  const status = selectText(issue.status)
  const assignee = propertyText(issue.assignedTo?.name)
  const url = safeHttpUrl(issue.permalink)
  const lastSeen = dateTime(issue.lastSeen)
  const priority = selectText(issue.priority)
  const statusDetail = selectText(issue.substatus)
  const level = selectText(issue.level)
  const recentEvents = summedStats(issue.stats, "24h")
  const windowEvents = nonnegativeNumber(issue.count)
  const windowUsers = nonnegativeNumber(issue.userCount)
  const lifetimeEvents = nonnegativeNumber(issue.lifetime?.count)
  const lifetimeUsers = nonnegativeNumber(issue.lifetime?.userCount)
  const project = selectText(issue.project?.name ?? issue.project?.slug)
  const category = selectText(issue.issueCategory)
  const issueType = selectText(issue.issueType)
  const platform = selectText(issue.platform ?? issue.project?.platform)
  const culprit = propertyText(issue.culprit)
  const firstSeen = dateTime(issue.firstSeen)
  const issueKey = propertyText(issue.shortId)

  return {
    type: "upsert" as const,
    key: issue.id,
    // Sentry does not expose a reliable general issue-mutation timestamp.
    // lastSeen tracks event activity, not status/priority/assignee changes, so
    // this replacement sync intentionally omits upstreamUpdatedAt.
    pageContentMarkdown: issuePageContent(issue),
    properties: {
      Issue: Builder.title(titleText(issue.title)),
      Status: status ? Builder.select(status) : [],
      Assignee: assignee ? Builder.richText(assignee) : [],
      "Issue Link": url ? Builder.url(url) : [],
      "Last Seen": lastSeen ? Builder.dateTime(lastSeen) : [],
      Priority: priority ? Builder.select(priority) : [],
      "Status Detail": statusDetail ? Builder.select(statusDetail) : [],
      Level: level ? Builder.select(level) : [],
      Unhandled:
        issue.isUnhandled === null ? [] : Builder.checkbox(issue.isUnhandled),
      "Events (24h)": recentEvents === null ? [] : Builder.number(recentEvents),
      "Events (30d)": windowEvents === null ? [] : Builder.number(windowEvents),
      "Users (30d)": windowUsers === null ? [] : Builder.number(windowUsers),
      "Lifetime Events":
        lifetimeEvents === null ? [] : Builder.number(lifetimeEvents),
      "Lifetime Users":
        lifetimeUsers === null ? [] : Builder.number(lifetimeUsers),
      Project: project ? Builder.select(project) : [],
      Category: category ? Builder.select(category) : [],
      "Issue Type": issueType ? Builder.select(issueType) : [],
      Platform: platform ? Builder.select(platform) : [],
      Culprit: culprit ? Builder.richText(culprit) : [],
      "First Seen": firstSeen ? Builder.dateTime(firstSeen) : [],
      "Issue Key": issueKey ? Builder.richText(issueKey) : [],
      "Sentry Issue ID": Builder.richText(issue.id),
    },
  }
}
