// =============================================================================
// EDIT THIS to match the columns your SNOWFLAKE_SYNC_QUERY returns.
//
// Each key in `properties` becomes a property in the managed Notion database.
// The platform auto-provisions and owns the database — you do not create it
// manually.
//
// Schema reference:
//   Schema.title()         — the page title property (required: exactly one)
//   Schema.richText()      — free-form text
//   Schema.email()         — email address (rendered as a mailto link)
//   Schema.date()          — date or datetime
//   Schema.select([...])   — single-select with known option names
//   Schema.number()        — numeric value
//   Schema.url()           — URL link
//   Schema.checkbox()      — boolean checkbox
// =============================================================================

import * as Schema from "@notionhq/workers/schema"

export const INITIAL_TITLE =
  process.env.SNOWFLAKE_SYNC_DB_TITLE ?? "Snowflake Sync"

// The property name used as the unique key for upserts. Must exist in the
// properties map below and be passed as `primaryKeyProperty` on the database
// handle.
export const PRIMARY_KEY = "ID"

export const rowSchema: Schema.Schema<typeof PRIMARY_KEY> = {
  properties: {
    // The page title — required by Notion; mapped from the `name` column.
    Name: Schema.title(),

    // Unique identifier for each row. Used as the upsert key.
    ID: Schema.richText(),

    // Email address column.
    Email: Schema.email(),

    // Status is mapped to richText because the option values aren't known
    // up front. Switch to Schema.select(["Active", "Inactive", ...]) if you
    // know the full set of values.
    Status: Schema.richText(),

    // Date column. Expects a YYYY-MM-DD string (or ISO timestamp — see transform.ts).
    "Updated At": Schema.date(),
  },
}
