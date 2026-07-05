import { notionIcon, type SyncChangeUpsert } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"

import { boundedText, textWasTruncated } from "./format.js"
import { collectionKey } from "./keys.js"
import type { RaindropCollection } from "./raindrop.js"

export const INITIAL_TITLE = "Raindrop.io Collections"
export const PRIMARY_KEY = "Collection Key"

export const collectionSchema = {
  databaseIcon: notionIcon("folder"),
  properties: {
    Name: Schema.title(),

    Parent: Schema.relation("collections", {
      twoWay: true,
      relatedPropertyName: "Subcollections",
    }),

    "Bookmark count": Schema.number(),

    Updated: Schema.date(),

    "Last Seen": Schema.date(),

    Public: Schema.checkbox(),

    Created: Schema.date(),

    Truncated: Schema.checkbox(),

    "Collection ID": Schema.richText(),

    "Raindrop Account ID": Schema.richText(),

    "Collection Key": Schema.richText(),
  },
} satisfies Schema.Schema<typeof PRIMARY_KEY>

export function collectionToChange(
  accountId: number,
  collection: RaindropCollection,
  observedAt: string
): SyncChangeUpsert<typeof PRIMARY_KEY, typeof collectionSchema.properties> {
  const key = collectionKey(accountId, collection._id)
  const sourceTitle = collection.title.trim() || "Untitled collection"
  return {
    type: "upsert",
    key,
    properties: {
      Name: Builder.title(boundedText(sourceTitle)),
      Parent:
        collection.parentId === undefined
          ? []
          : [Builder.relation(collectionKey(accountId, collection.parentId))],
      "Bookmark count":
        collection.count === undefined ? [] : Builder.number(collection.count),
      Public: Builder.checkbox(collection.public),
      Created: collection.created
        ? Builder.dateTime(collection.created, "UTC")
        : [],
      Updated: collection.lastUpdate
        ? Builder.dateTime(collection.lastUpdate, "UTC")
        : [],
      "Last Seen": Builder.dateTime(observedAt, "UTC"),
      Truncated: Builder.checkbox(textWasTruncated(sourceTitle)),
      "Collection ID": Builder.richText(String(collection._id)),
      "Raindrop Account ID": Builder.richText(String(accountId)),
      "Collection Key": Builder.richText(key),
    },
  }
}
