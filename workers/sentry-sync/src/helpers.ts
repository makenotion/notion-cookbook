const MAX_TITLE_CHARACTERS = 2_000
const MAX_PROPERTY_CHARACTERS = 2_000
const MAX_SELECT_CHARACTERS = 100

function unicodeSlice(value: string, limit: number): string {
  const characters = Array.from(value)
  if (characters.length <= limit) return value
  return `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`
}

export function titleText(
  value: string | null | undefined,
  fallback: string
): string {
  const text = value?.trim() || fallback
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
