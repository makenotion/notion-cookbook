import assert from "node:assert/strict"
import { test } from "node:test"

import { RateLimitError } from "@notionhq/workers"

import { bookmarkSchema, bookmarkToChange } from "./src/bookmarks.js"
import { collectionSchema, collectionToChange } from "./src/collections.js"
import {
  boundedText,
  displayLabel,
  highlightTitle,
  NOTION_TEXT_LIMIT,
  optionNames,
  TAG_OVERFLOW_SENTINEL,
  textWasTruncated,
} from "./src/format.js"
import { highlightSchema, highlightToChange } from "./src/highlights.js"
import worker from "./src/index.js"
import { bookmarkKey, collectionKey, highlightKey } from "./src/keys.js"
import {
  createRaindropClient,
  MAX_RESPONSE_BYTES,
  NOTION_URL_LIMIT,
  PAGE_SIZE,
  type RaindropBookmark,
  type RaindropCollection,
  type RaindropHighlight,
} from "./src/raindrop.js"
import {
  accountState,
  bookmarkPageResult,
  currentBookmarkPosition,
  currentPage,
  MAX_SYNC_RECORDS,
  pageResult,
  type AccountSyncState,
  type BookmarkSyncState,
  type PageSyncState,
} from "./src/sync-state.js"

const accountId = 321
const observedAt = "2026-07-03T12:34:56.000Z"

const bookmark: RaindropBookmark = {
  _id: 42,
  title: "Workers worth reading",
  link: "https://example.com/workers",
  linkOmitted: false,
  domain: "example.com",
  excerpt: "A useful description.",
  note: "Use this in the next project.",
  type: "article",
  tags: ["notion", "typescript"],
  collection: { $id: 7 },
  important: true,
  broken: false,
  reminderAt: "2026-06-10T15:00:00.000Z",
  created: "2026-06-01T10:00:00.000Z",
  lastUpdate: "2026-06-02T11:00:00.000Z",
  highlights: [{ _id: "highlight-1" }],
}

const highlight: RaindropHighlight = {
  _id: "highlight-1",
  raindropRef: 42,
  text: "The agent decides when; your code determines how.",
  note: "Strong positioning.",
  color: "purple",
  title: "Workers worth reading",
  link: "https://example.com/workers",
  linkOmitted: false,
  tags: ["notion"],
  created: "2026-06-01T10:05:00.000Z",
}

const collection: RaindropCollection = {
  _id: 7,
  title: "Developer tools",
  count: 12,
  public: false,
  parentId: 3,
  created: "2026-01-01T00:00:00.000Z",
  lastUpdate: "2026-06-02T11:00:00.000Z",
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: HeadersInit = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })
}

function bookmarkPayload(overrides: Record<string, unknown> = {}) {
  return {
    _id: bookmark._id,
    title: bookmark.title,
    link: bookmark.link,
    domain: bookmark.domain,
    excerpt: bookmark.excerpt,
    note: bookmark.note,
    type: bookmark.type,
    tags: bookmark.tags,
    collection: bookmark.collection,
    important: bookmark.important,
    broken: bookmark.broken,
    reminder: bookmark.reminderAt ? { data: bookmark.reminderAt } : undefined,
    created: bookmark.created,
    lastUpdate: bookmark.lastUpdate,
    highlights: bookmark.highlights,
    ...overrides,
  }
}

function highlightPayload(overrides: Record<string, unknown> = {}) {
  return { ...highlight, ...overrides }
}

function collectionPayload(overrides: Record<string, unknown> = {}) {
  return {
    _id: collection._id,
    title: collection.title,
    count: collection.count,
    public: collection.public,
    parent: { $id: collection.parentId },
    created: collection.created,
    lastUpdate: collection.lastUpdate,
    ...overrides,
  }
}

function withAuthenticatedUser(dataFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === "/rest/v1/user") {
      return jsonResponse({ result: true, user: { _id: accountId } })
    }
    return dataFetch(input, init)
  }
}

async function captureError(
  action: () => unknown | Promise<unknown>
): Promise<unknown> {
  try {
    await action()
  } catch (error) {
    return error
  }
  assert.fail("expected action to throw")
}

function propertyIncludes(value: unknown, expected: string): boolean {
  return JSON.stringify(value).includes(expected)
}

test("worker manifest declares account-scoped relation targets in dependency order", () => {
  assert.deepEqual(
    worker.manifest.databases.map((database) => ({
      key: database.key,
      title: database.config.initialTitle,
      primaryKey: database.config.primaryKeyProperty,
    })),
    [
      {
        key: "collections",
        title: "Raindrop.io Collections",
        primaryKey: "Collection Key",
      },
      {
        key: "bookmarks",
        title: "Raindrop.io Bookmarks",
        primaryKey: "Bookmark Key",
      },
      {
        key: "highlights",
        title: "Raindrop.io Highlights",
        primaryKey: "Highlight Key",
      },
    ]
  )
})

