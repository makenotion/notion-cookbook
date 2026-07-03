import { notionIcon } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

import type { ReadwiseHighlight, ReadwiseSource } from "./readwise.js"
import { exportSourceKey } from "./sources.js"
import {
  boundedText,
  dateValue,
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
    Name: Schema.title(),
    Quote: Schema.richText(),
    "Quote Truncated": Schema.checkbox(),
    Note: Schema.richText(),
    "Note Truncated": Schema.checkbox(),
    Source: Schema.relation("sources", {
      twoWay: true,
      relatedPropertyName: "Highlights",
    }),
    "Source Title": Schema.richText(),
    "Source Author": Schema.richText(),
    Origin: Schema.select([]),
    Tags: Schema.multiSelect([]),
    Color: Schema.select([]),
    Favorite: Schema.checkbox(),
    Discarded: Schema.checkbox(),
    Location: Schema.number(),
    "Location Type": Schema.select([]),
    Highlighted: Schema.date(),
    Created: Schema.date(),
    Updated: Schema.date(),
    "Readwise URL": Schema.url(),
    "Source URL": Schema.url(),
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
  const color = trimmed(highlight.color)?.toLowerCase()
  const locationType = trimmed(highlight.location_type)?.toLowerCase()
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
      Name: Builder.title(title),
      Quote: quote.text ? Builder.richText(quote.text) : [],
      "Quote Truncated": Builder.checkbox(quote.truncated),
      Note: note.text ? Builder.richText(note.text) : [],
      "Note Truncated": Builder.checkbox(note.truncated),
      Source: [Builder.relation(exportSourceKey(source))],
      "Source Title": sourceTitle ? Builder.richText(sourceTitle) : [],
      "Source Author": sourceAuthor ? Builder.richText(sourceAuthor) : [],
      Origin: Builder.select(sourceName(source.source)),
      Tags: Builder.multiSelect(
        ...uniqueSelectNames(highlight.tags.map((tag) => tag.name))
      ),
      Color: color ? Builder.select(color) : [],
      Favorite: Builder.checkbox(highlight.is_favorite),
      Discarded: Builder.checkbox(highlight.is_discard),
      Location: location !== undefined ? Builder.number(location) : [],
      "Location Type": locationType ? Builder.select(locationType) : [],
      Highlighted: dateValue(highlight.highlighted_at),
      Created: dateValue(highlight.created_at),
      Updated: dateValue(highlight.updated_at),
      "Readwise URL": readwiseUrl ? Builder.url(readwiseUrl) : [],
      "Source URL": sourceUrl ? Builder.url(sourceUrl) : [],
      "External ID": trimmed(highlight.external_id)
        ? Builder.richText(highlight.external_id!.trim())
        : [],
      "Readwise Source ID": Builder.richText(source.user_book_id),
      "Highlight Key": Builder.richText(key),
    },
  }
}
