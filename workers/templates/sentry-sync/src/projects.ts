// Project inventory enriched with issue-derived reliability signals. User
// counts are intentionally absent because one person can span many groups.

import * as Builder from "@notionhq/workers/builder"
import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"
import * as Schema from "@notionhq/workers/schema"

import {
  dateTime,
  escapeMarkdown,
  nonnegativeNumber,
  propertyText,
  safeHttpUrl,
  selectText,
  titleText,
} from "./helpers.js"
import type { SentryIssue, SentryProject, SentryScope } from "./sentry.js"
import type { IssueWindow } from "./sync-state.js"

export const INITIAL_TITLE = "Sentry Projects"
export const PRIMARY_KEY = "Sentry Project ID"
export const MAX_AGGREGATED_PROJECTS = 500
const MAX_MULTI_SELECT_VALUES = 100

export class ProjectAggregationLimitError extends Error {
  constructor() {
    super(
      `Sentry project aggregation exceeded ${MAX_AGGREGATED_PROJECTS} active projects`
    )
    this.name = "ProjectAggregationLimitError"
  }
}

export type MostActiveIssue = {
  id: string
  title: string
  events: number
  url: string | null
}

export type ProjectIssueAggregate = {
  projectId: string
  projectName: string | null
  projectSlug: string | null
  platform: string | null
  issueGroups: number
  unresolvedIssues: number
  highPriorityUnresolved: number
  newUnresolved: number
  regressedUnresolved: number
  escalatingUnresolved: number
  unhandledUnresolved: number
  unassignedUnresolved: number
  previous7dEvents: number
  events7d: number
  events30d: number
  statsComplete: boolean
  countsComplete: boolean
  mostActiveIssue: MostActiveIssue | null
  lastSeen: string | null
}

export type ProjectAggregateMap = Record<string, ProjectIssueAggregate>

export const projectSchema = {
  databaseIcon: notionIcon("chart-line"),
  properties: {
    Project: Schema.title(),
    "Unresolved Issues (30d)": Schema.number(),
    "Events (7d)": Schema.number(),
    "Most Active Issue (7d)": Schema.richText(),
    "Issue Link": Schema.url(),
    "Last Seen": Schema.date(),
    "Previous 7d Events": Schema.number(),
    "Event Change vs Prior 7d": Schema.number(),
    "Issue Groups (30d)": Schema.number(),
    "Events (30d)": Schema.number(),
    "High-Priority Unresolved (30d)": Schema.number(),
    "New Unresolved (30d)": Schema.number(),
    "Regressed Unresolved (30d)": Schema.number(),
    "Escalating Unresolved (30d)": Schema.number(),
    "Unhandled Unresolved (30d)": Schema.number(),
    "Unassigned Unresolved (30d)": Schema.number(),
    "Project Link": Schema.url(),
    Platform: Schema.select([]),
    Teams: Schema.multiSelect([]),
    "Has Sessions": Schema.checkbox(),
    "First Event": Schema.date(),
    "Environment Scope": Schema.richText(),
    "As Of": Schema.date(),
    "Project Slug": Schema.richText(),
    "Sentry Project ID": Schema.richText(),
  },
} satisfies Schema.Schema<typeof PRIMARY_KEY>

type ProjectChange = SyncChangeUpsert<
  typeof PRIMARY_KEY,
  typeof projectSchema.properties
> & { pageContentMarkdown: string }

function issueEventBuckets(
  issue: SentryIssue,
  window: IssueWindow
): { previous: number; current: number } | null {
  const points = issue.stats?.["14d"]
  if (!points) return null

  const end = Date.parse(window.end)
  const split = end - 7 * 86_400_000
  const start = end - 14 * 86_400_000
  let previous = 0
  let current = 0
  for (const [rawTimestamp, count] of points) {
    const timestamp =
      rawTimestamp < 1_000_000_000_000 ? rawTimestamp * 1_000 : rawTimestamp
    if (timestamp >= start && timestamp < split) previous += count
    if (timestamp >= split && timestamp <= end) current += count
  }
  return { previous, current }
}

function maxDate(
  current: string | null,
  candidate: string | null
): string | null {
  const valid = dateTime(candidate)
  if (!valid) return current
  return !current || Date.parse(valid) > Date.parse(current) ? valid : current
}

function preferMostActive(
  current: MostActiveIssue | null,
  issue: SentryIssue,
  events: number
): MostActiveIssue {
  const rawUrl = safeHttpUrl(issue.permalink)
  const candidate = {
    id: issue.id,
    title: propertyText(issue.title) ?? "Untitled issue",
    events,
    url: rawUrl && Array.from(rawUrl).length <= 2_000 ? rawUrl : null,
  }
  if (!current) return candidate
  if (candidate.events !== current.events) {
    return candidate.events > current.events ? candidate : current
  }
  return candidate.id.localeCompare(current.id) < 0 ? candidate : current
}