test("schemas lead with the fields used to review and connect research", () => {
  assert.deepEqual(Object.keys(collectionSchema.properties).slice(0, 6), [
    "Name",
    "Parent",
    "Bookmark count",
    "Updated",
    "Last Seen",
    "Public",
  ])
  assert.deepEqual(Object.keys(bookmarkSchema.properties).slice(0, 6), [
    "Title",
    "URL",
    "Collection",
    "Reminder",
    "Created",
    "Tags",
  ])
  assert.deepEqual(Object.keys(highlightSchema.properties).slice(0, 6), [
    "Highlight",
    "Bookmark",
    "Text",
    "Note",
    "Tags",
    "Created",
  ])
  assert.equal(
    propertyIncludes(bookmarkSchema.properties.Collection, "Bookmarks"),
    true
  )
  assert.equal(
    propertyIncludes(highlightSchema.properties.Bookmark, "Highlights"),
    true
  )
})

test("worker manifest uses non-destructive hourly scans behind one shared pacer", () => {
  type SyncConfig = {
    databaseKey: string
    mode: string
    schedule: { type: string; intervalMs: number }
  }

  assert.deepEqual(worker.manifest.pacers, [
    {
      key: "raindrop",
      config: { allowedRequests: 100, intervalMs: 60_000 },
    },
  ])
  assert.deepEqual(
    worker.manifest.capabilities.map((capability) => {
      assert.equal(capability._tag, "sync")
      const config = capability.config as SyncConfig
      return {
        key: capability.key,
        databaseKey: config.databaseKey,
        mode: config.mode,
        schedule: config.schedule,
      }
    }),
    [
      {
        key: "collectionsSync",
        databaseKey: "collections",
        mode: "incremental",
        schedule: { type: "interval", intervalMs: 60 * 60_000 },
      },
      {
        key: "bookmarksSync",
        databaseKey: "bookmarks",
        mode: "incremental",
        schedule: { type: "interval", intervalMs: 60 * 60_000 },
      },
      {
        key: "highlightsSync",
        databaseKey: "highlights",
        mode: "incremental",
        schedule: { type: "interval", intervalMs: 60 * 60_000 },
      },
    ]
  )
})

test("resource keys are stable within an account and isolated across accounts and types", () => {
  assert.equal(collectionKey(accountId, 42), "raindrop:321:collection:42")
  assert.equal(bookmarkKey(accountId, 42), "raindrop:321:bookmark:42")
  assert.equal(
    highlightKey(accountId, "highlight-1"),
    "raindrop:321:highlight:highlight-1"
  )
  assert.notEqual(bookmarkKey(accountId, 42), bookmarkKey(999, 42))
  assert.notEqual(bookmarkKey(accountId, 42), collectionKey(accountId, 42))
})

test("bookmark transform scopes keys and relations while preserving raw IDs", () => {
  const change = bookmarkToChange(accountId, bookmark, false, observedAt)

  assert.equal(change.key, "raindrop:321:bookmark:42")
  assert.equal("upstreamUpdatedAt" in change, false)
  assert.ok(propertyIncludes(change.properties.Title, "Workers worth reading"))
  assert.ok(
    propertyIncludes(change.properties.Collection, "raindrop:321:collection:7")
  )
  assert.ok(propertyIncludes(change.properties.Tags, "typescript"))
  assert.ok(propertyIncludes(change.properties.Type, "Article"))
  assert.ok(propertyIncludes(change.properties["Highlight count"], "1"))
  assert.ok(propertyIncludes(change.properties.Reminder, "2026-06-10"))
  assert.ok(propertyIncludes(change.properties.Created, "UTC"))
  assert.ok(propertyIncludes(change.properties.Updated, "UTC"))
  assert.ok(propertyIncludes(change.properties["Last Seen"], "2026-07-03"))
  assert.ok(propertyIncludes(change.properties["Last Seen"], "12:34"))
  assert.ok(propertyIncludes(change.properties["Raindrop ID"], "42"))
  assert.ok(propertyIncludes(change.properties["Raindrop Account ID"], "321"))
  assert.ok(
    propertyIncludes(
      change.properties["Bookmark Key"],
      "raindrop:321:bookmark:42"
    )
  )
  assert.ok(propertyIncludes(change.properties["In Trash"], "No"))
})

test("trash and restored bookmark upserts use one key and explicitly flip In Trash", () => {
  const trashedBookmark = {
    ...bookmark,
    collection: { $id: -99 },
  }
  const trashed = bookmarkToChange(accountId, trashedBookmark, true, observedAt)
  const restored = bookmarkToChange(accountId, bookmark, false, observedAt)

  assert.equal(trashed.key, restored.key)
  assert.ok(propertyIncludes(trashed.properties["In Trash"], "Yes"))
  assert.ok(propertyIncludes(restored.properties["In Trash"], "No"))
  assert.ok(
    propertyIncludes(
      trashed.properties.Collection,
      "raindrop:321:collection:-99"
    )
  )
})

