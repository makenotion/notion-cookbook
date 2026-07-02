// Shared display and page-content helpers for PagerDuty resource transforms.
// Keep API identifiers out of visible labels: references are useful to a
// Notion user only when PagerDuty supplied a human-readable summary or name.

import type {
  PagerDutyIncident,
  PagerDutyReference,
  PagerDutyService,
  PagerDutySupportHours,
} from "./pagerduty.js"

export const MAX_DETAIL_CHARACTERS = 12_000
export const MAX_PAGE_CONTENT_CHARACTERS = 40_000
export const MAX_RICH_TEXT_CHARACTERS = 2_000

const MAX_TEXT_CHARACTERS = 8_000
const MAX_DETAIL_DEPTH = 8
const MAX_DETAIL_ITEMS = 100
const MAX_CONTEXTS = 25
const MAX_CONTEXT_LABEL_CHARACTERS = 300
const REDACTED_VALUE = "[REDACTED]"
const ACRONYM_LABELS: Record<string, string> = {
  api: "API",
  sms: "SMS",
}

/** Turn PagerDuty enum values such as `direct_assignment` into title case. */
export function humanizeEnum(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null

  const acronym = ACRONYM_LABELS[trimmed.toLowerCase()]
  if (acronym) return acronym

  const normalized = trimmed
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")

  return normalized.replace(/\b\w/g, (character) => character.toUpperCase())
}

/** Resolve a visible reference label without falling back to an opaque ID. */
export function referenceName(
  reference: PagerDutyReference | null | undefined
): string | null {
  return reference?.summary?.trim() || reference?.name?.trim() || null
}

/** Trim, omit, and de-duplicate human-readable labels while preserving order. */
export function uniqueNames(
  values: ReadonlyArray<string | null | undefined> | null | undefined
): string[] {
  const names: string[] = []
  const seen = new Set<string>()

  for (const value of values ?? []) {
    const name = value?.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }

  return names
}

export function referenceNames(
  references:
    | ReadonlyArray<PagerDutyReference | null | undefined>
    | null
    | undefined
): string[] {
  return uniqueNames((references ?? []).map(referenceName))
}

export function dateTime(value: string | null | undefined): string | null {
  return value?.trim() || null
}

export type PendingAutomaticAction = {
  type?: string | null
  at?: string | null
  to?: string | null
}

export type NextAutomaticAction = {
  label: string
  at: string
}

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * Select the chronologically next pending action. PagerDuty does not promise
 * the array is ordered, so action type and destination break timestamp ties.
 */
export function nextAutomaticAction(
  actions: ReadonlyArray<PendingAutomaticAction> | null | undefined
): NextAutomaticAction | null {
  const candidates = (actions ?? []).flatMap((action) => {
    const type = action.type?.trim()
    const at = dateTime(action.at)
    const atMilliseconds = at ? Date.parse(at) : Number.NaN
    if (!type || !at || !Number.isFinite(atMilliseconds)) return []

    return [
      {
        type,
        at,
        atMilliseconds,
        to: action.to?.trim() ?? "",
      },
    ]
  })

  candidates.sort(
    (left, right) =>
      left.atMilliseconds - right.atMilliseconds ||
      compareText(left.type, right.type) ||
      compareText(left.to, right.to) ||
      compareText(left.at, right.at)
  )

  const next = candidates[0]
  if (!next) return null

  const action = humanizeEnum(next.type)
  if (!action) return null
  const destination = humanizeEnum(next.to)

  return {
    label:
      next.type === "urgency_change" && destination
        ? `${action} to ${destination}`
        : action,
    at: next.at,
  }
}

/** Return an elapsed duration rounded to one decimal minute. */
export function durationMinutes(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined
): number | null {
  const start = startedAt ? Date.parse(startedAt) : Number.NaN
  const end = endedAt ? Date.parse(endedAt) : Number.NaN
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null
  }

  return Math.round(((end - start) / 60_000) * 10) / 10
}

