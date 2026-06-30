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
  candidate: string | null | undefined
): string {
  const candidateValue = candidate?.trim()
  if (!candidateValue) return primary

  const primaryTime = Date.parse(primary)
  const candidateTime = Date.parse(candidateValue)
  if (!Number.isFinite(candidateTime)) return primary
  return !Number.isFinite(primaryTime) || candidateTime > primaryTime
    ? candidateValue
    : primary
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
