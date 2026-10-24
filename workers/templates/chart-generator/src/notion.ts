const HYPHENATED_UUID =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const BARE_UUID = /[0-9a-f]{32}/i

// Accept a UUID (hyphenated or not) or a Notion URL and return the bare ID.
// Notion page URLs end in a title slug whose tail is the 32-char id, e.g.
// https://notion.so/My-Page-550e8400e29b41d4a716446655440000 — so pull the id
// out of the last path segment rather than expecting the whole segment to be one.
export function extractId(value: string): string {
  let segment = value.trim()
  try {
    segment =
      new URL(segment).pathname.split("/").filter(Boolean).pop() ?? segment
  } catch {
    // not a URL — use the value as-is
  }

  const hyphenated = segment.match(HYPHENATED_UUID)
  if (hyphenated) return hyphenated[0]

  const bare = segment.match(BARE_UUID)
  if (bare) return bare[0]

  throw new Error(
    `Invalid ID: "${value}". Must be a UUID (hyphenated or unhyphenated) or a Notion URL.`
  )
}