test("bookmark transform clears optional values without owning page content", () => {
  const change = bookmarkToChange(
    accountId,
    {
      ...bookmark,
      domain: "",
      excerpt: "",
      note: "",
      tags: [],
      reminderAt: undefined,
    },
    false,
    observedAt
  )

  assert.deepEqual(change.properties.Domain, [])
  assert.deepEqual(change.properties.Excerpt, [])
  assert.deepEqual(change.properties.Note, [])
  assert.deepEqual(change.properties.Tags, [])
  assert.deepEqual(change.properties.Reminder, [])
  assert.equal("pageContentMarkdown" in change, false)
})

test("highlight transform scopes its key and bookmark relation", () => {
  const change = highlightToChange(accountId, highlight, observedAt)

  assert.equal(change.key, "raindrop:321:highlight:highlight-1")
  assert.ok(
    propertyIncludes(change.properties.Bookmark, "raindrop:321:bookmark:42")
  )
  assert.ok(propertyIncludes(change.properties.Text, "agent decides when"))
  assert.ok(propertyIncludes(change.properties.Color, "Purple"))
  assert.ok(propertyIncludes(change.properties.Created, "UTC"))
  assert.ok(propertyIncludes(change.properties["Last Seen"], "2026-07-03"))
  assert.ok(propertyIncludes(change.properties["Last Seen"], "12:34"))
  assert.ok(propertyIncludes(change.properties["Highlight ID"], "highlight-1"))
  assert.equal("pageContentMarkdown" in change, false)

  const longBookmarkTitle = highlightToChange(
    accountId,
    { ...highlight, title: "🧠".repeat(NOTION_TEXT_LIMIT + 1) },
    observedAt
  )
  assert.ok(propertyIncludes(longBookmarkTitle.properties.Truncated, "Yes"))
})

test("collection transform scopes parent relations and exposes raw identity", () => {
  const child = collectionToChange(accountId, collection, observedAt)
  const root = collectionToChange(
    accountId,
    {
      ...collection,
      _id: 3,
      parentId: undefined,
    },
    observedAt
  )

  assert.equal(child.key, "raindrop:321:collection:7")
  assert.ok(
    propertyIncludes(child.properties.Parent, "raindrop:321:collection:3")
  )
  assert.deepEqual(root.properties.Parent, [])
  assert.ok(propertyIncludes(child.properties["Collection ID"], "7"))
  assert.ok(propertyIncludes(child.properties["Bookmark count"], "12"))
  assert.ok(propertyIncludes(child.properties.Created, "UTC"))
  assert.ok(propertyIncludes(child.properties.Updated, "UTC"))
  assert.ok(propertyIncludes(child.properties["Last Seen"], "2026-07-03"))
  assert.ok(propertyIncludes(child.properties["Last Seen"], "12:34"))
  assert.equal("upstreamUpdatedAt" in child, false)

  const longTitle = collectionToChange(
    accountId,
    { ...collection, title: "🧠".repeat(NOTION_TEXT_LIMIT + 1) },
    observedAt
  )
  assert.ok(propertyIncludes(longTitle.properties.Truncated, "Yes"))
})

test("omitted source URLs are disclosed without breaking transforms", () => {
  const bookmarkChange = bookmarkToChange(
    accountId,
    {
      ...bookmark,
      title: "",
      domain: "",
      link: undefined,
      linkOmitted: true,
    },
    false,
    observedAt
  )
  const highlightChange = highlightToChange(
    accountId,
    {
      ...highlight,
      link: undefined,
      linkOmitted: true,
    },
    observedAt
  )

  assert.deepEqual(bookmarkChange.properties.URL, [])
  assert.ok(
    propertyIncludes(bookmarkChange.properties.Title, "Untitled bookmark")
  )
  assert.ok(propertyIncludes(bookmarkChange.properties["URL Omitted"], "Yes"))
  assert.deepEqual(highlightChange.properties.URL, [])
  assert.ok(propertyIncludes(highlightChange.properties["URL Omitted"], "Yes"))
})

test("text helpers respect Unicode and UTF-16 limits", () => {
  const source = "🧠".repeat(NOTION_TEXT_LIMIT + 1)
  const bounded = boundedText(source)

  assert.ok(Array.from(bounded).length <= NOTION_TEXT_LIMIT)
  assert.ok(bounded.length <= NOTION_TEXT_LIMIT)
  assert.equal(bounded.endsWith("…"), true)
  assert.equal(textWasTruncated(source), true)
  assert.equal(textWasTruncated("short"), false)
  assert.equal(boundedText("x".repeat(NOTION_TEXT_LIMIT + 1)).length, 2_000)
  assert.equal(displayLabel("article"), "Article")
  assert.equal(highlightTitle("a\n  b", "fallback"), "a b")
})

