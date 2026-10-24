// The newest organization releases enriched with one aggregate Release Health
// query. Rows match Sentry's release entity; there are no per-release calls.

import * as Builder from "@notionhq/workers/builder"
import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"
import * as Schema from "@notionhq/workers/schema"

import {
  dateTime,
  escapeMarkdown,
  propertyText,
  safeHttpUrl,
  selectText,
  titleText,
} from "./helpers.js"
import type {
  SentryRelease,
  SentryReleaseHealth,
  SentryReleaseHealthSnapshot,
  SentryScope,
} from "./sentry.js"

export const INITIAL_TITLE = "Sentry Releases"
export const PRIMARY_KEY = "Sentry Release ID"
export const RELEASE_HEALTH_DAYS = 7
const MAX_MULTI_SELECT_VALUES = 100

export function releaseHealthWindow(now = Date.now()): {
  start: string
  end: string
} {
  if (!Number.isFinite(now) || now < 0) {
    throw new Error(
      "Cannot create a Sentry release window from an invalid time"
    )
  }
  return {
    start: new Date(
      Math.max(0, now - RELEASE_HEALTH_DAYS * 86_400_000)
    ).toISOString(),
    end: new Date(now).toISOString(),
  }
}

export const releaseSchema = {
  databaseIcon: notionIcon("shield"),
  properties: {
    Release: Schema.title(),
    Projects: Schema.multiSelect([]),
    "Crash-Free Users": Schema.number("percent"),
    "Crash-Free Sessions": Schema.number("percent"),
    "New Issues": Schema.number(),
    Status: Schema.select([]),
    "Sessions (7d)": Schema.number(),
    "Users (7d)": Schema.number(),
    "Sentry Link": Schema.url(),
    "Released At": Schema.date(),
    "Created At": Schema.date(),
    "Health Data (7d)": Schema.checkbox(),
    "Release URL": Schema.url(),
    "First Event": Schema.date(),
    "Last Event": Schema.date(),
    Deploys: Schema.number(),
    Commits: Schema.number(),
    Platforms: Schema.multiSelect([]),
    Version: Schema.richText(),
    Reference: Schema.richText(),
    "Window Start": Schema.date(),
    "Window End": Schema.date(),
    "Health Project Scope": Schema.richText(),
    "Environment Scope": Schema.richText(),
    "Sentry Release ID": Schema.richText(),
  },
} satisfies Schema.Schema<typeof PRIMARY_KEY>

type ReleaseChange = SyncChangeUpsert<
  typeof PRIMARY_KEY,
  typeof releaseSchema.properties
> & { pageContentMarkdown: string }

export function healthByRelease(
  snapshot: SentryReleaseHealthSnapshot
): Map<string, SentryReleaseHealth> {
  const result = new Map<string, SentryReleaseHealth>()
  for (const group of snapshot.groups) {
    if (result.has(group.release)) {
      throw new Error(
        `Sentry release health returned duplicate release group ${group.release}`
      )
    }
    result.set(group.release, group)
  }
  return result
}

function sentryPercent(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(
      `Sentry returned an invalid crash-free percentage: ${value}`
    )
  }
  // The sessions API reports percentage points (for example, 99.9), while a
  // Notion percent property stores the corresponding fraction.
  return value / 100
}

export function sentryReleaseUrl(scope: SentryScope, version: string): string {
  const url = new URL(scope.baseUrl)
  const prefix = url.pathname.replace(/\/+$/, "")
  url.pathname = `${prefix}/organizations/${encodeURIComponent(
    scope.organization
  )}/releases/${encodeURIComponent(version)}/`
  return url.toString()
}

function releasePageContent(
  release: SentryRelease,
  health: SentryReleaseHealth | undefined,
  snapshot: SentryReleaseHealthSnapshot,
  scope: SentryScope
): string {
  const projects = release.projects
    .map((project) => project.name || project.slug)
    .join(", ")
  const lines = [
    `- **Projects:** ${escapeMarkdown(
      propertyText(projects) ?? "Not provided"
    )}`,
    `- **Release:** ${escapeMarkdown(
      propertyText(release.version) ?? "Unknown"
    )}`,
    health?.crashFreeUsers === null || health?.crashFreeUsers === undefined
      ? "- **Crash-free users:** Not available"
      : `- **Crash-free users:** ${health.crashFreeUsers.toLocaleString(
          "en-US",
          { maximumFractionDigits: 3 }
        )}%`,
    health?.sessions === null || health?.sessions === undefined
      ? "- **Seven-day exposure:** Not available"
      : `- **Seven-day exposure:** ${health.sessions.toLocaleString(
          "en-US"
        )} sessions${
          health.users === null
            ? ""
            : ` · ${health.users.toLocaleString("en-US")} users`
        }`,
    `- **Health window:** ${snapshot.start} to ${snapshot.end}`,
    `- **Health project scope:** ${escapeMarkdown(
      propertyText(scope.projects.join(", ") || "All accessible projects") ??
        "All accessible projects"
    )}`,
    `- **Environment scope:** ${escapeMarkdown(
      propertyText(scope.environments.join(", ") || "All environments") ??
        "All environments"
    )}`,
  ]
  const sourceUrl = sentryReleaseUrl(scope, release.version)
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
  return `## Rollout snapshot\n\n${lines.join(
    "\n"
  )}\n\n[Open this release in Sentry](${sourceUrl})`
}

