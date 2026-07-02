const MAX_HTML_INPUT_LENGTH = 100_000
const MAX_PAGE_TEXT_LENGTH = 20_000

export function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function unixSecondsToIso(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${label} must be a non-negative Unix timestamp in seconds.`
    )
  }

  const date = new Date(value * 1_000)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be a valid Unix timestamp in seconds.`)
  }
  return date.toISOString()
}

export function optionalUnixSecondsToIso(
  value: number | null | undefined,
  label: string
): string | undefined {
  return value == null || value === 0
    ? undefined
    : unixSecondsToIso(value, label)
}

export function secondsToMinutes(
  value: number | null | undefined
): number | undefined {
  if (value == null || !Number.isFinite(value) || value < 0) return undefined
  return Math.round((value / 60) * 100) / 100
}

export function humanize(value: string): string {
  return value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function decodeEntity(entity: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  }
  const normalized = entity.toLowerCase()
  if (named[normalized] !== undefined) return named[normalized]

  const hexadecimal = normalized.startsWith("#x")
  const decimal = normalized.startsWith("#")
  if (!hexadecimal && !decimal) return `&${entity};`

  const parsed = Number.parseInt(
    entity.slice(hexadecimal ? 2 : 1),
    hexadecimal ? 16 : 10
  )
  try {
    return Number.isInteger(parsed) && parsed >= 0
      ? String.fromCodePoint(parsed)
      : `&${entity};`
  } catch {
    return `&${entity};`
  }
}

export function htmlToPlainText(value: string | null | undefined): string {
  // Remove hidden blocks before bounding the input so truncation cannot cut a
  // closing tag and accidentally expose script or style content as text.
  const html = (value ?? "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .slice(0, MAX_HTML_INPUT_LENGTH)
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(
      /<\/(?:address|article|aside|blockquote|div|h[1-6]|li|p|pre|section|table|tr)\s*>/gi,
      "\n"
    )
    .replace(/<li\b[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&([#a-zA-Z0-9]+);/g, (_match, entity: string) =>
      decodeEntity(entity)
    )
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ +([,.;:!?])/g, "$1")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_PAGE_TEXT_LENGTH)
}

export function escapeMarkdown(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([`*_{}\[\]()<>#+.!|])/g, "\\$1")
    .replace(/^([>-])/gm, "\\$1")
}

export function uniqueStrings(values: Array<string | undefined>): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const normalized = nonEmpty(value)
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized)
      result.push(normalized)
    }
  }
  return result
}