test("tag options deduplicate case variants and preserve normalization collisions", () => {
  const sourceTags = [" API ", "api", "a,b", "a，b"]
  const normalized = optionNames(sourceTags)

  assert.equal(normalized.length, 3)
  assert.equal(normalized.includes("a，b"), true)
  assert.equal(
    normalized.some((name) => /^a，b.*[0-9a-f]{12}$/.test(name)),
    true
  )
  assert.deepEqual(optionNames([...sourceTags].reverse()), normalized)
  assert.equal(
    normalized.filter((name) => name.toLocaleLowerCase("en-US") === "api")
      .length,
    1
  )
  assert.equal(
    normalized.every(
      (name) => Array.from(name).length <= 100 && name.length <= 100
    ),
    true
  )

  const generatedName = optionNames(["a,b", "a，b"]).find(
    (name) => name !== "a，b"
  )
  assert.ok(generatedName)
  const naturalNameCollision = optionNames(["a,b", "a，b", generatedName])
  assert.equal(naturalNameCollision.length, 3)
  assert.equal(naturalNameCollision.includes(generatedName), true)
  assert.equal(
    new Set(naturalNameCollision.map((name) => name.toLocaleLowerCase("en-US")))
      .size,
    3
  )
  assert.equal(
    naturalNameCollision.every(
      (name) => Array.from(name).length <= 100 && name.length <= 100
    ),
    true
  )

  assert.equal(optionNames(["x".repeat(101)])[0].length, 100)
  const emojiOption = optionNames(["🧠".repeat(100)])[0]
  assert.ok(emojiOption.length <= 100)

  const overflowInput = [
    TAG_OVERFLOW_SENTINEL,
    TAG_OVERFLOW_SENTINEL.toLocaleUpperCase("en-US"),
    ...Array.from({ length: 105 }, (_, index) => `tag-${index}`),
  ]
  const overflow = optionNames(overflowInput)
  assert.equal(overflow.length, 100)
  assert.equal(
    overflow.filter((name) => name === TAG_OVERFLOW_SENTINEL).length,
    1
  )
  assert.equal(
    overflow.filter(
      (name) =>
        name.toLocaleLowerCase("en-US") ===
        TAG_OVERFLOW_SENTINEL.toLocaleLowerCase("en-US")
    ).length,
    1
  )
  assert.equal(
    overflow.filter((name) => name !== TAG_OVERFLOW_SENTINEL).length,
    99
  )
  assert.deepEqual(overflow, optionNames([...overflowInput].reverse()))

  const pageChanges = [
    { ...bookmark, tags: overflowInput },
    { ...bookmark, _id: 43, tags: ["ordinary"] },
  ].map((item) => bookmarkToChange(accountId, item, false, observedAt))
  assert.deepEqual(
    pageChanges.map((change) => change.key),
    ["raindrop:321:bookmark:42", "raindrop:321:bookmark:43"]
  )
})

test("highlight scan state pins account identity and advances full pages", () => {
  const full = Array.from({ length: PAGE_SIZE })
  const first = pageResult(undefined, accountId, full, ["change"], "highlights")
  assert.deepEqual(first, {
    changes: ["change"],
    hasMore: true,
    nextState: {
      accountId,
      page: 1,
    },
  })
  assert.deepEqual(
    pageResult(
      first.nextState,
      accountId,
      full.slice(1),
      ["change"],
      "highlights"
    ),
    {
      changes: ["change"],
      hasMore: false,
      nextState: { accountId, page: 0 },
    }
  )
  assert.throws(
    () => currentPage({ accountId, page: 0 }, 999, "highlights"),
    /account changed/
  )
})

test("bookmark state scans active pages before Trash and then finishes", () => {
  const full = Array.from({ length: PAGE_SIZE })
  assert.deepEqual(currentBookmarkPosition(undefined, accountId), {
    phase: "active",
    page: 0,
  })

  const activeFull = bookmarkPageResult(undefined, accountId, "active", full, [
    "active",
  ])
  assert.deepEqual(activeFull.nextState, {
    accountId,
    phase: "active",
    page: 1,
  })

  const activeEnd = bookmarkPageResult(
    activeFull.nextState,
    accountId,
    "active",
    [],
    []
  )
  assert.deepEqual(activeEnd, {
    changes: [],
    hasMore: true,
    nextState: {
      accountId,
      phase: "trash",
      page: 0,
    },
  })

  const trashEnd = bookmarkPageResult(
    activeEnd.nextState,
    accountId,
    "trash",
    [{}],
    ["trash"]
  )
  assert.deepEqual(trashEnd, {
    changes: ["trash"],
    hasMore: false,
    nextState: { accountId, phase: "active", page: 0 },
  })
  assert.throws(
    () => currentBookmarkPosition(trashEnd.nextState, 999),
    /account changed/
  )
})