/** Return the latest valid API timestamp, or null when none was supplied. */
export function latestDateTime(
  values: ReadonlyArray<string | null | undefined> | null | undefined
): string | null {
  let latest: string | null = null
  let latestMilliseconds = Number.NEGATIVE_INFINITY

  for (const value of values ?? []) {
    const timestamp = dateTime(value)
    if (!timestamp) continue

    const milliseconds = Date.parse(timestamp)
    if (!Number.isFinite(milliseconds) || milliseconds <= latestMilliseconds) {
      continue
    }

    latest = timestamp
    latestMilliseconds = milliseconds
  }

  return latest
}

/** PagerDuty stores service timeouts in seconds; Notion shows useful minutes. */
export function positiveMinutes(
  seconds: number | null | undefined
): number | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? seconds / 60
    : null
}

/** Describe both constant and support-hours urgency rules in one short label. */
export function urgencyRuleLabel(
  rule: PagerDutyService["incident_urgency_rule"]
): string | null {
  if (!rule) return null

  if (rule.type === "constant") {
    const urgency = humanizeEnum(rule.urgency)
    return urgency ? `Always ${urgency}` : "Constant"
  }

  if (rule.type === "use_support_hours") {
    const during = humanizeEnum(rule.during_support_hours?.urgency)
    const outside = humanizeEnum(rule.outside_support_hours?.urgency)

    if (during && outside) {
      return `${during} During Support Hours / ${outside} Outside`
    }
    if (during) return `${during} During Support Hours`
    if (outside) return `${outside} Outside Support Hours`
    return "Support Hours"
  }

  return humanizeEnum(rule.type)
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

function supportDaysLabel(
  values: ReadonlyArray<number | null> | null | undefined
): string | null {
  const days = [
    ...new Set(
      (values ?? []).filter(
        (value): value is number =>
          typeof value === "number" &&
          Number.isInteger(value) &&
          value >= 1 &&
          value <= 7
      )
    ),
  ].sort((left, right) => left - right)
  if (days.length === 0) return null

  const ranges: Array<{ start: number; end: number }> = []
  for (const day of days) {
    const current = ranges.at(-1)
    if (current && day === current.end + 1) {
      current.end = day
    } else {
      ranges.push({ start: day, end: day })
    }
  }

  return ranges
    .map(({ start, end }) => {
      const startLabel = WEEKDAY_LABELS[start - 1]
      const endLabel = WEEKDAY_LABELS[end - 1]
      return start === end ? startLabel : `${startLabel}–${endLabel}`
    })
    .join(", ")
}

function supportTime(value: string | null | undefined): string | null {
  const time = value?.trim()
  if (!time) return null
  const match = /^(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(time)
  return match?.[1] ?? time
}

/** Render PagerDuty's fixed daily support window as one compact label. */
export function supportHoursLabel(
  supportHours: PagerDutySupportHours | null | undefined
): string | null {
  if (!supportHours) return null

  const days = supportDaysLabel(supportHours.days_of_week)
  const start = supportTime(supportHours.start_time)
  const end = supportTime(supportHours.end_time)
  const time = start && end ? `${start}–${end}` : (start ?? end)
  const timeZone = supportHours.time_zone?.trim() || null
  const details = [days, time].filter((value): value is string =>
    Boolean(value)
  )

  if (details.length > 0) {
    const window = details.join(" ")
    return timeZone ? `${window} (${timeZone})` : window
  }

  const type = humanizeEnum(supportHours.type)
  return timeZone ? `${type ?? "Support Hours"} (${timeZone})` : type
}

function isSensitiveDetailKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "")
  return (
    normalized.endsWith("servicekey") ||
    normalized.endsWith("routingkey") ||
    normalized.endsWith("integrationkey") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("authorization") ||
    normalized.endsWith("credential") ||
    normalized.endsWith("credentials") ||
    normalized.endsWith("headers") ||
    normalized.endsWith("cookie") ||
    normalized.endsWith("cookies") ||
    normalized.endsWith("auth") ||
    normalized.endsWith("password") ||
    normalized.endsWith("passwd") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("signature") ||
    normalized === "sig" ||
    normalized.endsWith("token")
  )
}

