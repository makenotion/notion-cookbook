// Raindrop.io reading library — collections, bookmarks, and highlights in
// three connected managed Notion databases. The public Raindrop.io API does
// not expose reliable deletion tombstones, so hourly full scans only upsert
// observed records and preserve last-known rows that disappear upstream.

import { Worker } from "@notionhq/workers"

import {
  INITIAL_TITLE as BOOKMARKS_TITLE,
  PRIMARY_KEY as BOOKMARKS_PRIMARY_KEY,
  bookmarkSchema,
  bookmarkToChange,
} from "./bookmarks.js"
import {
  INITIAL_TITLE as COLLECTIONS_TITLE,
  PRIMARY_KEY as COLLECTIONS_PRIMARY_KEY,
  collectionSchema,
  collectionToChange,
} from "./collections.js"
import {
  INITIAL_TITLE as HIGHLIGHTS_TITLE,
  PRIMARY_KEY as HIGHLIGHTS_PRIMARY_KEY,
  highlightSchema,
  highlightToChange,
} from "./highlights.js"
import { createRaindropClient } from "./raindrop.js"
import {
  bookmarkPageResult,
  currentBookmarkPosition,
  currentPage,
  pageResult,
  type BookmarkSyncState,
  type PageSyncState,
} from "./sync-state.js"

const worker = new Worker()

// Raindrop.io permits 120 authenticated requests per minute. All three syncs
// share a conservative budget so scheduled runs leave room for normal use.
const pacer = worker.pacer("raindrop", {
  allowedRequests: 100,
  intervalMs: 60_000,
})

const client = createRaindropClient({
  beforeRequest: () => pacer.wait(),
})

const collections = worker.database("collections", {
  type: "managed",
  initialTitle: COLLECTIONS_TITLE,
  primaryKeyProperty: COLLECTIONS_PRIMARY_KEY,
  schema: collectionSchema,
})

const bookmarks = worker.database("bookmarks", {
  type: "managed",
  initialTitle: BOOKMARKS_TITLE,
  primaryKeyProperty: BOOKMARKS_PRIMARY_KEY,
  schema: bookmarkSchema,
})

const highlights = worker.database("highlights", {
  type: "managed",
  initialTitle: HIGHLIGHTS_TITLE,
  primaryKeyProperty: HIGHLIGHTS_PRIMARY_KEY,
  schema: highlightSchema,
})

// Register relation targets first. For the initial import, trigger these in
// the same order so Collections and Bookmarks exist before their dependants.
worker.sync("collectionsSync", {
  database: collections,
  mode: "incremental",
  schedule: "1h",
  execute: async () => {
    const session = await client.authenticate()
    const items = await session.fetchCollections()
    const observedAt = new Date().toISOString()
    return {
      changes: items.map((item) =>
        collectionToChange(session.accountId, item, observedAt)
      ),
      hasMore: false,
    }
  },
})

worker.sync("bookmarksSync", {
  database: bookmarks,
  mode: "incremental",
  schedule: "1h",
  execute: async (state: BookmarkSyncState | undefined) => {
    const session = await client.authenticate()
    const { phase, page } = currentBookmarkPosition(state, session.accountId)
    const result = await session.fetchBookmarksPage(phase, page)
    const observedAt = new Date().toISOString()
    return bookmarkPageResult(
      state,
      session.accountId,
      phase,
      result.items,
      result.items.map((item) =>
        bookmarkToChange(session.accountId, item, phase === "trash", observedAt)
      )
    )
  },
})

worker.sync("highlightsSync", {
  database: highlights,
  mode: "incremental",
  schedule: "1h",
  execute: async (state: PageSyncState | undefined) => {
    const session = await client.authenticate()
    const page = currentPage(state, session.accountId, "highlights")
    const result = await session.fetchHighlightsPage(page)
    const observedAt = new Date().toISOString()
    return pageResult(
      state,
      session.accountId,
      result.items,
      result.items.map((item) =>
        highlightToChange(session.accountId, item, observedAt)
      ),
      "highlights"
    )
  },
})

export default worker