test("scan state remains account-bound and rejects corrupt or over-limit state", () => {
  const invalidPage = {
    accountId,
    page: -1,
  } satisfies PageSyncState
  assert.throws(
    () => currentPage(invalidPage, accountId, "highlights"),
    /invalid page/
  )
  const bound = accountState(undefined, accountId, "collections")
  assert.deepEqual(bound, { accountId } satisfies AccountSyncState)
  assert.throws(
    () => accountState(bound, 999, "collections"),
    /account changed/
  )

  const trashState = {
    accountId,
    phase: "trash",
    page: 0,
  } satisfies BookmarkSyncState
  assert.throws(
    () => currentBookmarkPosition(trashState, 999),
    /account changed/
  )
  assert.throws(
    () =>
      bookmarkPageResult(
        { ...trashState, page: MAX_SYNC_RECORDS / PAGE_SIZE },
        accountId,
        "trash",
        [{}],
        []
      ),
    /exceeds 10000 records/
  )
})

test("client fetches and validates the authenticated account ID", async () => {
  const client = createRaindropClient({
    beforeRequest: async () => undefined,
    fetchImpl: async () =>
      jsonResponse({ result: true, user: { _id: accountId } }),
    getAccessToken: () => "test-token",
  })

  const session = await client.authenticate()
  assert.equal(session.accountId, accountId)
})

test("authenticated sessions pin one token across identity and data requests", async () => {
  let tokenReads = 0
  const authorizationHeaders: Array<string | null> = []
  const client = createRaindropClient({
    beforeRequest: async () => undefined,
    fetchImpl: async (input, init) => {
      authorizationHeaders.push(new Headers(init?.headers).get("Authorization"))
      const url = new URL(input instanceof Request ? input.url : String(input))
      return url.pathname === "/rest/v1/user"
        ? jsonResponse({ result: true, user: { _id: accountId } })
        : jsonResponse({ result: true, items: [bookmarkPayload()] })
    },
    getAccessToken: () => {
      tokenReads += 1
      return tokenReads === 1 ? "first-token" : "different-token"
    },
  })

  const session = await client.authenticate()
  await session.fetchBookmarksPage("active", 0)

  assert.equal(tokenReads, 1)
  assert.deepEqual(authorizationHeaders, [
    "Bearer first-token",
    "Bearer first-token",
  ])
})

test("client sends bounded GET requests and sorts active bookmarks ascending", async () => {
  const requests: Array<{
    url: string
    authorization: string | null
    init: RequestInit | undefined
  }> = []
  let paced = 0
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    requests.push({
      url,
      authorization: new Headers(init?.headers).get("Authorization"),
      init,
    })
    return jsonResponse({ result: true, items: [bookmarkPayload()] })
  }
  const client = createRaindropClient({
    beforeRequest: async () => {
      paced += 1
    },
    fetchImpl: withAuthenticatedUser(fetchImpl),
    getAccessToken: () => "test-token",
  })

  const session = await client.authenticate()
  const page = await session.fetchBookmarksPage("active", 2)

  assert.equal(page.items[0]._id, 42)
  assert.equal(page.items[0].reminderAt, "2026-06-10T15:00:00.000Z")
  assert.equal(paced, 2)
  assert.equal(requests[0].authorization, "Bearer test-token")
  const requestUrl = new URL(requests[0].url)
  assert.equal(requestUrl.pathname, "/rest/v1/raindrops/0")
  assert.equal(requestUrl.searchParams.get("sort"), "created")
  assert.equal(requestUrl.searchParams.get("perpage"), "50")
  assert.equal(requestUrl.searchParams.get("page"), "2")
  assert.equal(requests[0].init?.method, "GET")
  assert.equal(requests[0].init?.redirect, "error")
  assert.ok(requests[0].init?.signal instanceof AbortSignal)
})

test("client normalizes provider timestamp offsets to UTC", async () => {
  const client = createRaindropClient({
    beforeRequest: async () => undefined,
    fetchImpl: withAuthenticatedUser(async () =>
      jsonResponse({
        result: true,
        items: [
          bookmarkPayload({
            created: "2026-06-01T15:30:00+05:30",
            reminder: { data: "2026-06-10T15:30:00+05:30" },
          }),
        ],
      })
    ),
    getAccessToken: () => "test-token",
  })

  const session = await client.authenticate()
  const page = await session.fetchBookmarksPage("active", 0)
  assert.equal(page.items[0].created, "2026-06-01T10:00:00.000Z")
  assert.equal(page.items[0].reminderAt, "2026-06-10T10:00:00.000Z")
})

test("client treats absent or null reminders as unscheduled", async () => {
  const client = createRaindropClient({
    beforeRequest: async () => undefined,
    fetchImpl: withAuthenticatedUser(async () =>
      jsonResponse({
        result: true,
        items: [
          bookmarkPayload({ _id: 42, reminder: undefined }),
          bookmarkPayload({ _id: 43, reminder: null }),
        ],
      })
    ),
    getAccessToken: () => "test-token",
  })

  const page = await (
    await client.authenticate()
  ).fetchBookmarksPage("active", 0)
  assert.deepEqual(
    page.items.map((item) => item.reminderAt),
    [undefined, undefined]
  )
})