function boundedString(value: string, limit: number): string {
  const characters = Array.from(value.trim())
  if (characters.length <= limit) return characters.join("")

  const marker = Array.from("\n… [truncated]")
  const contentLength = Math.max(0, limit - marker.length)
  return [...characters.slice(0, contentLength), ...marker]
    .slice(0, limit)
    .join("")
}

/** Trim and cap plain API text before passing it to a Notion builder. */
export function boundedText(
  value: string | null | undefined,
  limit = MAX_TEXT_CHARACTERS
): string | null {
  const text = value?.trim()
  return text ? boundedString(text, limit) : null
}

/**
 * Clone JSON-like details while redacting common credential fields and
 * bounding pathological depth/width. API data is expected to be JSON, but the
 * defensive cases keep this helper safe and reusable in unit tests.
 */
function safeDetailValue(
  value: unknown,
  depth: number,
  ancestors: Set<object>
): unknown {
  if (
    value == null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value
  }
  if (typeof value === "string") {
    return boundedString(value, MAX_TEXT_CHARACTERS)
  }
  if (typeof value === "bigint") return value.toString()
  if (typeof value !== "object") return String(value)
  if (ancestors.has(value)) return "[Circular value omitted]"
  if (depth >= MAX_DETAIL_DEPTH) return "[Maximum depth reached]"

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const items = value
        .slice(0, MAX_DETAIL_ITEMS)
        .map((item) => safeDetailValue(item, depth + 1, ancestors))
      if (value.length > MAX_DETAIL_ITEMS) {
        items.push(`[${value.length - MAX_DETAIL_ITEMS} more items omitted]`)
      }
      return items
    }

    const result: Record<string, unknown> = {}
    const entries = Object.entries(value)
    for (const [key, item] of entries.slice(0, MAX_DETAIL_ITEMS)) {
      result[key] = isSensitiveDetailKey(key)
        ? REDACTED_VALUE
        : safeDetailValue(item, depth + 1, ancestors)
    }
    if (entries.length > MAX_DETAIL_ITEMS) {
      result._omitted_fields = entries.length - MAX_DETAIL_ITEMS
    }
    return result
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Serialize arbitrary details as valid, bounded JSON. Triple backticks are
 * escaped so a value cannot terminate the surrounding Markdown code fence.
 */
export function boundedSafeJson(value: unknown): string | null {
  if (value == null) return null
  if (Array.isArray(value) && value.length === 0) return null
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  ) {
    return null
  }

  const safeValue = safeDetailValue(value, 0, new Set<object>())
  const serialized = JSON.stringify(safeValue, null, 2)?.replace(
    /```/g,
    "\\u0060\\u0060\\u0060"
  )
  if (!serialized) return null
  if (serialized.length <= MAX_DETAIL_CHARACTERS) return serialized

  // The preview is itself JSON-encoded, keeping the shortened block valid.
  let previewLength = Math.floor(MAX_DETAIL_CHARACTERS / 2)
  while (previewLength > 0) {
    const shortened = JSON.stringify(
      {
        _truncated: true,
        _message: "Details exceeded the Notion page preview limit.",
        preview: serialized.slice(0, previewLength),
      },
      null,
      2
    ).replace(/```/g, "\\u0060\\u0060\\u0060")

    if (shortened.length <= MAX_DETAIL_CHARACTERS) return shortened
    previewLength = Math.floor(previewLength * 0.75)
  }

  return '{"_truncated":true}'
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_[\]{}()#+\-.!|<>])/g, "\\$1")
}

function prose(
  value: string | null | undefined,
  limit = MAX_TEXT_CHARACTERS
): string | null {
  const text = boundedText(value, limit)
  return text ? escapeMarkdownText(text) : null
}

/** Render provider-authored plain text without letting it create Markdown. */
export function plainTextPageContent(
  value: string | null | undefined
): string | null {
  return prose(value, MAX_PAGE_CONTENT_CHARACTERS - 100)
}