/** Fold one issue page into a compact, serializable project map. */
export function aggregateProjectIssues(
  prior: ProjectAggregateMap,
  issues: SentryIssue[],
  window: IssueWindow
): ProjectAggregateMap {
  const aggregates: ProjectAggregateMap = structuredClone(prior)

  for (const issue of issues) {
    const projectId = issue.project?.id?.trim()
    if (!projectId) {
      throw new Error(
        `Sentry issue ${issue.id} is missing an immutable project ID required by the projects sync`
      )
    }

    const existing = aggregates[projectId]
    if (
      !existing &&
      Object.keys(aggregates).length >= MAX_AGGREGATED_PROJECTS
    ) {
      throw new ProjectAggregationLimitError()
    }

    const aggregate: ProjectIssueAggregate = existing ?? {
      projectId,
      projectName: issue.project?.name ?? null,
      projectSlug: issue.project?.slug ?? null,
      platform: issue.platform ?? issue.project?.platform ?? null,
      issueGroups: 0,
      unresolvedIssues: 0,
      highPriorityUnresolved: 0,
      newUnresolved: 0,
      regressedUnresolved: 0,
      escalatingUnresolved: 0,
      unhandledUnresolved: 0,
      unassignedUnresolved: 0,
      previous7dEvents: 0,
      events7d: 0,
      events30d: 0,
      statsComplete: true,
      countsComplete: true,
      mostActiveIssue: null,
      lastSeen: null,
    }

    // Names and slugs can change between issue pages. The immutable ID owns
    // aggregation identity; issue metadata is only a fallback when the
    // canonical project inventory record is deleted or inaccessible.
    aggregate.projectName ??= issue.project?.name ?? null
    aggregate.projectSlug ??= issue.project?.slug ?? null
    aggregate.platform ??= issue.platform ?? issue.project?.platform ?? null
    aggregate.issueGroups += 1
    aggregate.lastSeen = maxDate(aggregate.lastSeen, issue.lastSeen)

    const status = issue.status?.trim().toLowerCase()
    const substatus = issue.substatus?.trim().toLowerCase()
    const unresolved = status === "unresolved"
    if (unresolved) {
      aggregate.unresolvedIssues += 1
      if (issue.priority?.trim().toLowerCase() === "high") {
        aggregate.highPriorityUnresolved += 1
      }
      if (substatus === "new") aggregate.newUnresolved += 1
      if (substatus === "regressed") aggregate.regressedUnresolved += 1
      if (substatus === "escalating") aggregate.escalatingUnresolved += 1
      if (issue.isUnhandled === true) aggregate.unhandledUnresolved += 1
      if (!issue.assignedTo?.name?.trim()) aggregate.unassignedUnresolved += 1
    }

    const count = nonnegativeNumber(issue.count)
    if (count === null) aggregate.countsComplete = false
    else aggregate.events30d += count

    const buckets = issueEventBuckets(issue, window)
    if (!buckets) {
      aggregate.statsComplete = false
    } else {
      aggregate.previous7dEvents += buckets.previous
      aggregate.events7d += buckets.current
      aggregate.mostActiveIssue = preferMostActive(
        aggregate.mostActiveIssue,
        issue,
        buckets.current
      )
    }

    aggregates[projectId] = aggregate
  }

  return aggregates
}

export function projectMatchesScope(
  project: Pick<SentryProject, "id" | "slug">,
  scope: SentryScope
): boolean {
  return (
    scope.projects.length === 0 ||
    scope.projects.includes(project.id) ||
    scope.projects.includes(project.slug)
  )
}

function projectIssueUrl(scope: SentryScope, projectId: string): string {
  const url = new URL(scope.baseUrl)
  const prefix = url.pathname.replace(/\/+$/, "")
  url.pathname = `${prefix}/organizations/${encodeURIComponent(
    scope.organization
  )}/issues/`
  url.searchParams.set("project", projectId)
  for (const environment of scope.environments) {
    url.searchParams.append("environment", environment)
  }
  return url.toString()
}

export function aggregateProjectResource(
  aggregate: ProjectIssueAggregate
): SentryProject {
  return {
    id: aggregate.projectId,
    name:
      aggregate.projectName?.trim() ||
      aggregate.projectSlug?.trim() ||
      `Project ${aggregate.projectId}`,
    slug: aggregate.projectSlug?.trim() || aggregate.projectId,
    platform: aggregate.platform,
    platforms: aggregate.platform ? [aggregate.platform] : [],
    teams: [],
    dateCreated: null,
    firstEvent: null,
    hasSessions: null,
  }
}

