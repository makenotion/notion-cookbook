import { createHash } from "node:crypto"

import * as Builder from "@notionhq/workers/builder"

export const MAX_TEXT_PROPERTY_CHARACTERS = 1_900
export const MAX_TITLE_CHARACTERS = 240
export const MAX_MULTI_SELECT_OPTIONS = 100
export const MAX_SELECT_NAME_CHARACTERS = 100
export const TAG_HASH_HEX_CHARACTERS = 12
export const TAG_OVERFLOW_SENTINEL = "⚠ More tags omitted"

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

function boundedTagName(value: string): string {
  const characters = [...value]
  if (
    characters.length <= MAX_SELECT_NAME_CHARACTERS &&
    value.length <= MAX_SELECT_NAME_CHARACTERS
  ) {
    return value
  }

  const hash = createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, TAG_HASH_HEX_CHARACTERS)
  const suffix = `…#${hash}`
  const prefixBudget = MAX_SELECT_NAME_CHARACTERS - suffix.length
  let prefix = ""
  for (const character of characters) {
    if (prefix.length + character.length > prefixBudget) break
    prefix += character
  }
  return `${prefix}${suffix}`
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
    .map(boundedTagName)
  const unique = [...new Set(names)].sort((left, right) =>
    left.localeCompare(right)
  )
  if (unique.length <= MAX_MULTI_SELECT_OPTIONS) return unique

  const retained = unique
    .filter((name) => name !== TAG_OVERFLOW_SENTINEL)
    .slice(0, MAX_MULTI_SELECT_OPTIONS - 1)
  return [...retained, TAG_OVERFLOW_SENTINEL].sort((left, right) =>
    left.localeCompare(right)
  )
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
    supplementals: "supplemental",
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
