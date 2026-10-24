import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

import type { ReadwiseHighlight, ReadwiseSource } from "./readwise.js"
import { exportSourceKey } from "./sources.js"
import {
  boundedText,
  dateValue,
  displayLabel,
  displayTitle,
  trimmed,
  uniqueSelectNames,
  validDate,
  validUrl,
} from "./values.js"

export const HIGHLIGHTS_INITIAL_TITLE = "Reading Highlights"
export const HIGHLIGHTS_PRIMARY_KEY = "Highlight Key"

export const highlightSchema = {
  databaseIcon: notionIcon("target"),
  properties: {
    Highlight: Schema.title(),
    Source: Schema.relation("sources", {
      twoWay: true,
      relatedPropertyName: "Highlights",
    }),
    Note: Schema.richText(),
    Tags: Schema.multiSelect([]),
    Highlighted: Schema.date(),
    Favorite: Schema.checkbox(),
    "Open in Readwise": Schema.url(),
    Quote: Schema.richText(),
    Color: Schema.select([]),
    "Removed upstream": Schema.checkbox(),
    "Highlight Key": Schema.richText(),
  },
} satisfies Schema.Schema<typeof HIGHLIGHTS_PRIMARY_KEY>

type HighlightChange = SyncChangeUpsert<
  typeof HIGHLIGHTS_PRIMARY_KEY,
  typeof highlightSchema.properties
>

// Sync upserts apply only the supplied properties; omitted properties keep
// their existing values. The 0.4 SDK type models a complete schema, so keep
// this temporary type narrowing isolated to intentional property patches.
function highlightPropertyPatch(
  properties: Partial<HighlightChange["properties"]>
): HighlightChange["properties"] {
  return properties as HighlightChange["properties"]
}

export function highlightKey(highlightId: string): string {
  const id = highlightId.trim()
  if (!id) throw new Error("Readwise highlight id cannot be empty.")
  return `highlight:${id}`
}

export function highlightToChange(
  source: ReadwiseSource,
  highlight: ReadwiseHighlight
): HighlightChange {
  const key = highlightKey(highlight.id)
  if (source.is_deleted || highlight.is_deleted) {
    const title = trimmed(highlight.text)
    // A partial upsert marks the retained row without clearing its last useful
    // quote or the user's Notion context.
    return {
      type: "upsert" as const,
      key,
      properties: highlightPropertyPatch({
        ...(title
          ? {
              Highlight: Builder.title(
                displayTitle(title, `Removed highlight ${highlight.id}`)
              ),
            }
          : {}),
        Source: [Builder.relation(exportSourceKey(source))],
        "Removed upstream": Builder.checkbox(true),
        "Highlight Key": Builder.richText(key),
      }),
    }
  }

  const quote = boundedText(highlight.text)
  const note = boundedText(highlight.note)
  const title = displayTitle(
    highlight.text,
    `Untitled highlight ${highlight.id}`
  )
  const updatedAt = validDate(highlight.updated_at)
  const color = displayLabel(highlight.color)
  const readwiseUrl = validUrl(highlight.readwise_url)

  return {
    type: "upsert" as const,
    key,
    ...(updatedAt ? { upstreamUpdatedAt: updatedAt } : {}),
    properties: {
      Highlight: Builder.title(title),
      Source: [Builder.relation(exportSourceKey(source))],
      Note: note ? Builder.richText(note) : [],
      Tags: Builder.multiSelect(
        ...uniqueSelectNames(highlight.tags.map((tag) => tag.name))
      ),
      Highlighted: dateValue(highlight.highlighted_at),
      Favorite: Builder.checkbox(highlight.is_favorite),
      "Open in Readwise": readwiseUrl ? Builder.url(readwiseUrl) : [],
      Quote: quote ? Builder.richText(quote) : [],
      Color: color ? Builder.select(color) : [],
      "Removed upstream": Builder.checkbox(highlight.is_discard),
      "Highlight Key": Builder.richText(key),
    },
  }
}
