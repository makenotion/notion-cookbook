const MAX_TITLE_CHARACTERS = 2_000
const MAX_PROPERTY_CHARACTERS = 2_000
const MAX_SELECT_CHARACTERS = 100
const MAX_PAGE_VALUE_CHARACTERS = 500

function unicodeSlice(value: string, limit: number): string {
  const characters = Array.from(value)
  if (characters.length <= limit) return value
  return `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`
}

export function titleText(value: string | null | undefined): string {
  const text = value?.trim() || "Untitled Sentry issue"
  return unicodeSlice(text, MAX_TITLE_CHARACTERS)
}

export function propertyText(value: string | null | undefined): string | null {
  const text = value?.trim()
  return text ? unicodeSlice(text, MAX_PROPERTY_CHARACTERS) : null
}

export function selectText(value: string | null | undefined): string | null {
  const text = value?.trim()
  return text
    ? unicodeSlice(formatSentryLabel(text), MAX_SELECT_CHARACTERS)
    : null
}

export function formatSentryLabel(value: string): string {
  const spaced = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")

  return spaced.replace(/\b\w/g, (character) => character.toUpperCase())
}

export function dateTime(value: string | null | undefined): string | null {
  const timestamp = value?.trim()
  return timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : null
}

export function nonnegativeNumber(
  value: string | number | null | undefined
): number | null {
  if (value === null || value === undefined || value === "") return null
  const number = typeof value === "number" ? value : Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

export type SentryStats = Record<string, Array<[number, number]>>

export function summedStats(
  stats: SentryStats | null | undefined,
  period: string
): number | null {
  const points = stats?.[period]
  if (!points) return null

  let total = 0
  for (const [, count] of points) {
    if (!Number.isFinite(count) || count < 0) return null
    total += count
    if (!Number.isFinite(total)) return null
  }
  return total
}

export function safeHttpUrl(value: string | null | undefined): string | null {
  const text = value?.trim()
  if (!text) return null

  try {
    const url = new URL(text)
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null
  } catch {
    return null
  }
}

export function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]{}()#+\-.!>|<>])/g, "\\$1")
}

function markdownValue(value: string): string {
  return escapeMarkdown(unicodeSlice(value, MAX_PAGE_VALUE_CHARACTERS))
}

function plural(count: number, singular: string): string {
  return `${count.toLocaleString("en-US")} ${singular}${count === 1 ? "" : "s"}`
}

export type TriageIssue = {
  status: string | null
  substatus: string | null
  priority: string | null
  level: string | null
  isUnhandled: boolean | null
  assignedTo: { name: string | null } | null
  project: { name: string | null; slug: string | null } | null
  platform: string | null
  culprit: string | null
  firstSeen: string | null
  lastSeen: string | null
  permalink: string | null
  count: string | number | null
  userCount: string | number | null
  lifetime: {
    count: string | number | null
    userCount: string | number | null
  } | null
  stats: SentryStats | null
}

/** Build a bounded triage brief from group metadata, never raw event data. */
export function issuePageContent(issue: TriageIssue): string {
  const status = selectText(issue.status)
  const detail = selectText(issue.substatus)
  const priority = selectText(issue.priority)
  const level = selectText(issue.level)
  const assignee = propertyText(issue.assignedTo?.name)
  const project = propertyText(issue.project?.name ?? issue.project?.slug)
  const platform = propertyText(issue.platform)
  const culprit = propertyText(issue.culprit)
  const firstSeen = dateTime(issue.firstSeen)
  const lastSeen = dateTime(issue.lastSeen)
  const recentEvents = summedStats(issue.stats, "24h")
  const windowEvents = nonnegativeNumber(issue.count)
  const windowUsers = nonnegativeNumber(issue.userCount)
  const lifetimeEvents = nonnegativeNumber(issue.lifetime?.count)
  const lifetimeUsers = nonnegativeNumber(issue.lifetime?.userCount)
  const url = safeHttpUrl(issue.permalink)

  const signals = [
    detail && ["New", "Regressed", "Escalating"].includes(detail)
      ? detail
      : null,
    priority === "High" ? "High priority" : null,
    level === "Fatal" ? "Fatal" : null,
    issue.isUnhandled === true ? "Unhandled" : null,
    !assignee && status === "Unresolved" ? "Unassigned" : null,
  ].filter((value): value is string => Boolean(value))

  const lines = [
    `- **Status:** ${markdownValue(
      [status, detail].filter(Boolean).join(" · ") || "Not provided"
    )}`,
    `- **Owner:** ${markdownValue(assignee || "Unassigned")}`,
    recentEvents === null
      ? null
      : `- **Last 24 hours:** ${plural(recentEvents, "event")}`,
    windowEvents === null && windowUsers === null
      ? null
      : `- **30-day impact:** ${[
          windowEvents === null ? null : plural(windowEvents, "event"),
          windowUsers === null ? null : plural(windowUsers, "user"),
        ]
          .filter(Boolean)
          .join(" · ")}`,
    lifetimeEvents === null && lifetimeUsers === null
      ? null
      : `- **Lifetime impact:** ${[
          lifetimeEvents === null ? null : plural(lifetimeEvents, "event"),
          lifetimeUsers === null ? null : plural(lifetimeUsers, "user"),
        ]
          .filter(Boolean)
          .join(" · ")}`,
    signals.length > 0
      ? `- **Triage signals:** ${signals.map(markdownValue).join(" · ")}`
      : null,
    project || platform
      ? `- **Location:** ${[project, platform]
          .filter((value): value is string => Boolean(value))
          .map(markdownValue)
          .join(" · ")}`
      : null,
    culprit ? `- **Culprit:** ${markdownValue(culprit)}` : null,
    firstSeen ? `- **First seen:** ${firstSeen}` : null,
    lastSeen ? `- **Last seen:** ${lastSeen}` : null,
  ].filter((line): line is string => Boolean(line))

  const source = url
    ? `\n\n[Open this issue in Sentry](${url
        .replace(/\(/g, "%28")
        .replace(/\)/g, "%29")})`
    : ""
  return `## Triage snapshot\n\n${lines.join("\n")}${source}`
}
