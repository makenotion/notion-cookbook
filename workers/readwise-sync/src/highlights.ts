import { notionIcon } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

import type { ReadwiseHighlight, ReadwiseSource } from "./readwise.js"
import { exportSourceKey } from "./sources.js"
import {
  boundedText,
  dateValue,
  displayLabel,
  displayTitle,
  finiteNumber,
  sourceName,
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
    Discarded: Schema.checkbox(),
    "Open in Readwise": Schema.url(),
    "Source Author": Schema.richText(),
    Quote: Schema.richText(),
    Origin: Schema.select([]),
    Color: Schema.select([]),
    "Source URL": Schema.url(),
    Location: Schema.number(),
    "Location Type": Schema.select([]),
    Created: Schema.date(),
    Updated: Schema.date(),
    "Source Title": Schema.richText(),
    "Quote Truncated": Schema.checkbox(),
    "Note Truncated": Schema.checkbox(),
    "External ID": Schema.richText(),
    "Readwise Source ID": Schema.richText(),
    "Highlight Key": Schema.richText(),
  },
} satisfies Schema.Schema<typeof HIGHLIGHTS_PRIMARY_KEY>

export function highlightKey(highlightId: string): string {
  const id = highlightId.trim()
  if (!id) throw new Error("Readwise highlight id cannot be empty.")
  return `highlight:${id}`
}

export function highlightToChange(
  source: ReadwiseSource,
  highlight: ReadwiseHighlight
) {
  const key = highlightKey(highlight.id)
  if (source.is_deleted || highlight.is_deleted) {
    return { type: "delete" as const, key }
  }

  const quote = boundedText(highlight.text)
  const note = boundedText(highlight.note)
  const title = displayTitle(
    highlight.text,
    `Untitled highlight ${highlight.id}`
  )
  const updatedAt = validDate(highlight.updated_at)
  const location = finiteNumber(highlight.location)
  const sourceTitle = trimmed(source.readable_title) ?? trimmed(source.title)
  const sourceAuthor = trimmed(source.author)
  const color = displayLabel(highlight.color)
  const locationType = displayLabel(highlight.location_type)
  const readwiseUrl = validUrl(highlight.readwise_url)
  const sourceUrl =
    validUrl(highlight.url) ??
    validUrl(source.source_url) ??
    validUrl(source.unique_url)

  return {
    type: "upsert" as const,
    key,
    ...(updatedAt ? { upstreamUpdatedAt: updatedAt } : {}),
    properties: {
      Highlight: Builder.title(title),
      Source: [Builder.relation(exportSourceKey(source))],
      Note: note.text ? Builder.richText(note.text) : [],
      Tags: Builder.multiSelect(
        ...uniqueSelectNames(highlight.tags.map((tag) => tag.name))
      ),
      Highlighted: dateValue(highlight.highlighted_at),
      Favorite: Builder.checkbox(highlight.is_favorite),
      Discarded: Builder.checkbox(highlight.is_discard),
      "Open in Readwise": readwiseUrl ? Builder.url(readwiseUrl) : [],
      "Source Author": sourceAuthor ? Builder.richText(sourceAuthor) : [],
      Quote: quote.text ? Builder.richText(quote.text) : [],
      Origin: Builder.select(sourceName(source.source)),
      Color: color ? Builder.select(color) : [],
      "Source URL": sourceUrl ? Builder.url(sourceUrl) : [],
      Location: location !== undefined ? Builder.number(location) : [],
      "Location Type": locationType ? Builder.select(locationType) : [],
      Created: dateValue(highlight.created_at),
      Updated: dateValue(highlight.updated_at),
      "Source Title": sourceTitle ? Builder.richText(sourceTitle) : [],
      "Quote Truncated": Builder.checkbox(quote.truncated),
      "Note Truncated": Builder.checkbox(note.truncated),
      "External ID": trimmed(highlight.external_id)
        ? Builder.richText(highlight.external_id!.trim())
        : [],
      "Readwise Source ID": Builder.richText(source.user_book_id),
      "Highlight Key": Builder.richText(key),
    },
  }
}
