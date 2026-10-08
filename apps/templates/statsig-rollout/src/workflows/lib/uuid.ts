const DASHED_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const COMPACT_UUID = /^[0-9a-f]{32}$/
const PAGE_ID_IN_URL =
  /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[?#]|$)/i

/**
 * Normalizes an ID to lowercase dashed UUID form. Accepts the dashed form and
 * the 32-character compact form used in Notion URLs. Returns null when the
 * input is not a UUID.
 */
export function normalizeUuid(raw: string): string | null {
  const value = raw.trim().toLowerCase()
  if (DASHED_UUID.test(value)) {
    return value
  }
  if (COMPACT_UUID.test(value)) {
    return [
      value.slice(0, 8),
      value.slice(8, 12),
      value.slice(12, 16),
      value.slice(16, 20),
      value.slice(20),
    ].join("-")
  }
  return null
}

/** Extracts the Notion page ID from a page URL such as https://www.notion.so/Title-<id>. */
export function pageIdFromUrl(url: string | null | undefined): string | null {
  const match = url ? PAGE_ID_IN_URL.exec(url) : null
  return match ? normalizeUuid(match[1]!) : null
}
