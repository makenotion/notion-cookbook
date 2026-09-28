/** Canonical dashed UUID form of a Notion ID. */
export function formatId(id: string): string {
  const hex = id.replace(/-/g, "").toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) return id
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Notion page events carry the page URL and properties but no explicit ID
 * field, so read the ID from the event's page record or its URL.
 */
export function pageIdFromEvent(event: {
  url: string | null
  page?: Record<string, unknown>
}): string | null {
  const recordId = event.page?.id
  if (typeof recordId === "string" && /^[0-9a-f-]{32,36}$/i.test(recordId))
    return formatId(recordId)
  const match =
    event.url?.match(/([0-9a-f]{32})(?:[?#]|$)/i) ??
    event.url?.match(/([0-9a-f-]{36})(?:[?#]|$)/i)
  return match?.[1] ? formatId(match[1]) : null
}
