import { createHash } from "node:crypto"

export const NOTION_TEXT_LIMIT = 2_000
export const NOTION_OPTION_LIMIT = 100
export const NOTION_MULTI_SELECT_LIMIT = 100
export const TAG_OVERFLOW_SENTINEL = "⚠ More tags omitted"

function fitsWithinLimit(value: string, limit: number): boolean {
  return value.length <= limit && Array.from(value).length <= limit
}

function withBoundedSuffix(
  value: string,
  limit: number,
  suffix: string
): string {
  const suffixCharacters = Array.from(suffix).length
  let prefix = ""
  let prefixCharacters = 0
  for (const character of value) {
    if (
      prefix.length + character.length + suffix.length > limit ||
      prefixCharacters + 1 + suffixCharacters > limit
    ) {
      break
    }
    prefix += character
    prefixCharacters += 1
  }
  return `${prefix}${suffix}`
}

export function boundedText(value: string): string {
  if (fitsWithinLimit(value, NOTION_TEXT_LIMIT)) return value
  return withBoundedSuffix(value, NOTION_TEXT_LIMIT, "…")
}

export function textWasTruncated(value: string): boolean {
  return !fitsWithinLimit(value, NOTION_TEXT_LIMIT)
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

export function optionNames(values: string[]): string[] {
  const candidatesBySource = new Map<
    string,
    { baseName: string; sourceIdentity: string }
  >()
  for (const value of values) {
    const baseName = optionName(value)
    if (!baseName) continue

    const sourceIdentity = sourceOptionIdentity(value)
    const existing = candidatesBySource.get(sourceIdentity)
    if (!existing || compareOptionNames(baseName, existing.baseName) < 0) {
      candidatesBySource.set(sourceIdentity, { baseName, sourceIdentity })
    }
  }

  const candidates = [...candidatesBySource.values()].sort(
    (left, right) =>
      compareOptionNames(left.baseName, right.baseName) ||
      compareOptionNames(left.sourceIdentity, right.sourceIdentity)
  )
  const candidatesByOption = new Map<
    string,
    Array<(typeof candidates)[number]>
  >()
  for (const candidate of candidates) {
    const identity = optionIdentity(candidate.baseName)
    const group = candidatesByOption.get(identity)
    if (group) group.push(candidate)
    else candidatesByOption.set(identity, [candidate])
  }

  // Reserve every natural option name before disambiguating collisions so a
  // generated suffix can never take the name of another source tag.
  const usedOptionIdentities = new Set(candidatesByOption.keys())
  const result: string[] = []
  for (const group of candidatesByOption.values()) {
    result.push(group[0].baseName)
    for (const candidate of group.slice(1)) {
      let attempt = 0
      let name: string
      do {
        name = optionNameWithIdentitySuffix(
          candidate.baseName,
          candidate.sourceIdentity,
          attempt
        )
        attempt += 1
      } while (usedOptionIdentities.has(optionIdentity(name)))
      usedOptionIdentities.add(optionIdentity(name))
      result.push(name)
    }
  }

  const sorted = result.sort(compareOptionNames)
  if (sorted.length <= NOTION_MULTI_SELECT_LIMIT) return sorted

  const retained = sorted
    .filter(
      (name) => optionIdentity(name) !== optionIdentity(TAG_OVERFLOW_SENTINEL)
    )
    .slice(0, NOTION_MULTI_SELECT_LIMIT - 1)
  return [...retained, TAG_OVERFLOW_SENTINEL].sort(compareOptionNames)
}

function compareOptionNames(left: string, right: string): number {
  return (
    left.localeCompare(right, "en-US", { sensitivity: "base" }) ||
    (left < right ? -1 : left > right ? 1 : 0)
  )
}

function sourceOptionIdentity(value: string): string {
  return value
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US")
}

function optionIdentity(value: string): string {
  return value.toLocaleLowerCase("en-US")
}

function optionNameWithIdentitySuffix(
  baseName: string,
  sourceIdentity: string,
  attempt: number
): string {
  const digest = createHash("sha256").update(sourceIdentity).digest("hex")
  const discriminator =
    attempt === 0
      ? digest.slice(0, 12)
      : `${digest.slice(0, 12)}-${attempt + 1}`
  const suffix = ` … ${discriminator}`
  return withBoundedSuffix(baseName, NOTION_OPTION_LIMIT, suffix)
}

function optionName(value: string): string | undefined {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    // The current Worker builder serializes multi-select options with commas.
    .replace(/,/gu, "，")
  if (!normalized) return undefined

  if (fitsWithinLimit(normalized, NOTION_OPTION_LIMIT)) return normalized

  const digest = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 8)
  const suffix = `… ${digest}`
  return withBoundedSuffix(normalized, NOTION_OPTION_LIMIT, suffix)
}
