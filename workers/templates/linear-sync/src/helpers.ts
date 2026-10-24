// Shared display helpers for Linear resource transforms.

const PROJECT_STATUS_LABELS: Record<string, string> = {
  backlog: "Backlog",
  planned: "Planned",
  started: "Started",
  paused: "Paused",
  completed: "Completed",
  canceled: "Canceled",
  cancelled: "Canceled",
}

const HEALTH_LABELS: Record<string, string> = {
  ontrack: "On Track",
  atrisk: "At Risk",
  offtrack: "Off Track",
}

const PRIORITY_LABELS: Record<number, string> = {
  0: "No Priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
}

export const MAX_PAGE_SECTION_CHARACTERS = 20_000
export const MAX_RENDERED_CONTRIBUTING_PROJECTS = 100

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/** Turn an API enum or other machine label into readable title case. */
export function formatLinearLabel(value: string): string {
  const spaced = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")

  return spaced.replace(/\b\w/g, (character) => character.toUpperCase())
}

/** Map Linear's stable project status type, not a workspace-custom status name. */
export function projectStatusLabel(
  type: string | null | undefined
): string | null {
  const value = type?.trim()
  if (!value) return null

  return PROJECT_STATUS_LABELS[normalizedKey(value)] ?? formatLinearLabel(value)
}

export function healthLabel(health: string | null | undefined): string | null {
  const value = health?.trim()
  if (!value) return null

  return HEALTH_LABELS[normalizedKey(value)] ?? formatLinearLabel(value)
}

export function workflowCategoryLabel(
  type: string | null | undefined
): string | null {
  const value = type?.trim()
  return value ? formatLinearLabel(value) : null
}

/**
 * Prefer Linear's own display label, then fall back to its numeric priority.
 * Unknown values remain visible instead of being silently misclassified.
 */
export function priorityLabel(
  priority: number | string | null | undefined,
  suppliedLabel?: string | null
): string | null {
  const displayLabel = suppliedLabel?.trim()
  if (displayLabel) {
    const key = normalizedKey(displayLabel)
    if (key === "nopriority" || key === "none") return "No Priority"
    return formatLinearLabel(displayLabel)
  }

  if (typeof priority === "number") {
    return PRIORITY_LABELS[priority] ?? String(priority)
  }

  const raw = priority?.trim()
  if (!raw) return null

  const numericPriority = Number(raw)
  if (Number.isInteger(numericPriority) && raw !== "") {
    return PRIORITY_LABELS[numericPriority] ?? raw
  }

  const key = normalizedKey(raw)
  if (key === "nopriority" || key === "none") return "No Priority"
  return formatLinearLabel(raw)
}

export type LinearCycleDisplay = {
  name?: string | null
  number?: number | null
}

export function cycleDisplay(
  cycle: LinearCycleDisplay | null | undefined
): string | null {
  const name = cycle?.name?.trim()
  if (name) return name
  return cycle?.number == null ? null : `Cycle ${cycle.number}`
}

/** Prefer Linear's richer document content and fall back to its description. */
export function longFormContent(
  content: unknown,
  description: string | null | undefined
): string {
  if (typeof content === "string" && content.trim()) return content
  return description?.trim() ? description : ""
}

export function dateOnly(value: string | null | undefined): string | null {
  const date = value?.trim()
  return date ? date.slice(0, 10) : null
}

export function dateTime(value: string | null | undefined): string | null {
  const date = value?.trim()
  return date || null
}

/** Include related status-update edits in the record freshness watermark. */
export function latestTimestamp(
  primary: string,
  ...candidates: Array<string | null | undefined>
): string {
  let latest = primary
  let latestTime = Date.parse(primary)

  for (const candidate of candidates) {
    const candidateValue = candidate?.trim()
    if (!candidateValue) continue

    const candidateTime = Date.parse(candidateValue)
    if (!Number.isFinite(candidateTime)) continue
    if (!Number.isFinite(latestTime) || candidateTime > latestTime) {
      latest = candidateValue
      latestTime = candidateTime
    }
  }

  return latest
}

export type LinearPersonDisplay = {
  displayName?: string | null
  name?: string | null
  email?: string | null
}

/** Resolve a related user to a human-readable value without exposing its ID. */
export function personDisplay(
  person: LinearPersonDisplay | null | undefined
): string | null {
  return (
    person?.displayName?.trim() ||
    person?.name?.trim() ||
    person?.email?.trim() ||
    null
  )
}

export type LinearStatusUpdateContent = {
  body?: string | null
  createdAt?: string | null
  url?: string | null
  user?: LinearPersonDisplay | null
}