test("client preserves 2,000-character URLs and omits longer links", async () => {
  const prefix = "https://example.com/"
  const exact = `${prefix}${"a".repeat(NOTION_URL_LIMIT - prefix.length)}`
  const overlong = `${exact}a`
  const astralOverlong = `${exact.slice(0, -1)}😀`
  assert.equal(Array.from(astralOverlong).length, NOTION_URL_LIMIT)
  assert.equal(astralOverlong.length, NOTION_URL_LIMIT + 1)
  const client = createRaindropClient({
    beforeRequest: async () => undefined,
    fetchImpl: withAuthenticatedUser(async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input))
        .pathname
      return path.startsWith("/rest/v1/raindrops/")
        ? jsonResponse({
            result: true,
            items: [
              bookmarkPayload({ _id: 42, link: exact }),
              bookmarkPayload({ _id: 43, link: overlong }),
              bookmarkPayload({ _id: 44, link: astralOverlong }),
            ],
          })
        : jsonResponse({
            result: true,
            items: [
              highlightPayload({ _id: "exact", link: exact }),
              highlightPayload({ _id: "overlong", link: overlong }),
              highlightPayload({
                _id: "astral-overlong",
                link: astralOverlong,
              }),
            ],
          })
    }),
    getAccessToken: () => "test-token",
  })

  const session = await client.authenticate()
  const bookmarks = await session.fetchBookmarksPage("active", 0)
  const highlights = await session.fetchHighlightsPage(0)

  assert.deepEqual(
    bookmarks.items.map(({ link, linkOmitted }) => ({ link, linkOmitted })),
    [
      { link: exact, linkOmitted: false },
      { link: undefined, linkOmitted: true },
      { link: undefined, linkOmitted: true },
    ]
  )
  assert.deepEqual(
    highlights.items.map(({ link, linkOmitted }) => ({ link, linkOmitted })),
    [
      { link: exact, linkOmitted: false },
      { link: undefined, linkOmitted: true },
      { link: undefined, linkOmitted: true },
    ]
  )
})

test("client scans Trash and accepts the Trash collection relation", async () => {
  const paths: string[] = []
  const client = createRaindropClient({
    beforeRequest: async () => undefined,
    fetchImpl: withAuthenticatedUser(async (input) => {
      paths.push(String(input))
      return jsonResponse({
        result: true,
        items: [bookmarkPayload({ collection: { $id: -99 } })],
      })
    }),
    getAccessToken: () => "test-token",
  })

  const session = await client.authenticate()
  const page = await session.fetchBookmarksPage("trash", 0)
  assert.equal(page.items[0].collection.$id, -99)
  assert.equal(new URL(paths[0]).pathname, "/rest/v1/raindrops/-99")
})

test("client rejects active and Trash collection mismatches", async () => {
  const activeClient = createRaindropClient({
    beforeRequest: async () => undefined,
    fetchImpl: withAuthenticatedUser(async () =>
      jsonResponse({
        result: true,
        items: [bookmarkPayload({ collection: { $id: -99 } })],
      })
    ),
    getAccessToken: () => "test-token",
  })
  await assert.rejects(
    (await activeClient.authenticate()).fetchBookmarksPage("active", 0),
    /active response returned a bookmark from Trash/
  )

  const trashClient = createRaindropClient({
    beforeRequest: async () => undefined,
    fetchImpl: withAuthenticatedUser(async () =>
      jsonResponse({ result: true, items: [bookmarkPayload()] })
    ),
    getAccessToken: () => "test-token",
  })
  await assert.rejects(
    (await trashClient.authenticate()).fetchBookmarksPage("trash", 0),
    /Trash response returned a bookmark outside Trash/
  )
})

test("client fetches root, child, Unsorted, and Trash collections", async () => {
  const requestedPaths: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    requestedPaths.push(url.pathname)
    return url.pathname.endsWith("/childrens")
      ? jsonResponse({
          result: true,
          items: [collectionPayload({ _id: 8, parent: { $id: 7 } })],
        })
      : jsonResponse({
          result: true,
          items: [collectionPayload({ parent: null })],
        })
  }
  const client = createRaindropClient({
    beforeRequest: async () => undefined,
    fetchImpl: withAuthenticatedUser(fetchImpl),
    getAccessToken: () => "test-token",
  })

  const session = await client.authenticate()
  const collections = await session.fetchCollections()

  assert.deepEqual(
    collections.map((item) => item._id),
    [-1, -99, 7, 8]
  )
  assert.deepEqual(requestedPaths.sort(), [
    "/rest/v1/collections",
    "/rest/v1/collections/childrens",
  ])
})

