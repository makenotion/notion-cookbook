import { createHash } from "node:crypto"

export const NOTION_TEXT_LIMIT = 2_000
export const NOTION_OPTION_LIMIT = 100
export const NOTION_MULTI_SELECT_LIMIT = 100

export function boundedText(value: string): string {
  const characters = Array.from(value)
  if (characters.length <= NOTION_TEXT_LIMIT) return value
  return `${characters.slice(0, NOTION_TEXT_LIMIT - 1).join("")}…`
}

export function textWasTruncated(value: string): boolean {
  return Array.from(value).length > NOTION_TEXT_LIMIT
}

export function displayLabel(value: string): string {
  if (!value) return value
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function highlightTitle(text: string, fallback: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim() || fallback.trim()
  if (!singleLine) return "Untitled highlight"
  const characters = Array.from(singleLine)
  if (characters.length <= 120) return singleLine
  return `${characters.slice(0, 119).join("")}…`
}

export function optionNames(property: string, values: string[]): string[] {
  const names = values
    .map((value) => optionName(value))
    .filter((value): value is string => value !== undefined)
    .sort(
      (left, right) =>
        left.localeCompare(right, "en-US", { sensitivity: "base" }) ||
        (left < right ? -1 : left > right ? 1 : 0)
    )
  const unique = new Map<string, string>()
  for (const name of names) {
    const identity = name.toLocaleLowerCase("en-US")
    if (!unique.has(identity)) unique.set(identity, name)
  }

  const result = [...unique.values()]
  if (result.length > NOTION_MULTI_SELECT_LIMIT) {
    throw new Error(
      `Raindrop.io ${property} produced ${result.length} values; this Worker supports at most ${NOTION_MULTI_SELECT_LIMIT}.`
    )
  }
  return result
}

function optionName(value: string): string | undefined {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    // The current Worker builder serializes multi-select options with commas.
    .replace(/,/gu, "，")
  if (!normalized) return undefined

  const characters = Array.from(normalized)
  if (characters.length <= NOTION_OPTION_LIMIT) return normalized

  const digest = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 8)
  const suffix = `… ${digest}`
  const prefixLength = NOTION_OPTION_LIMIT - Array.from(suffix).length
  return `${characters.slice(0, prefixLength).join("")}${suffix}`
}