export function releasesToChanges(
  releases: SentryRelease[],
  snapshot: SentryReleaseHealthSnapshot,
  scope: SentryScope
): ReleaseChange[] {
  const health = healthByRelease(snapshot)
  return releases.map((release) => {
    const releaseHealth = health.get(release.version)
    const projects = [
      ...new Set(
        release.projects
          .map((project) => selectText(project.name || project.slug))
          .filter((value): value is string => Boolean(value))
      ),
    ]
    const platforms = [
      ...new Set(
        release.projects
          .flatMap((project) => [project.platform, ...project.platforms])
          .map(selectText)
          .filter((value): value is string => Boolean(value))
      ),
    ]
    if (projects.length > MAX_MULTI_SELECT_VALUES) {
      throw new Error(
        `Sentry release ${release.id} spans more than ${MAX_MULTI_SELECT_VALUES} projects; customize the Projects field to summarize associations while keeping the row complete.`
      )
    }
    if (platforms.length > MAX_MULTI_SELECT_VALUES) {
      throw new Error(
        `Sentry release ${release.id} has more than ${MAX_MULTI_SELECT_VALUES} platforms; narrow SENTRY_PROJECTS to keep the Notion row complete.`
      )
    }
    const crashFreeUsers = sentryPercent(releaseHealth?.crashFreeUsers)
    const crashFreeSessions = sentryPercent(releaseHealth?.crashFreeSessions)
    const status = selectText(release.status)
    const sentryUrl = safeHttpUrl(sentryReleaseUrl(scope, release.version))
    const externalUrl = safeHttpUrl(release.url)
    const releasedAt = dateTime(release.dateReleased)
    const createdAt = dateTime(release.dateCreated)
    const firstEvent = dateTime(release.firstEvent)
    const lastEvent = dateTime(release.lastEvent)
    const reference = propertyText(release.ref)
    const hasHealthData = Boolean(releaseHealth)

    return {
      type: "upsert" as const,
      key: release.id,
      pageContentMarkdown: releasePageContent(
        release,
        releaseHealth,
        snapshot,
        scope
      ),
      properties: {
        Release: Builder.title(
          titleText(
            release.shortVersion ?? release.version,
            "Untitled Sentry release"
          )
        ),
        Projects: Builder.multiSelect(...projects),
        "Crash-Free Users":
          crashFreeUsers === null ? [] : Builder.number(crashFreeUsers),
        "Crash-Free Sessions":
          crashFreeSessions === null ? [] : Builder.number(crashFreeSessions),
        "New Issues":
          release.newGroups === null ? [] : Builder.number(release.newGroups),
        Status: status ? Builder.select(status) : [],
        "Sessions (7d)":
          releaseHealth?.sessions === null ||
          releaseHealth?.sessions === undefined
            ? []
            : Builder.number(releaseHealth.sessions),
        "Users (7d)":
          releaseHealth?.users === null || releaseHealth?.users === undefined
            ? []
            : Builder.number(releaseHealth.users),
        "Sentry Link": sentryUrl ? Builder.url(sentryUrl) : [],
        "Released At": releasedAt ? Builder.dateTime(releasedAt) : [],
        "Created At": createdAt ? Builder.dateTime(createdAt) : [],
        "Health Data (7d)": Builder.checkbox(hasHealthData),
        "Release URL": externalUrl ? Builder.url(externalUrl) : [],
        "First Event": firstEvent ? Builder.dateTime(firstEvent) : [],
        "Last Event": lastEvent ? Builder.dateTime(lastEvent) : [],
        Deploys:
          release.deployCount === null
            ? []
            : Builder.number(release.deployCount),
        Commits:
          release.commitCount === null
            ? []
            : Builder.number(release.commitCount),
        Platforms: Builder.multiSelect(...platforms),
        Version: Builder.richText(
          propertyText(release.version) ?? "Unknown release"
        ),
        Reference: reference ? Builder.richText(reference) : [],
        "Window Start": Builder.dateTime(snapshot.start),
        "Window End": Builder.dateTime(snapshot.end),
        "Health Project Scope": Builder.richText(
          propertyText(
            scope.projects.join(", ") || "All accessible projects"
          ) ?? "All accessible projects"
        ),
        "Environment Scope": Builder.richText(
          propertyText(scope.environments.join(", ") || "All environments") ??
            "All environments"
        ),
        "Sentry Release ID": Builder.richText(release.id),
      },
    }
  })
}
