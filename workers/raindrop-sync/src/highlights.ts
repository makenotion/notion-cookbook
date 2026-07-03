import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

import {
  boundedText,
  displayLabel,
  highlightTitle,
  optionNames,
  textWasTruncated,
} from "./format.js"
import { bookmarkKey, highlightKey } from "./keys.js"
import type { RaindropHighlight } from "./raindrop.js"

export const INITIAL_TITLE = "Raindrop.io Highlights"
export const PRIMARY_KEY = "Highlight Key"

export const highlightSchema = {
  databaseIcon: notionIcon("book"),
  properties: {
    Highlight: Schema.title(),

    Text: Schema.richText(),

    Note: Schema.richText(),

    Bookmark: Schema.relation("bookmarks", {
      twoWay: true,
      relatedPropertyName: "Synced Highlights",
    }),

    "Bookmark title": Schema.richText(),

    URL: Schema.url(),

    Color: Schema.select([
      { name: "Blue" },
      { name: "Brown" },
      { name: "Cyan" },
      { name: "Gray" },
      { name: "Green" },
      { name: "Indigo" },
      { name: "Orange" },
      { name: "Pink" },
      { name: "Purple" },
      { name: "Red" },
      { name: "Teal" },
      { name: "Yellow" },
    ]),

    Tags: Schema.multiSelect([]),

    Truncated: Schema.checkbox(),

    Created: Schema.date(),

    "Highlight ID": Schema.richText(),

    "Raindrop Account ID": Schema.richText(),

    "Highlight Key": Schema.richText(),
  },
} satisfies Schema.Schema<typeof PRIMARY_KEY>

export function highlightToChange(
  accountId: number,
  highlight: RaindropHighlight
): SyncChangeUpsert<typeof PRIMARY_KEY, typeof highlightSchema.properties> {
  const tags = optionNames("highlight tags", highlight.tags)
  const key = highlightKey(accountId, highlight._id)
  return {
    type: "upsert",
    key,
    properties: {
      Highlight: Builder.title(highlightTitle(highlight.text, highlight.title)),
      Text: Builder.richText(boundedText(highlight.text)),
      Note: highlight.note ? Builder.richText(boundedText(highlight.note)) : [],
      Bookmark: [
        Builder.relation(bookmarkKey(accountId, highlight.raindropRef)),
      ],
      "Bookmark title": highlight.title
        ? Builder.richText(boundedText(highlight.title))
        : [],
      URL: Builder.url(highlight.link),
      Color: Builder.select(displayLabel(highlight.color)),
      Tags: tags.length > 0 ? Builder.multiSelect(...tags) : [],
      Truncated: Builder.checkbox(
        textWasTruncated(highlight.text) || textWasTruncated(highlight.note)
      ),
      Created: Builder.dateTime(highlight.created, "UTC"),
      "Highlight ID": Builder.richText(highlight._id),
      "Raindrop Account ID": Builder.richText(String(accountId)),
      "Highlight Key": Builder.richText(key),
    },
  }
}
