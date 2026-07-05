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

    "Raindrop access": Schema.select([
      { name: "Public: view" },
      { name: "Collaborator: view" },
      { name: "Collaborator: edit" },
      { name: "Owner" },
    ]),

    "Shared in Raindrop": Schema.checkbox(),

    "Public in Raindrop": Schema.checkbox(),

    "Raindrop Owner ID": Schema.richText(),

    "Parent unavailable": Schema.checkbox(),

    "Parent ID": Schema.richText(),

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
        collection.parentId === undefined || !collection.parentAvailable
          ? []
          : [Builder.relation(collectionKey(accountId, collection.parentId))],
      "Parent unavailable": Builder.checkbox(
        collection.parentId !== undefined && !collection.parentAvailable
      ),
      "Parent ID": collection.parentId
        ? Builder.richText(String(collection.parentId))
        : [],
      "Bookmark count":
        collection.count === undefined ? [] : Builder.number(collection.count),
      "Raindrop access": collection.accessLevel
        ? Builder.select(accessLabel(collection.accessLevel))
        : [],
      "Shared in Raindrop": Builder.checkbox(collection.shared),
      "Public in Raindrop": Builder.checkbox(collection.public),
      "Raindrop Owner ID": collection.ownerId
        ? Builder.richText(String(collection.ownerId))
        : [],
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

function accessLabel(
  level: NonNullable<RaindropCollection["accessLevel"]>
): string {
  switch (level) {
    case 1:
      return "Public: view"
    case 2:
      return "Collaborator: view"
    case 3:
      return "Collaborator: edit"
    case 4:
      return "Owner"
  }
}