function projectPageContent(
  project: SentryProject,
  aggregate: ProjectIssueAggregate | undefined,
  asOf: string,
  scope: SentryScope
): string {
  const unresolved = aggregate?.unresolvedIssues ?? 0
  const lines = [
    `- **Unresolved issue groups seen in 30 days:** ${unresolved.toLocaleString(
      "en-US"
    )}`,
    aggregate?.statsComplete === false
      ? "- **7-day event trend:** Incomplete in the source response"
      : `- **7-day event trend:** ${(aggregate?.events7d ?? 0).toLocaleString(
          "en-US"
        )} current · ${(aggregate?.previous7dEvents ?? 0).toLocaleString(
          "en-US"
        )} previous`,
    `- **Ownership gaps:** ${(
      aggregate?.unassignedUnresolved ?? 0
    ).toLocaleString("en-US")} unresolved and unassigned`,
    `- **Lifecycle signals:** ${(aggregate?.newUnresolved ?? 0).toLocaleString(
      "en-US"
    )} new · ${(aggregate?.regressedUnresolved ?? 0).toLocaleString(
      "en-US"
    )} regressed · ${(aggregate?.escalatingUnresolved ?? 0).toLocaleString(
      "en-US"
    )} escalating`,
    `- **Environment scope:** ${escapeMarkdown(
      propertyText(scope.environments.join(", ") || "All environments") ??
        "All environments"
    )}`,
    `- **Snapshot:** ${asOf}`,
  ]
  const top =
    aggregate?.statsComplete === true ? aggregate.mostActiveIssue : null
  const topLine = top
    ? `\n\nMost active issue in the current seven-day window: **${escapeMarkdown(
        propertyText(top.title) ?? "Untitled issue"
      )}** (${top.events.toLocaleString("en-US")} events).`
    : ""
  const link = projectIssueUrl(scope, project.id)
  return `## Reliability snapshot\n\n${lines.join("\n")}${topLine}\n\n[Review this project's issues in Sentry](${link})`
}

export function projectToChange(
  project: SentryProject,
  aggregate: ProjectIssueAggregate | undefined,
  asOf: string,
  scope: SentryScope
): ProjectChange {
  const mostActive =
    aggregate?.statsComplete === true ? aggregate.mostActiveIssue : null
  const platform = selectText(
    project.platform || project.platforms[0] || aggregate?.platform
  )
  const teams = project.teams
    .map((team) => selectText(team.name))
    .filter((value): value is string => Boolean(value))
  if (teams.length > MAX_MULTI_SELECT_VALUES) {
    throw new Error(
      `Sentry project ${project.id} has more than ${MAX_MULTI_SELECT_VALUES} teams and cannot fit in one complete Notion property.`
    )
  }
  const lastSeen = dateTime(aggregate?.lastSeen)
  const firstEvent = dateTime(project.firstEvent)
  const projectLink = safeHttpUrl(projectIssueUrl(scope, project.id))
  const issueLink = safeHttpUrl(mostActive?.url)

  return {
    type: "upsert" as const,
    key: project.id,
    pageContentMarkdown: projectPageContent(project, aggregate, asOf, scope),
    properties: {
      Project: Builder.title(
        titleText(project.name, "Untitled Sentry project")
      ),
      "Unresolved Issues (30d)": Builder.number(
        aggregate?.unresolvedIssues ?? 0
      ),
      "Events (7d)":
        aggregate?.statsComplete === false
          ? []
          : Builder.number(aggregate?.events7d ?? 0),
      "Most Active Issue (7d)": mostActive
        ? Builder.richText(propertyText(mostActive.title) ?? "Untitled issue")
        : [],
      "Issue Link": issueLink ? Builder.url(issueLink) : [],
      "Last Seen": lastSeen ? Builder.dateTime(lastSeen) : [],
      "Previous 7d Events":
        aggregate?.statsComplete === false
          ? []
          : Builder.number(aggregate?.previous7dEvents ?? 0),
      "Event Change vs Prior 7d":
        aggregate?.statsComplete === false
          ? []
          : Builder.number(
              (aggregate?.events7d ?? 0) - (aggregate?.previous7dEvents ?? 0)
            ),
      "Issue Groups (30d)": Builder.number(aggregate?.issueGroups ?? 0),
      "Events (30d)":
        aggregate?.countsComplete === false
          ? []
          : Builder.number(aggregate?.events30d ?? 0),
      "High-Priority Unresolved (30d)": Builder.number(
        aggregate?.highPriorityUnresolved ?? 0
      ),
      "New Unresolved (30d)": Builder.number(aggregate?.newUnresolved ?? 0),
      "Regressed Unresolved (30d)": Builder.number(
        aggregate?.regressedUnresolved ?? 0
      ),
      "Escalating Unresolved (30d)": Builder.number(
        aggregate?.escalatingUnresolved ?? 0
      ),
      "Unhandled Unresolved (30d)": Builder.number(
        aggregate?.unhandledUnresolved ?? 0
      ),
      "Unassigned Unresolved (30d)": Builder.number(
        aggregate?.unassignedUnresolved ?? 0
      ),
      "Project Link": projectLink ? Builder.url(projectLink) : [],
      Platform: platform ? Builder.select(platform) : [],
      Teams: Builder.multiSelect(...teams),
      "Has Sessions":
        project.hasSessions === null
          ? []
          : Builder.checkbox(project.hasSessions),
      "First Event": firstEvent ? Builder.dateTime(firstEvent) : [],
      "Environment Scope": Builder.richText(
        propertyText(scope.environments.join(", ") || "All environments") ??
          "All environments"
      ),
      "As Of": Builder.dateTime(asOf),
      "Project Slug": Builder.richText(project.slug),
      "Sentry Project ID": Builder.richText(project.id),
    },
  }
}
