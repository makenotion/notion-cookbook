import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

import {
  boundedText,
  displayLabel,
  optionNames,
  textWasTruncated,
} from "./format.js"
import { bookmarkKey, collectionKey } from "./keys.js"
import type { RaindropBookmark } from "./raindrop.js"

export const INITIAL_TITLE = "Raindrop.io Bookmarks"
export const PRIMARY_KEY = "Bookmark Key"

export const bookmarkSchema = {
  databaseIcon: notionIcon("bookmark"),
  properties: {
    Title: Schema.title(),

    URL: Schema.url(),

    Collection: Schema.relation("collections", {
      twoWay: true,
      relatedPropertyName: "Bookmarks",
    }),

    Reminder: Schema.date(),

    Created: Schema.date(),

    Tags: Schema.multiSelect([]),

    "Raindrop contributor": Schema.richText(),

    "Raindrop contributor ID": Schema.richText(),

    Favorite: Schema.checkbox(),

    Note: Schema.richText(),

    Excerpt: Schema.richText(),

    "Highlight count": Schema.number(),

    Updated: Schema.date(),

    "In Trash": Schema.checkbox(),

    Broken: Schema.checkbox(),

    "Last Seen": Schema.date(),

    Type: Schema.select([
      { name: "Link" },
      { name: "Article" },
      { name: "Image" },
      { name: "Video" },
      { name: "Document" },
      { name: "Audio" },
    ]),

    Domain: Schema.richText(),

    Truncated: Schema.checkbox(),

    "URL Omitted": Schema.checkbox(),

    "Raindrop ID": Schema.richText(),

    "Raindrop Account ID": Schema.richText(),

    "Bookmark Key": Schema.richText(),
  },
} satisfies Schema.Schema<typeof PRIMARY_KEY>

export function bookmarkToChange(
  accountId: number,
  bookmark: RaindropBookmark,
  inTrash: boolean,
  observedAt: string
): SyncChangeUpsert<typeof PRIMARY_KEY, typeof bookmarkSchema.properties> {
  const sourceTitle =
    bookmark.title.trim() ||
    bookmark.domain.trim() ||
    bookmark.link ||
    "Untitled bookmark"
  const tags = optionNames(bookmark.tags)
  const key = bookmarkKey(accountId, bookmark._id)
  return {
    type: "upsert",
    key,
    properties: {
      Title: Builder.title(boundedText(sourceTitle)),
      URL: bookmark.link ? Builder.url(bookmark.link) : [],
      "URL Omitted": Builder.checkbox(bookmark.linkOmitted),
      Collection: [
        Builder.relation(collectionKey(accountId, bookmark.collection.$id)),
      ],
      Reminder: bookmark.reminderAt
        ? Builder.dateTime(bookmark.reminderAt, "UTC")
        : [],
      Tags: tags.length > 0 ? Builder.multiSelect(...tags) : [],
      Type: Builder.select(displayLabel(bookmark.type)),
      Domain: bookmark.domain ? Builder.richText(bookmark.domain) : [],
      Favorite: Builder.checkbox(bookmark.important),
      Broken: Builder.checkbox(bookmark.broken),
      "In Trash": Builder.checkbox(inTrash),
      Note: bookmark.note ? Builder.richText(boundedText(bookmark.note)) : [],
      "Raindrop contributor": bookmark.contributor
        ? Builder.richText(boundedText(bookmark.contributor.fullName))
        : [],
      "Raindrop contributor ID": bookmark.contributor
        ? Builder.richText(String(bookmark.contributor.id))
        : [],
      Excerpt: bookmark.excerpt
        ? Builder.richText(boundedText(bookmark.excerpt))
        : [],
      Truncated: Builder.checkbox(
        textWasTruncated(sourceTitle) ||
          textWasTruncated(bookmark.note) ||
          textWasTruncated(bookmark.excerpt) ||
          textWasTruncated(bookmark.contributor?.fullName ?? "")
      ),
      "Highlight count": Builder.number(bookmark.highlights.length),
      Created: Builder.dateTime(bookmark.created, "UTC"),
      Updated: Builder.dateTime(bookmark.lastUpdate, "UTC"),
      "Last Seen": Builder.dateTime(observedAt, "UTC"),
      "Raindrop ID": Builder.richText(String(bookmark._id)),
      "Raindrop Account ID": Builder.richText(String(accountId)),
      "Bookmark Key": Builder.richText(key),
    },
  }
}
