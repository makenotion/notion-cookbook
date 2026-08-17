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

    Bookmark: Schema.relation("bookmarks", {
      twoWay: true,
      relatedPropertyName: "Highlights",
    }),

    Text: Schema.richText(),

    Note: Schema.richText(),

    Tags: Schema.multiSelect([]),

    Created: Schema.date(),

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

    URL: Schema.url(),

    "Bookmark title": Schema.richText(),

    "Last Seen": Schema.date(),

    Truncated: Schema.checkbox(),

    "URL Omitted": Schema.checkbox(),

    "Highlight ID": Schema.richText(),

    "Raindrop Account ID": Schema.richText(),

    "Highlight Key": Schema.richText(),
  },
} satisfies Schema.Schema<typeof PRIMARY_KEY>

export function highlightToChange(
  accountId: number,
  highlight: RaindropHighlight,
  observedAt: string
): SyncChangeUpsert<typeof PRIMARY_KEY, typeof highlightSchema.properties> {
  const tags = optionNames(highlight.tags)
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
      URL: highlight.link ? Builder.url(highlight.link) : [],
      "URL Omitted": Builder.checkbox(highlight.linkOmitted),
      Color: Builder.select(displayLabel(highlight.color)),
      Tags: tags.length > 0 ? Builder.multiSelect(...tags) : [],
      Truncated: Builder.checkbox(
        textWasTruncated(highlight.text) ||
          textWasTruncated(highlight.note) ||
          textWasTruncated(highlight.title)
      ),
      Created: Builder.dateTime(highlight.created, "UTC"),
      "Last Seen": Builder.dateTime(observedAt, "UTC"),
      "Highlight ID": Builder.richText(highlight._id),
      "Raindrop Account ID": Builder.richText(String(accountId)),
      "Highlight Key": Builder.richText(key),
    },
  }
}