export function safeWebUrl(value: string | null | undefined): string | null {
  const candidate = value?.trim()
  if (!candidate) return null

  try {
    const url = new URL(candidate)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    if (url.username || url.password) return null
    if ([...url.searchParams.keys()].some(isSensitiveDetailKey)) return null
    if (url.hash) {
      let fragment = url.hash.slice(1)
      try {
        for (let pass = 0; pass < 3; pass++) {
          const decoded = decodeURIComponent(fragment)
          if (decoded === fragment) break
          fragment = decoded
        }
      } catch {
        return null
      }
      const queryStart = fragment.indexOf("?")
      const fragmentParams = new URLSearchParams(
        queryStart >= 0 ? fragment.slice(queryStart + 1) : fragment
      )
      if ([...fragmentParams.keys()].some(isSensitiveDetailKey)) return null
    }
    return url.toString()
  } catch {
    return null
  }
}

function plainTextFromHtml(value: string): string {
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
}

function boundedPageSections(sections: string[]): string {
  const rendered: string[] = []
  const marker =
    "> Additional source detail was omitted to keep this incident page bounded."

  for (const section of sections) {
    const candidate = [...rendered, section].join("\n\n")
    if (candidate.length <= MAX_PAGE_CONTENT_CHARACTERS) {
      rendered.push(section)
      continue
    }

    if (
      [...rendered, marker].join("\n\n").length <= MAX_PAGE_CONTENT_CHARACTERS
    ) {
      rendered.push(marker)
    }
    break
  }

  return rendered.join("\n\n")
}

/**
 * Render only explicitly descriptive incident detail PagerDuty embeds in the
 * list response. Arbitrary channel and incident detail objects are intentionally
 * excluded from default page content because they can contain integration keys,
 * credentials, or provider-specific sensitive data.
 */
export function incidentPageContent(
  incident: Pick<PagerDutyIncident, "first_trigger_log_entry">
): string {
  const trigger = incident.first_trigger_log_entry
  const channel = trigger?.channel
  const channelTypeValue = channel?.type?.trim().toLowerCase()
  const sections: string[] = []

  const eventDescription = prose(trigger?.event_details?.description)
  const channelDescription = prose(channel?.description)
  const descriptions = uniqueNames([
    eventDescription,
    channelDescription === eventDescription ? null : channelDescription,
  ])

  if (descriptions.length > 0) {
    sections.push(["## Trigger", ...descriptions].join("\n\n"))
  }

  // Email body is the only channel-specific message field copied by default.
  // `details` remains excluded for every channel, including web triggers.
  const contentTypeValue = channel?.body_content_type?.trim()
  const channelMessageValue =
    channelTypeValue === "email" ? channel?.body : null
  const channelMessageValueAsText =
    channelMessageValue && contentTypeValue?.toLowerCase().includes("html")
      ? plainTextFromHtml(
          boundedString(channelMessageValue, MAX_TEXT_CHARACTERS)
        )
      : channelMessageValue
  const channelMessage = prose(channelMessageValueAsText)
  if (channelMessage) {
    sections.push(["## Trigger message", channelMessage].join("\n\n"))
  }

  const contexts = trigger?.contexts ?? []
  const contextLines = uniqueNames(
    contexts.slice(0, MAX_CONTEXTS).map((context) => {
      const label =
        prose(context.text, MAX_CONTEXT_LABEL_CHARACTERS) ??
        (context.type === "image" ? "Related image" : "Related link")
      const url = safeWebUrl(context.href) ?? safeWebUrl(context.src)
      return url ? `- [${label}](<${url}>)` : label ? `- ${label}` : null
    })
  )
  if (contexts.length > MAX_CONTEXTS) {
    contextLines.push(
      `- _… ${contexts.length - MAX_CONTEXTS} additional contexts omitted._`
    )
  }
  if (contextLines.length > 0) {
    sections.push(`## Context\n\n${contextLines.join("\n")}`)
  }

  return boundedPageSections(sections)
}
