// Shared display and page-content helpers for PagerDuty resource transforms.
// Keep API identifiers out of visible labels: references are useful to a
// Notion user only when PagerDuty supplied a human-readable summary or name.

import { createHash } from "node:crypto"

import type {
  PagerDutyIncident,
  PagerDutyReference,
  PagerDutyService,
  PagerDutySupportHours,
} from "./pagerduty.js"

export const MAX_PAGE_CONTENT_CHARACTERS = 40_000
export const MAX_RICH_TEXT_CHARACTERS = 2_000
export const MAX_MULTI_SELECT_OPTIONS = 100
export const MAX_OPTION_NAME_CHARACTERS = 100
export const MAX_URL_CHARACTERS = 2_000

const MAX_TEXT_CHARACTERS = 8_000
const MAX_CONTEXTS = 25
const MAX_CONTEXT_LABEL_CHARACTERS = 300
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

/**
 * Normalize provider-authored option labels before they reach a Notion
 * select. ASCII commas are not valid option-name characters in Notion.
 */
export function providerOptionLabel(
  value: string | null | undefined
): string | null {
  const normalized = value?.normalize("NFKC").trim().replace(/\s+/gu, " ")
  if (!normalized) return null

  // A full-width comma remains readable without colliding with a provider
  // label that already uses a middle dot.
  const safe = normalized.replace(/,/gu, "，")
  const characters = Array.from(safe)
  if (characters.length <= MAX_OPTION_NAME_CHARACTERS) return safe

  const digest = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 8)
  const suffix = `… ${digest}`
  const prefixLength = MAX_OPTION_NAME_CHARACTERS - Array.from(suffix).length

  return `${characters.slice(0, prefixLength).join("")}${suffix}`
}

/**
 * Produce one deterministic, Notion-safe option list. De-duplicate using
 * Notion's case-insensitive option identity and fail rather than silently
 * discard operational data above the per-value multi-select limit.
 */
export function providerOptionLabels(
  property: string,
  values: ReadonlyArray<string | null | undefined> | null | undefined
): string[] {
  const candidates = (values ?? [])
    .map(providerOptionLabel)
    .filter((label): label is string => label !== null)
    .sort(
      (left, right) =>
        left.localeCompare(right, "en-US", { sensitivity: "base" }) ||
        (left < right ? -1 : left > right ? 1 : 0)
    )
  const unique = new Map<string, string>()

  for (const label of candidates) {
    const identity = label.toLocaleLowerCase("en-US")
    if (!unique.has(identity)) unique.set(identity, label)
  }

  const labels = [...unique.values()]

  if (labels.length > MAX_MULTI_SELECT_OPTIONS) {
    throw new Error(
      `PagerDuty ${property} produced ${labels.length} unique values; Notion supports at most ${MAX_MULTI_SELECT_OPTIONS} options in one multi-select value.`
    )
  }

  return labels
}

export function referenceOptionName(
  reference: PagerDutyReference | null | undefined
): string | null {
  return providerOptionLabel(referenceName(reference))
}

export function referenceOptionNames(
  property: string,
  references:
    | ReadonlyArray<PagerDutyReference | null | undefined>
    | null
    | undefined
): string[] {
  return providerOptionLabels(property, (references ?? []).map(referenceName))
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

function isSensitiveUrlParameter(key: string): boolean {
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
    if ([...url.searchParams.keys()].some(isSensitiveUrlParameter)) return null
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
      if ([...fragmentParams.keys()].some(isSensitiveUrlParameter)) return null
    }
    const normalized = url.toString()
    return normalized.length <= MAX_URL_CHARACTERS ? normalized : null
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