test("collection endpoints enforce root and child parent scopes", async () => {
  const childClient = createRaindropClient({
    beforeRequest: async () => undefined,
    fetchImpl: withAuthenticatedUser(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      return url.pathname.endsWith("/childrens")
        ? jsonResponse({
            result: true,
            items: [collectionPayload({ parent: null })],
          })
        : jsonResponse({ result: true, items: [] })
    }),
    getAccessToken: () => "test-token",
  })

  await assert.rejects(
    (await childClient.authenticate()).fetchCollections(),
    /parent is required for a child/
  )

  const rootClient = createRaindropClient({
    beforeRequest: async () => undefined,
    fetchImpl: withAuthenticatedUser(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      return url.pathname.endsWith("/childrens")
        ? jsonResponse({ result: true, items: [] })
        : jsonResponse({ result: true, items: [collectionPayload()] })
    }),
    getAccessToken: () => "test-token",
  })

  await assert.rejects(
    (await rootClient.authenticate()).fetchCollections(),
    /parent must be absent for a root/
  )
})

test("client validates highlight references and the documented color enum", async () => {
  const validClient = createRaindropClient({
    beforeRequest: async () => undefined,
    fetchImpl: withAuthenticatedUser(async () =>
      jsonResponse({ result: true, items: [highlightPayload()] })
    ),
    getAccessToken: () => "test-token",
  })
  const validSession = await validClient.authenticate()
  const page = await validSession.fetchHighlightsPage(0)
  assert.equal(page.items[0].raindropRef, 42)
  assert.equal(page.items[0].color, "purple")

  const invalidClient = createRaindropClient({
    beforeRequest: async () => undefined,
    fetchImpl: withAuthenticatedUser(async () =>
      jsonResponse({
        result: true,
        items: [highlightPayload({ color: "ultraviolet" })],
      })
    ),
    getAccessToken: () => "test-token",
  })
  const invalidSession = await invalidClient.authenticate()
  await assert.rejects(
    invalidSession.fetchHighlightsPage(0),
    /unsupported highlight color/
  )
})

test("client rejects duplicate IDs and malformed provider values", async () => {
  const duplicateClient = createRaindropClient({
    beforeRequest: async () => undefined,
    fetchImpl: withAuthenticatedUser(async () =>
      jsonResponse({
        result: true,
        items: [bookmarkPayload(), bookmarkPayload()],
      })
    ),
    getAccessToken: () => "test-token",
  })
  const duplicateSession = await duplicateClient.authenticate()
  await assert.rejects(
    duplicateSession.fetchBookmarksPage("active", 0),
    /duplicate bookmark ID/
  )

  const malformedClient = createRaindropClient({
    beforeRequest: async () => undefined,
    fetchImpl: withAuthenticatedUser(async () =>
      jsonResponse({
        result: true,
        items: [bookmarkPayload({ link: "javascript:alert(1)" })],
      })
    ),
    getAccessToken: () => "test-token",
  })
  const malformedSession = await malformedClient.authenticate()
  await assert.rejects(
    malformedSession.fetchBookmarksPage("active", 0),
    /must use HTTP or HTTPS/
  )

  const malformedReminderClient = createRaindropClient({
    beforeRequest: async () => undefined,
    fetchImpl: withAuthenticatedUser(async () =>
      jsonResponse({
        result: true,
        items: [bookmarkPayload({ reminder: {} })],
      })
    ),
    getAccessToken: () => "test-token",
  })
  await assert.rejects(
    (await malformedReminderClient.authenticate()).fetchBookmarksPage(
      "active",
      0
    ),
    /reminder.data must be a string/
  )
})

test("client requires arrays that drive bookmark and highlight fields", async () => {
  const missingBookmarkTags = createRaindropClient({
    beforeRequest: async () => undefined,
    fetchImpl: withAuthenticatedUser(async () =>
      jsonResponse({
        result: true,
        items: [bookmarkPayload({ tags: undefined })],
      })
    ),
    getAccessToken: () => "test-token",
  })
  await assert.rejects(
    (await missingBookmarkTags.authenticate()).fetchBookmarksPage("active", 0),
    /bookmark.*tags must be an array/
  )

  const missingEmbeddedHighlights = createRaindropClient({
    beforeRequest: async () => undefined,
    fetchImpl: withAuthenticatedUser(async () =>
      jsonResponse({
        result: true,
        items: [bookmarkPayload({ highlights: undefined })],
      })
    ),
    getAccessToken: () => "test-token",
  })
  await assert.rejects(
    (await missingEmbeddedHighlights.authenticate()).fetchBookmarksPage(
      "active",
      0
    ),
    /bookmark.*highlights must be an array/
  )

  const missingHighlightTags = createRaindropClient({
    beforeRequest: async () => undefined,
    fetchImpl: withAuthenticatedUser(async () =>
      jsonResponse({
        result: true,
        items: [highlightPayload({ tags: undefined })],
      })
    ),
    getAccessToken: () => "test-token",
  })
  await assert.rejects(
    (await missingHighlightTags.authenticate()).fetchHighlightsPage(0),
    /highlight.*tags must be an array/
  )
})