export type LinearContributingProjectContent = {
  id: string
  name: string
  url?: string | null
  archivedAt?: string | null
  trashed?: boolean | null
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_[\]<>])/g, "\\$1")
}

function escapeMarkdownExcerpt(value: string): string {
  return value.replace(/([\\`*_[\]{}()#+\-.!>|<>])/g, "\\$1")
}

function truncateMarkdownSection(
  value: string,
  fullContentUrl: string | null | undefined,
  sectionLabel: string
): string {
  const content = value.trim()
  const characters = Array.from(content)
  if (characters.length <= MAX_PAGE_SECTION_CHARACTERS) return content

  const initialExcerpt = characters
    .slice(0, MAX_PAGE_SECTION_CHARACTERS)
    .join("")
  const earliestPreferredBreak = Math.floor(initialExcerpt.length * 0.6)
  const breakCandidates = [
    initialExcerpt.lastIndexOf("\n\n"),
    initialExcerpt.lastIndexOf("\n"),
    initialExcerpt.lastIndexOf(" "),
  ]
  const preferredBreak = breakCandidates.find(
    (index) => index >= earliestPreferredBreak
  )
  const excerpt = initialExcerpt
    .slice(0, preferredBreak ?? initialExcerpt.length)
    .trimEnd()
  const url = fullContentUrl?.trim()
  const destination = url
    ? ` [Read the full ${sectionLabel} in Linear](${url}).`
    : " Open the source record in Linear to read the full text."

  return `> This ${sectionLabel} was shortened in Notion.${destination}\n\n${escapeMarkdownExcerpt(excerpt)}`
}

function latestUpdateSection(
  update: LinearStatusUpdateContent | null | undefined
): string | null {
  if (!update) return null

  const author = personDisplay(update.user)
  const postedOn = dateOnly(update.createdAt)
  const url = update.url?.trim()
  const metadata = [
    author ? `Updated by ${escapeMarkdownText(author)}` : null,
    postedOn,
    url ? `[Open update in Linear](${url})` : null,
  ].filter((value): value is string => Boolean(value))
  const body = truncateMarkdownSection(update.body ?? "", url, "latest update")
  const parts = [
    "## Latest update",
    metadata.length > 0 ? `_${metadata.join(" · ")}_` : null,
    body || null,
  ].filter((value): value is string => Boolean(value))

  return parts.join("\n\n")
}

export function uniqueVisibleProjects<
  T extends LinearContributingProjectContent,
>(projects: T[]): T[] {
  const seenIds = new Set<string>()
  return projects.filter((project) => {
    if (project.trashed || seenIds.has(project.id)) return false
    seenIds.add(project.id)
    return true
  })
}

function contributingProjectsSection(
  projects: LinearContributingProjectContent[],
  initiativeUrl: string
): string | null {
  if (projects.length === 0) {
    return "## Contributing projects (0)\n\nNo contributing projects visible to this Linear API key."
  }

  const sortedProjects = [...projects].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
  )
  const renderedProjects = sortedProjects.slice(
    0,
    MAX_RENDERED_CONTRIBUTING_PROJECTS
  )
  const bullets = renderedProjects.map((project) => {
    const name = escapeMarkdownText(project.name.trim() || "Untitled project")
    const url = project.url?.trim()
    const label = url ? `[${name}](${url})` : name
    return `- ${label}${project.archivedAt ? " _(archived)_" : ""}`
  })
  const remaining = sortedProjects.length - renderedProjects.length
  if (remaining > 0) {
    const url = initiativeUrl.trim()
    const suffix = url
      ? `[View all projects in Linear](${url}).`
      : "Open the Initiative in Linear to view them."
    bullets.push(`- _…and ${remaining} more. ${suffix}_`)
  }

  return `## Contributing projects (${projects.length})\n\n${bullets.join("\n")}`
}

export function resourcePageContent(options: {
  overview: string
  overviewHeading: "Project overview" | "Initiative overview"
  resourceUrl: string
  latestUpdate?: LinearStatusUpdateContent | null
  contributingProjects?: LinearContributingProjectContent[]
}): string {
  const sections: string[] = []
  const update = latestUpdateSection(options.latestUpdate)
  if (update) sections.push(update)

  if (options.contributingProjects) {
    const projects = contributingProjectsSection(
      options.contributingProjects,
      options.resourceUrl
    )
    if (projects) sections.push(projects)
  }

  const overview = truncateMarkdownSection(
    options.overview,
    options.resourceUrl,
    options.overviewHeading.toLowerCase()
  )
  if (overview) {
    sections.push(`## ${options.overviewHeading}\n\n${overview}`)
  }

  return sections.join("\n\n")
}
