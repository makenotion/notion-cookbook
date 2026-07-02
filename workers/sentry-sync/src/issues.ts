// Sentry issue groups — a rolling operational view for triage and review.
// Keep schema and transform property order aligned.

import * as Builder from "@notionhq/workers/builder"
import { notionIcon } from "@notionhq/workers"
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

export const INITIAL_TITLE = "Sentry Issues — Last 30 Days"
export const PRIMARY_KEY = "Sentry Issue ID"

export const issueSchema: Schema.Schema<typeof PRIMARY_KEY> = {
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
}

export function issueToChange(issue: SentryIssue) {
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
      ...(status ? { Status: Builder.select(status) } : {}),
      ...(assignee ? { Assignee: Builder.richText(assignee) } : {}),
      ...(url ? { "Issue Link": Builder.url(url) } : {}),
      ...(lastSeen ? { "Last Seen": Builder.dateTime(lastSeen) } : {}),
      ...(priority ? { Priority: Builder.select(priority) } : {}),
      ...(statusDetail
        ? { "Status Detail": Builder.select(statusDetail) }
        : {}),
      ...(level ? { Level: Builder.select(level) } : {}),
      ...(issue.isUnhandled === null
        ? {}
        : { Unhandled: Builder.checkbox(issue.isUnhandled) }),
      ...(recentEvents === null
        ? {}
        : { "Events (24h)": Builder.number(recentEvents) }),
      ...(windowEvents === null
        ? {}
        : { "Events (30d)": Builder.number(windowEvents) }),
      ...(windowUsers === null
        ? {}
        : { "Users (30d)": Builder.number(windowUsers) }),
      ...(lifetimeEvents === null
        ? {}
        : { "Lifetime Events": Builder.number(lifetimeEvents) }),
      ...(lifetimeUsers === null
        ? {}
        : { "Lifetime Users": Builder.number(lifetimeUsers) }),
      ...(project ? { Project: Builder.select(project) } : {}),
      ...(category ? { Category: Builder.select(category) } : {}),
      ...(issueType ? { "Issue Type": Builder.select(issueType) } : {}),
      ...(platform ? { Platform: Builder.select(platform) } : {}),
      ...(culprit ? { Culprit: Builder.richText(culprit) } : {}),
      ...(firstSeen ? { "First Seen": Builder.dateTime(firstSeen) } : {}),
      ...(issueKey ? { "Issue Key": Builder.richText(issueKey) } : {}),
      "Sentry Issue ID": Builder.richText(issue.id),
    },
  }
}