test("client bounds declared and streamed successful response bodies", async () => {
  const declaredOversized = createRaindropClient({
    beforeRequest: async () => undefined,
    fetchImpl: withAuthenticatedUser(async () =>
      jsonResponse({ result: true, items: [] }, 200, {
        "Content-Length": String(MAX_RESPONSE_BYTES + 1),
      })
    ),
    getAccessToken: () => "test-token",
  })
  const declaredSession = await declaredOversized.authenticate()
  await assert.rejects(
    declaredSession.fetchBookmarksPage("active", 0),
    /exceeded the allowed size/
  )

  const streamedOversized = createRaindropClient({
    beforeRequest: async () => undefined,
    fetchImpl: withAuthenticatedUser(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1))
              controller.close()
            },
          }),
          { status: 200 }
        )
    ),
    getAccessToken: () => "test-token",
  })
  const streamedSession = await streamedOversized.authenticate()
  await assert.rejects(
    streamedSession.fetchHighlightsPage(0),
    /exceeded the allowed size/
  )

  const invalidJsonClient = createRaindropClient({
    beforeRequest: async () => undefined,
    fetchImpl: withAuthenticatedUser(
      async () => new Response("not json", { status: 200 })
    ),
    getAccessToken: () => "test-token",
  })
  const invalidJsonSession = await invalidJsonClient.authenticate()
  await assert.rejects(
    invalidJsonSession.fetchHighlightsPage(0),
    /invalid JSON response/
  )
})

test("client preserves Retry-After and X-RateLimit-Reset delays", async () => {
  const retryAfterClient = createRaindropClient({
    beforeRequest: async () => undefined,
    fetchImpl: withAuthenticatedUser(async () =>
      jsonResponse({ result: false }, 429, { "Retry-After": "17" })
    ),
    getAccessToken: () => "test-token",
  })
  const retryAfterSession = await retryAfterClient.authenticate()
  const retryAfterError = await captureError(() =>
    retryAfterSession.fetchHighlightsPage(0)
  )
  assert.ok(retryAfterError instanceof RateLimitError)
  assert.equal(retryAfterError.retryAfter, 17)

  const resetAt = Math.floor(Date.now() / 1_000) + 120
  const resetClient = createRaindropClient({
    beforeRequest: async () => undefined,
    fetchImpl: withAuthenticatedUser(async () =>
      jsonResponse({ result: false }, 429, {
        "X-RateLimit-Reset": String(resetAt),
      })
    ),
    getAccessToken: () => "test-token",
  })
  const resetSession = await resetClient.authenticate()
  const resetError = await captureError(() =>
    resetSession.fetchHighlightsPage(0)
  )
  assert.ok(resetError instanceof RateLimitError)
  const resetDelay = resetError.retryAfter
  assert.ok(resetDelay !== undefined)
  assert.ok(resetDelay >= 119 && resetDelay <= 120)
})

test("client times out hung requests without exposing transport details", async () => {
  const client = createRaindropClient({
    beforeRequest: async () => undefined,
    requestTimeoutMs: 5,
    fetchImpl: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        assert.ok(signal)
        const guard = setTimeout(
          () => reject(new Error("timeout signal did not fire")),
          1_000
        )
        if (signal.aborted) {
          clearTimeout(guard)
          reject(signal.reason)
          return
        }
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(guard)
            reject(signal.reason)
          },
          { once: true }
        )
      }),
    getAccessToken: () => "test-token",
  })

  await assert.rejects(client.authenticate(), /timed out after 5ms/)
})

test("client reports invalid credentials without echoing provider content", async () => {
  let bodyCancelled = false
  const client = createRaindropClient({
    beforeRequest: async () => undefined,
    fetchImpl: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('{"secret":"must-not-leak"}')
            )
          },
          cancel() {
            bodyCancelled = true
          },
        }),
        { status: 401 }
      ),
    getAccessToken: () => "test-token",
  })

  await assert.rejects(
    client.authenticate(),
    (error: unknown) =>
      error instanceof Error &&
      /rejected RAINDROP_ACCESS_TOKEN/.test(error.message) &&
      !error.message.includes("must-not-leak")
  )
  assert.equal(bodyCancelled, true)
})

test("client rejects an empty token before consuming a request slot", async () => {
  let paced = false
  let fetched = false
  const client = createRaindropClient({
    beforeRequest: async () => {
      paced = true
    },
    fetchImpl: async () => {
      fetched = true
      return jsonResponse({ result: true, user: { _id: accountId } })
    },
    getAccessToken: () => "   ",
  })

  await assert.rejects(client.authenticate(), /is not set/)
  assert.equal(paced, false)
  assert.equal(fetched, false)
})
