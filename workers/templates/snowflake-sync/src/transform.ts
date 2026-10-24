// =============================================================================
// EDIT THIS to match the columns your SNOWFLAKE_SYNC_QUERY returns.
//
// Snowflake returns column names in UPPERCASE by default, so lookups use
// `row["COLUMN"] ?? row["column"]` to handle both casing conventions.
// =============================================================================

import * as Builder from "@notionhq/workers/builder"

/**
 * Convert a raw Snowflake row into a sync upsert change.
 *
 * Returns null for rows with an empty key — they cannot be upserted
 * deterministically and will be skipped. Filter the result array with
 * `.flatMap(row => { const c = rowToChange(row); return c ? [c] : [] })`.
 */
export function rowToChange(row: Record<string, unknown>) {
  const rawKey = row["ID"] ?? row["id"]
  if (rawKey == null || rawKey === "") {
    // Skip rows with no ID — upserts require a stable key.
    return null
  }

  const updatedAt = dateOnly(row["UPDATED_AT"] ?? row["updated_at"])

  return {
    type: "upsert" as const,
    key: str(rawKey),
    properties: {
      Name: Builder.title(str(row["NAME"] ?? row["name"])),
      ID: Builder.richText(str(row["ID"] ?? row["id"])),
      Email: Builder.email(str(row["EMAIL"] ?? row["email"])),
      Status: Builder.richText(str(row["STATUS"] ?? row["status"])),
      // Builder.date requires a non-empty YYYY-MM-DD string. When the source
      // column is null, spread nothing so the property is omitted from the
      // change rather than passed as an empty or invalid value.
      ...(updatedAt ? { "Updated At": Builder.date(updatedAt) } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Coerce any value to a non-null string. */
function str(value: unknown): string {
  if (value == null) return ""
  return String(value)
}

/**
 * Extract a YYYY-MM-DD date string from a value that may be:
 *   - already a YYYY-MM-DD string
 *   - an ISO 8601 timestamp ("2024-03-15T12:00:00Z")
 *   - a Date object
 *   - null / undefined (returns "" — caller treats "" as "omit")
 */
function dateOnly(value: unknown): string {
  if (value == null) return ""
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10)
  }
  const s = String(value).trim()
  if (!s) return ""
  // ISO timestamp — take the date part before the T.
  if (s.includes("T")) return s.slice(0, 10)
  // Already YYYY-MM-DD (or close enough).
  return s.slice(0, 10)
}
