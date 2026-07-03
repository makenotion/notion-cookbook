// Shared, deterministic transforms for Todoist values before they reach a
// managed Notion database.

import { createHash } from "node:crypto"

import * as Builder from "@notionhq/workers/builder"

export const MAX_RICH_TEXT_CHARACTERS = 2_000
export const MAX_OPTION_NAME_CHARACTERS = 100
export const MAX_MULTI_SELECT_OPTIONS = 100

export function boundedText(
  value: string | null | undefined,
  maximum = MAX_RICH_TEXT_CHARACTERS
): string | null {
  const normalized = value?.trim()
  if (!normalized) return null

  const characters = Array.from(normalized)
  return characters.length <= maximum
    ? normalized
    : characters.slice(0, maximum).join("")
}

export function textWasTruncated(
  value: string | null | undefined,
  maximum = MAX_RICH_TEXT_CHARACTERS
): boolean {
  const normalized = value?.trim()
  return Boolean(normalized && Array.from(normalized).length > maximum)
}

/** Make provider-authored values safe and deterministic as Notion options. */
export function optionLabel(value: string | null | undefined): string | null {
  const normalized = value?.normalize("NFKC").trim().replace(/\s+/gu, " ")
  if (!normalized) return null

  // ASCII commas delimit multi-select values in the Worker builder.
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

export function optionLabels(
  property: string,
  values: ReadonlyArray<string | null | undefined> | null | undefined
): string[] {
  const normalized = (values ?? [])
    .map(optionLabel)
    .filter((value): value is string => value !== null)
    .sort(
      (left, right) =>
        left.localeCompare(right, "en-US", { sensitivity: "base" }) ||
        (left < right ? -1 : left > right ? 1 : 0)
    )
  const unique = new Map<string, string>()

  for (const value of normalized) {
    const identity = value.toLocaleLowerCase("en-US")
    if (!unique.has(identity)) unique.set(identity, value)
  }

  const result = [...unique.values()]
  if (result.length > MAX_MULTI_SELECT_OPTIONS) {
    throw new Error(
      `Todoist ${property} produced ${result.length} values; Notion supports at most ${MAX_MULTI_SELECT_OPTIONS}.`
    )
  }
  return result
}

export function humanize(value: string | null | undefined): string | null {
  const normalized = value
    ?.trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
  return normalized
    ? normalized.replace(/\b\w/g, (character) => character.toUpperCase())
    : null
}

export function dateProperty(
  value: string | null | undefined,
  field: string,
  timeZone?: string | null
) {
  const date = value?.trim()
  if (!date) return []

  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    if (!Number.isFinite(Date.parse(`${date}T00:00:00Z`))) {
      throw new Error(`Todoist ${field} is not a valid date.`)
    }
    return Builder.date(date)
  }

  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(date)) {
    throw new Error(`Todoist ${field} is not a valid ISO 8601 timestamp.`)
  }

  const isAbsolute = /(Z|[+-]\d{2}:\d{2})$/i.test(date)
  const milliseconds = Date.parse(isAbsolute ? date : `${date}Z`)
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Todoist ${field} is not a valid ISO 8601 timestamp.`)
  }

  // Never attach a timezone to an already-offset timestamp. Normalize it
  // first so the value represents the same instant in every Worker runtime.
  if (isAbsolute) {
    return Builder.dateTime(new Date(milliseconds).toISOString(), "UTC")
  }

  const zone = timeZone?.trim()
  return Builder.dateTime(date, zone || undefined)
}

export function latestTimestamp(
  ...values: Array<string | null | undefined>
): string | undefined {
  let latest: string | undefined
  let latestMs = Number.NEGATIVE_INFINITY

  for (const candidate of values) {
    const value = candidate?.trim()
    const milliseconds = value ? Date.parse(value) : Number.NaN
    if (Number.isFinite(milliseconds) && milliseconds > latestMs) {
      latest = value
      latestMs = milliseconds
    }
  }
  return latest
}

export function durationMinutes(
  duration: { amount: number; unit: string } | null | undefined
): number | null {
  if (!duration || !Number.isFinite(duration.amount) || duration.amount < 0) {
    return null
  }

  switch (duration.unit.trim().toLowerCase()) {
    case "minute":
    case "minutes":
      return duration.amount
    case "hour":
    case "hours":
      return duration.amount * 60
    case "day":
    case "days":
      return duration.amount * 24 * 60
    default:
      return null
  }
}

export function elapsedDays(
  start: string | null | undefined,
  end: string | null | undefined
): number | null {
  const startMs = start ? Date.parse(start) : Number.NaN
  const endMs = end ? Date.parse(end) : Number.NaN
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return null
  }
  return Math.round(((endMs - startMs) / 86_400_000) * 100) / 100
}

export function todoistTaskUrl(taskId: string): string {
  return `https://app.todoist.com/app/task/${encodeURIComponent(taskId)}`
}
