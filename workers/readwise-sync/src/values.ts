import * as Builder from "@notionhq/workers/builder"

export const MAX_TEXT_PROPERTY_CHARACTERS = 1_900
export const MAX_TITLE_CHARACTERS = 240
export const MAX_MULTI_SELECT_OPTIONS = 100
export const MAX_SELECT_NAME_CHARACTERS = 100

export function trimmed(value: string | null | undefined): string | undefined {
  const result = value?.trim()
  return result || undefined
}

export function boundedText(
  value: string | null | undefined,
  maximum = MAX_TEXT_PROPERTY_CHARACTERS
): string | undefined {
  const text = trimmed(value)
  if (!text) return undefined
  const characters = [...text]
  if (characters.length <= maximum) return text
  return `${characters.slice(0, Math.max(0, maximum - 1)).join("")}…`
}

export function displayTitle(
  value: string | null | undefined,
  fallback: string
): string {
  const normalized = (trimmed(value) ?? fallback).replace(/\s+/g, " ")
  return boundedText(normalized, MAX_TITLE_CHARACTERS) ?? fallback
}

export function selectName(
  value: string | null | undefined
): string | undefined {
  return boundedText(value, MAX_SELECT_NAME_CHARACTERS)
}

export function uniqueSelectNames(values: Array<string | null | undefined>) {
  const names = values
    .map((value) =>
      trimmed(value)
        ?.normalize("NFKC")
        .replace(/\s+/gu, " ")
        // The current Worker builder joins multi-select values with commas.
        .replace(/,/gu, "，")
    )
    .filter((value): value is string => Boolean(value))
  for (const name of names) {
    if ([...name].length > MAX_SELECT_NAME_CHARACTERS) {
      throw new Error(
        `Readwise tag names cannot exceed ${MAX_SELECT_NAME_CHARACTERS} characters in Notion.`
      )
    }
  }
  const unique = [...new Set(names)].sort((left, right) =>
    left.localeCompare(right)
  )
  if (unique.length > MAX_MULTI_SELECT_OPTIONS) {
    throw new Error(
      `Readwise records cannot sync more than ${MAX_MULTI_SELECT_OPTIONS} unique tags without loss.`
    )
  }
  return unique
}

export function readerTagNames(
  value: Record<string, { name: string }>
): string[] {
  return uniqueSelectNames(Object.values(value).map((tag) => tag.name))
}

export function validUrl(value: string | null | undefined): string | undefined {
  const candidate = trimmed(value)
  if (!candidate || candidate.length > 2_000) return undefined
  try {
    const url = new URL(candidate)
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : undefined
  } catch {
    return undefined
  }
}

export function validDate(
  value: string | null | undefined
): string | undefined {
  const candidate = trimmed(value)
  if (!candidate || !Number.isFinite(Date.parse(candidate))) return undefined
  return candidate
}

export function dateValue(value: string | null | undefined) {
  const candidate = validDate(value)
  if (!candidate) return []
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate)
    ? Builder.date(candidate)
    : Builder.dateTime(new Date(candidate).toISOString())
}

export function normalizedCategory(
  value: string | null | undefined
): string | undefined {
  const category = selectName(value)?.toLowerCase()
  if (!category) return undefined
  const singular: Record<string, string> = {
    articles: "article",
    books: "book",
    emails: "email",
    podcasts: "podcast",
    tweets: "tweet",
  }
  return singular[category] ?? category
}

const DISPLAY_ACRONYMS: Record<string, string> = {
  api: "API",
  epub: "EPUB",
  pdf: "PDF",
  rss: "RSS",
  url: "URL",
}

export function displayLabel(
  value: string | null | undefined
): string | undefined {
  const normalized = trimmed(value)
  if (!normalized) return undefined
  const display = normalized
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase()
      return DISPLAY_ACRONYMS[lower] ?? lower[0].toUpperCase() + lower.slice(1)
    })
    .join(" ")
  return selectName(display)
}

export function sourceName(value: string | null | undefined): string {
  const source = trimmed(value)
  if (!source) return "Readwise"
  if (source.toLowerCase() === "reader") return "Reader"
  return displayLabel(source) ?? "Readwise"
}
