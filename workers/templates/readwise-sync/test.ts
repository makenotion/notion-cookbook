import assert from "node:assert/strict"
import test from "node:test"

import { RateLimitError } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"

import { highlightSchema, highlightToChange } from "./src/highlights.js"
import worker from "./src/index.js"
import {
  MAX_RESPONSE_BYTES,
  READWISE_BOOK_PAGE_SIZE,
  ReadwiseApiError,
  credentialFingerprintForToken,
  createReadwiseClient,
  type ReaderDocumentPage,
  type ReadwiseBookPage,
  type ReadwiseClient,
  type ReadwiseExportPage,
  type ReadwiseSource,
} from "./src/readwise.js"
import {
  exportSourceKey,
  exportSourceToChange,
  readerDocumentToChange,
  readerSourceKey,
  readwiseBookToChange,
  sourceSchema,
} from "./src/sources.js"
import {
  CONSISTENCY_BUFFER_MS,
  INITIAL_UPDATED_AFTER,
  MAX_CURSOR_LENGTH,
  MAX_PAGINATION_RESTARTS,
  MAX_SAFE_SYNC_STATE_BYTES,
  WATERMARK_OVERLAP_MS,
  boundedSyncState,
  completedIncrementalState,
  incrementalWindow,
  nextCursorState,
  nextPaginationRestartCount,
  syncStateSize,
  type IncrementalSyncState,
  type SourcesIncrementalSyncState,
} from "./src/state.js"
import {
  runHighlightsIncrementalPage,
  runSourcesIncrementalPage,
} from "./src/syncs.js"
import {
  boundedText,
  displayLabel,
  readerTagNames,
  TAG_OVERFLOW_SENTINEL,
  uniqueSelectNames,
  validUrl,
} from "./src/values.js"

const readerFixture = {
  nextPageCursor: null,
  results: [
    {
      id: "reader-document-1",
      url: "https://read.readwise.io/read/reader-document-1",
      source_url: "https://example.com/durable-notes",
      title: "Durable notes for software teams",
      author: "A. Reader",
      category: "article",
      location: "later",
      tags: {
        engineering: { name: "Engineering" },
        "to-share": { name: "To share" },
      },
      site_name: "Example Engineering",
      reading_time: "12 mins",
      updated_at: "2026-06-02T12:00:00Z",
      published_date: "2026-05-31",
      notes: "Discuss this with the platform team.",
      summary: "How durable notes preserve decisions across tools.",
      parent_id: null,
      reading_progress: 0.55,
      last_opened_at: "2026-06-02T11:45:00Z",
      saved_at: "2026-06-01T10:00:00Z",
    },
    {
      id: "reader-note-1",
      url: "https://read.readwise.io/read/reader-note-1",
      source_url: null,
      title: "A nested Reader note",
      author: null,
      category: "note",
      location: "new",
      tags: {},
      site_name: null,
      reading_time: null,
      updated_at: "2026-06-02T12:00:00Z",
      published_date: null,
      notes: null,
      summary: null,
      parent_id: "reader-document-1",
      reading_progress: null,
      last_opened_at: null,
      saved_at: "2026-06-02T12:00:00Z",
    },
    {
      id: "reader-feed-1",
      url: "https://read.readwise.io/feed/reader-feed-1",
      source_url: "https://example.com/feed-item",
      title: "An unread feed item",
      author: "Feed Author",
      category: "article",
      location: "feed",
      tags: {},
      site_name: "Example Feed",
      reading_time: "8 mins",
      updated_at: "2026-06-03T12:00:00Z",
      published_date: "2026-06-03",
      notes: null,
      summary: "An item that has not been intentionally saved.",
      parent_id: null,
      reading_progress: 0,
      last_opened_at: null,
      saved_at: "2026-06-03T12:00:00Z",
    },
    {
      id: "reader-document-2",
      url: "https://read.readwise.io/archive/reader-document-2",
      source_url: "https://example.com/design.pdf",
      title: "A practical systems design guide",
      author: "B. Builder",
      category: "pdf",
      location: "archive",
      tags: {},
      site_name: "Example Research",
      reading_time: "60 mins",
      updated_at: "2026-06-03T09:00:00Z",
      published_date: "2026-04-15",
      notes: "Finished.",
      summary: "A systems design reference.",
      parent_id: null,
      reading_progress: 1,
      last_opened_at: "2026-06-03T08:00:00Z",
      saved_at: "2026-05-01T10:00:00Z",
    },
  ],
} satisfies Record<string, unknown>

const exportFixture = {
  nextPageCursor: null,
  results: [
    {
      user_book_id: 501,
      is_deleted: false,
      title: "Durable notes for software teams",
      readable_title: "Durable notes for software teams",
      author: "A. Reader",
      source: "reader",
      unique_url: "https://example.com/durable-notes",
      book_tags: [{ name: "Engineering" }],
      category: "articles",
      document_note: "Discuss this with the platform team.",
      summary: "How durable notes preserve decisions across tools.",
      readwise_url: "https://readwise.io/bookreview/501",
      source_url: "https://example.com/durable-notes",
      external_id: "reader-document-1",
      highlights: [
        {
          id: 9_001,
          is_deleted: false,
          text: "A durable note should retain the decision, its context, and the source that changed the team's mind.",
          note: "This should become an architecture-decision prompt.",
          color: "yellow",
          highlighted_at: "2026-06-02T11:30:00Z",
          updated_at: "2026-06-02T12:30:00Z",
          tags: [{ name: "Architecture" }],
          is_favorite: true,
          is_discard: false,
          readwise_url: "https://readwise.io/open/9001",
        },
        {
          id: 9_002,
          is_deleted: true,
        },
      ],
    },
    {
      user_book_id: 502,
      is_deleted: false,
      title: "Designing Data-Intensive Applications",
      readable_title: "Designing Data-Intensive Applications",
      author: "Martin Kleppmann",
      source: "kindle",
      unique_url: "",
      book_tags: [{ name: "Distributed systems" }],
      category: "books",
      document_note: "",
      summary: "",
      readwise_url: "https://readwise.io/bookreview/502",
      source_url: "",
      external_id: null,
      highlights: [
        {
          id: 9_100,
          is_deleted: false,
          text: "Reliability means continuing to work correctly, even when things go wrong.",
          note: null,
          color: "blue",
          highlighted_at: "2026-05-20T10:00:00Z",
          updated_at: "2026-05-20T10:00:00Z",
          tags: [],
          is_favorite: false,
          is_discard: false,
          readwise_url: "https://readwise.io/open/9100",
        },
      ],
    },
    {
      user_book_id: 503,
      is_deleted: true,
      source: "kindle",
      external_id: null,
      highlights: [{ id: 9_200, is_deleted: true }],
    },
  ],
} satisfies Record<string, unknown>

const booksFixture = {
  count: 2,
  next: null,
  previous: null,
  results: [
    {
      id: 502,
      title: "Designing Data-Intensive Applications",
      author: "Martin Kleppmann",
      category: "books",
      source: "kindle",
      num_highlights: 1,
      updated: "2026-06-04T10:00:00Z",
      tags: [{ id: 1, name: "Distributed systems" }],
      document_note: "Use this in the reliability project.",
      highlights_url: "https://readwise.io/bookreview/502",
      source_url: null,
    },
    {
      id: 501,
      title: "Durable notes for software teams",
      author: "A. Reader",
      category: "articles",
      source: "reader",
      num_highlights: 1,
      updated: "2026-06-04T11:00:00Z",
      tags: [{ id: 2, name: "Engineering" }],
      document_note: "Reader owns this source.",
      highlights_url: "https://readwise.io/bookreview/501",
      source_url: "https://example.com/durable-notes",
    },
  ],
} satisfies Record<string, unknown>

process.env.READWISE_ACCESS_TOKEN = "offline-fixture-token"
const TEST_CREDENTIAL_FINGERPRINT = credentialFingerprintForToken(
  process.env.READWISE_ACCESS_TOKEN
)

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  })
}

async function parsedFixtures(): Promise<{
  reader: ReaderDocumentPage
  books: ReadwiseBookPage
  exported: ReadwiseExportPage
}> {
  const client = createReadwiseClient(async () => {}, (async (input) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url
    )
    if (url.pathname === "/api/v3/list/") return jsonResponse(readerFixture)
    if (url.pathname === "/api/v2/books/") return jsonResponse(booksFixture)
    return jsonResponse(exportFixture)
  }) as typeof fetch)
  return {
    reader: await client.listReaderDocuments({}),
    books: await client.listReadwiseBooks({}),
    exported: await client.exportHighlights({ includeDeleted: true }),
  }
}

function queuedClient(options: {
  reader?: ReaderDocumentPage[]
  books?: ReadwiseBookPage[]
  exported?: ReadwiseExportPage[]
  credentialFingerprint?: string
  calls?: Array<{
    endpoint: "books" | "reader" | "readwise"
    updatedAfter?: string
    updatedBefore?: string
    pageCursor?: string
    page?: number
    includeDeleted?: boolean
  }>
}): ReadwiseClient {
  let readerIndex = 0
  let bookIndex = 0
  let exportIndex = 0
  return {
    credentialFingerprint() {
      return options.credentialFingerprint ?? TEST_CREDENTIAL_FINGERPRINT
    },
    async listReaderDocuments(request) {
      options.calls?.push({ endpoint: "reader", ...request })
      const page = options.reader?.[readerIndex]
      assert.ok(page, `unexpected Reader request ${readerIndex + 1}`)
      readerIndex += 1
      return page
    },
    async listReadwiseBooks(request) {
      options.calls?.push({ endpoint: "books", ...request })
      const page = options.books?.[bookIndex]
      assert.ok(page, `unexpected Books request ${bookIndex + 1}`)
      bookIndex += 1
      return page
    },
    async exportHighlights(request) {
      options.calls?.push({ endpoint: "readwise", ...request })
      const page = options.exported?.[exportIndex]
      assert.ok(page, `unexpected Export request ${exportIndex + 1}`)
      exportIndex += 1
      return page
    },
  }
}

test("worker manifest exposes two related, incremental archive syncs", () => {
  assert.deepEqual(
    worker.manifest.databases.map((database) => ({
      key: database.key,
      title: database.config.initialTitle,
      primaryKey: database.config.primaryKeyProperty,
    })),
    [
      {
        key: "sources",
        title: "Reading Sources",
        primaryKey: "Source Key",
      },
      {
        key: "highlights",
        title: "Reading Highlights",
        primaryKey: "Highlight Key",
      },
    ]
  )
  assert.deepEqual(worker.manifest.pacers, [
    {
      key: "readwise",
      config: { allowedRequests: 15, intervalMs: 60_000 },
    },
  ])

  type SyncConfig = {
    databaseKey: string
    mode: string
    schedule: { type: string; intervalMs: number }
  }
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
        key: "sourcesSync",
        databaseKey: "sources",
        mode: "incremental",
        schedule: { type: "interval", intervalMs: 15 * 60_000 },
      },
      {
        key: "highlightsSync",
        databaseKey: "highlights",
        mode: "incremental",
        schedule: { type: "interval", intervalMs: 15 * 60_000 },
      },
    ]
  )
})

test("schemas lead with user questions and keep provider plumbing minimal", () => {
  assert.deepEqual(Object.keys(sourceSchema.properties), [
    "Source",
    "Location",
    "Reading Progress",
    "Saved",
    "Author",
    "Category",
    "Tags",
    "Last Opened",
    "Open in Readwise",
    "Summary",
    "Note",
    "Site",
    "Origin",
    "Reading Time",
    "Published",
    "Original URL",
    "Removed upstream",
    "Source Key",
  ])
  assert.deepEqual(Object.keys(highlightSchema.properties), [
    "Highlight",
    "Source",
    "Note",
    "Tags",
    "Highlighted",
    "Favorite",
    "Open in Readwise",
    "Quote",
    "Color",
    "Removed upstream",
    "Highlight Key",
  ])
  assert.equal(
    (sourceSchema.properties["Reading Progress"] as { format?: string }).format,
    "percent"
  )
})

test("typed client authenticates and preserves Reader cursor parameters", async () => {
  const requests: Array<{ url: URL; init: RequestInit | undefined }> = []
  let paced = 0
  const client = createReadwiseClient(
    async () => {
      paced += 1
    },
    (async (input, init) => {
      requests.push({
        url: new URL(
          typeof input === "string" || input instanceof URL ? input : input.url
        ),
        init,
      })
      return jsonResponse(readerFixture)
    }) as typeof fetch
  )

  const page = await client.listReaderDocuments({
    updatedAfter: "2026-06-01T00:00:00.000Z",
    pageCursor: "reader-cursor",
  })

  assert.equal(paced, 1)
  assert.equal(requests[0].url.pathname, "/api/v3/list/")
  assert.equal(requests[0].url.searchParams.get("limit"), "100")
  assert.equal(
    requests[0].url.searchParams.get("updatedAfter"),
    "2026-06-01T00:00:00.000Z"
  )
  assert.equal(requests[0].url.searchParams.get("pageCursor"), "reader-cursor")
  assert.equal(
    new Headers(requests[0].init?.headers).get("Authorization"),
    "Token offline-fixture-token"
  )
  assert.equal(page.documents.length, 4)
  assert.equal(client.credentialFingerprint(), TEST_CREDENTIAL_FINGERPRINT)
})

test("typed client incrementally lists source metadata from Readwise Books", async () => {
  let requested: URL | undefined
  const response = structuredClone(booksFixture) as Record<string, unknown>
  response.next =
    "https://readwise.io/api/v2/books/?page=3&page_size=1000&updated__gt=2026-06-01T00%3A00%3A00.000Z"
  const client = createReadwiseClient(async () => {}, (async (input) => {
    requested = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url
    )
    return jsonResponse(response)
  }) as typeof fetch)

  const page = await client.listReadwiseBooks({
    updatedAfter: "2026-06-01T00:00:00.000Z",
    updatedBefore: "2026-06-05T00:00:00.000Z",
    page: 2,
  })

  assert.equal(requested?.pathname, "/api/v2/books/")
  assert.equal(
    requested?.searchParams.get("page_size"),
    String(READWISE_BOOK_PAGE_SIZE)
  )
  assert.equal(requested?.searchParams.get("page"), "2")
  assert.equal(
    requested?.searchParams.get("updated__gt"),
    "2026-06-01T00:00:00.000Z"
  )
  assert.equal(
    requested?.searchParams.get("updated__lt"),
    "2026-06-05T00:00:00.000Z"
  )
  assert.equal(page.nextPage, 3)
  assert.equal(page.count, 2)
  assert.equal(page.books[0].id, "502")
  assert.equal(page.books[0].updated, "2026-06-04T10:00:00Z")
})

test("typed client can request deletion tombstones from Readwise Export", async () => {
  let requested: URL | undefined
  const client = createReadwiseClient(async () => {}, (async (input) => {
    requested = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url
    )
    return jsonResponse(exportFixture)
  }) as typeof fetch)

  const page = await client.exportHighlights({
    updatedAfter: "2026-06-01T00:00:00.000Z",
    pageCursor: "export-cursor",
    includeDeleted: true,
  })

  assert.equal(requested?.pathname, "/api/v2/export/")
  assert.equal(requested?.searchParams.get("includeDeleted"), "true")
  assert.equal(requested?.searchParams.get("pageCursor"), "export-cursor")
  assert.equal(page.sources[0].highlights[1].is_deleted, true)
  assert.equal(page.sources[2].is_deleted, true)
})

test("missing credentials fail before a provider request", async () => {
  const token = process.env.READWISE_ACCESS_TOKEN
  let requests = 0
  try {
    delete process.env.READWISE_ACCESS_TOKEN
    const client = createReadwiseClient(async () => {}, (async () => {
      requests += 1
      return jsonResponse(readerFixture)
    }) as typeof fetch)
    await assert.rejects(
      () => client.listReaderDocuments({}),
      /READWISE_ACCESS_TOKEN is not set/
    )
    assert.equal(requests, 0)
  } finally {
    process.env.READWISE_ACCESS_TOKEN = token
  }
})

test("429 responses become retryable Worker errors", async () => {
  const client = createReadwiseClient(
    async () => {},
    (async () =>
      new Response("slow down", {
        status: 429,
        headers: { "Retry-After": "37" },
      })) as typeof fetch
  )

  await assert.rejects(
    () => client.listReaderDocuments({}),
    (error: unknown) =>
      error instanceof RateLimitError && error.retryAfter === 37
  )
})

test("responses are bounded and provider errors do not expose private content", async () => {
  const oversized = createReadwiseClient(
    async () => {},
    (async () =>
      new Response("{}", {
        status: 200,
        headers: { "Content-Length": String(MAX_RESPONSE_BYTES + 1) },
      })) as typeof fetch
  )
  await assert.rejects(
    () => oversized.listReaderDocuments({}),
    new RegExp(`exceeded ${MAX_RESPONSE_BYTES} bytes`)
  )

  const privateDetail = "private-highlight-text-never-log"
  const denied = createReadwiseClient(
    async () => {},
    (async () => new Response(privateDetail, { status: 403 })) as typeof fetch
  )
  await assert.rejects(
    () => denied.exportHighlights({ includeDeleted: true }),
    (error: unknown) =>
      error instanceof ReadwiseApiError &&
      error.status === 403 &&
      !error.message.includes(privateDetail)
  )
})

test("provider pages require explicit cursors and result collections", async () => {
  for (const nextPageCursor of [undefined, "   ", 42]) {
    const body: Record<string, unknown> = { results: [] }
    if (nextPageCursor !== undefined) body.nextPageCursor = nextPageCursor
    const client = createReadwiseClient(async () => {}, (async () =>
      jsonResponse(body)) as typeof fetch)
    await assert.rejects(
      () => client.listReaderDocuments({}),
      /invalid nextPageCursor/
    )
  }

  const missingResults = createReadwiseClient(async () => {}, (async () =>
    jsonResponse({ nextPageCursor: null })) as typeof fetch)
  await assert.rejects(
    () => missingResults.exportHighlights({ includeDeleted: false }),
    /highlight export results must be an array/
  )

  const foreignNext = createReadwiseClient(async () => {}, (async () =>
    jsonResponse({
      ...booksFixture,
      next: "https://example.com/api/v2/books/?page=2",
    })) as typeof fetch)
  await assert.rejects(
    () => foreignNext.listReadwiseBooks({}),
    /unexpected next URL/
  )
})

test("provider parsers validate fields that control identity and archive state", async () => {
  const missingParent = structuredClone(readerFixture) as Record<
    string,
    unknown
  >
  delete (missingParent.results as Array<Record<string, unknown>>)[0].parent_id
  const readerClient = createReadwiseClient(async () => {}, (async () =>
    jsonResponse(missingParent)) as typeof fetch)
  await assert.rejects(
    () => readerClient.listReaderDocuments({}),
    /Reader parent_id must be null or a valid stable id/
  )

  const missingHighlights = structuredClone(exportFixture) as Record<
    string,
    unknown
  >
  delete (missingHighlights.results as Array<Record<string, unknown>>)[0]
    .highlights
  const exportClient = createReadwiseClient(async () => {}, (async () =>
    jsonResponse(missingHighlights)) as typeof fetch)
  await assert.rejects(
    () => exportClient.exportHighlights({ includeDeleted: true }),
    /source highlights must be an array/
  )

  const malformedDelete = structuredClone(exportFixture) as Record<
    string,
    unknown
  >
  ;(malformedDelete.results as Array<Record<string, unknown>>)[0].is_deleted =
    "false"
  const deleteClient = createReadwiseClient(async () => {}, (async () =>
    jsonResponse(malformedDelete)) as typeof fetch)
  await assert.rejects(
    () => deleteClient.exportHighlights({ includeDeleted: true }),
    /source is_deleted must be a boolean/
  )

  const malformedDiscard = structuredClone(exportFixture) as Record<
    string,
    unknown
  >
  const activeHighlight = (
    (malformedDiscard.results as Array<Record<string, unknown>>)[0]
      .highlights as Array<Record<string, unknown>>
  )[0]
  delete activeHighlight.is_discard
  const discardClient = createReadwiseClient(async () => {}, (async () =>
    jsonResponse(malformedDiscard)) as typeof fetch)
  await assert.rejects(
    () => discardClient.exportHighlights({ includeDeleted: true }),
    /highlight is_discard must be a boolean/
  )

  const invalidBook = structuredClone(booksFixture) as Record<string, unknown>
  ;(invalidBook.results as Array<Record<string, unknown>>)[0].num_highlights =
    -1
  const bookClient = createReadwiseClient(async () => {}, (async () =>
    jsonResponse(invalidBook)) as typeof fetch)
  await assert.rejects(
    () => bookClient.listReadwiseBooks({}),
    /book num_highlights must be a non-negative integer/
  )

  const invalidBookCount = structuredClone(booksFixture) as Record<
    string,
    unknown
  >
  invalidBookCount.count = -1
  const countClient = createReadwiseClient(async () => {}, (async () =>
    jsonResponse(invalidBookCount)) as typeof fetch)
  await assert.rejects(
    () => countClient.listReadwiseBooks({}),
    /book count must be a non-negative integer/
  )
})

test("provider parsers reject invalid dates and reading progress", async () => {
  const badDate = structuredClone(readerFixture) as Record<string, unknown>
  ;(badDate.results as Array<Record<string, unknown>>)[0].saved_at =
    "not-a-date"
  const dateClient = createReadwiseClient(async () => {}, (async () =>
    jsonResponse(badDate)) as typeof fetch)
  await assert.rejects(
    () => dateClient.listReaderDocuments({}),
    /saved_at must be a valid date or null/
  )

  const badProgress = structuredClone(readerFixture) as Record<string, unknown>
  ;(badProgress.results as Array<Record<string, unknown>>)[0].reading_progress =
    1.5
  const progressClient = createReadwiseClient(async () => {}, (async () =>
    jsonResponse(badProgress)) as typeof fetch)
  await assert.rejects(
    () => progressClient.listReaderDocuments({}),
    /reading_progress must be between 0 and 1 or null/
  )
})

test("out-of-scope Reader records require only identity and scope fields", async () => {
  const ignoredMetadata = structuredClone(readerFixture) as Record<
    string,
    unknown
  >
  const results = ignoredMetadata.results as Array<Record<string, unknown>>
  delete results[1].location
  results[1].tags = "malformed child tags"
  results[1].saved_at = "not-a-date"
  results[2].tags = 42
  results[2].reading_progress = 9

  const client = createReadwiseClient(async () => {}, (async () =>
    jsonResponse(ignoredMetadata)) as typeof fetch)
  const page = await client.listReaderDocuments({})

  assert.equal(readerDocumentToChange(page.documents[1]), undefined)
  assert.equal(readerDocumentToChange(page.documents[2]), undefined)
})

test("Reader children and Feed items are excluded from the intentional archive", async () => {
  const { reader } = await parsedFixtures()
  const changes = reader.documents
    .map((document) => readerDocumentToChange(document))
    .filter((change): change is NonNullable<typeof change> => Boolean(change))

  assert.deepEqual(
    changes.map((change) => change.key),
    ["reader:reader-document-1", "reader:reader-document-2"]
  )
  assert.deepEqual(changes[0].properties.Location, Builder.select("Later"))
  assert.deepEqual(changes[0].properties.Category, Builder.select("Article"))
  assert.deepEqual(
    changes[0].properties["Reading Progress"],
    Builder.number(0.55)
  )
  assert.deepEqual(changes[1].properties.Location, Builder.select("Archive"))
  assert.deepEqual(
    changes[0].properties["Removed upstream"],
    Builder.checkbox(false)
  )
  assert.equal("pageContentMarkdown" in changes[0], false)
})

test("Reader and Readwise share stable Source identity", async () => {
  const { reader, books, exported } = await parsedFixtures()
  const readerDocument = reader.documents[0]
  const readerSource = exported.sources[0]

  assert.equal(readerSourceKey(readerDocument.id), "reader:reader-document-1")
  assert.equal(exportSourceKey(readerSource), "reader:reader-document-1")
  assert.equal(exportSourceKey(exported.sources[1]), "readwise:502")

  const initial = exportSourceToChange(readerSource)
  assert.ok(initial)
  assert.equal(initial.key, "reader:reader-document-1")
  assert.equal("Source" in initial.properties, true)

  assert.deepEqual(Object.keys(initial.properties).sort(), [
    "Removed upstream",
    "Source",
    "Source Key",
  ])
  assert.deepEqual(
    initial.properties.Source,
    Builder.title("Durable notes for software teams")
  )

  const bookChange = readwiseBookToChange(books.books[0])
  assert.ok(bookChange)
  assert.equal(bookChange.key, "readwise:502")
  assert.deepEqual(
    bookChange.properties.Note,
    Builder.richText("Use this in the reliability project.")
  )
  assert.equal("Removed upstream" in bookChange.properties, false)
  assert.equal(readwiseBookToChange(books.books[1]), undefined)

  const highlightedFeed = exportSourceToChange({
    ...readerSource,
    external_id: "reader-feed-1",
    title: "A highlighted Feed item",
    readable_title: "A highlighted Feed item",
  })
  assert.ok(highlightedFeed)
  assert.equal(highlightedFeed.key, "reader:reader-feed-1")
  assert.deepEqual(
    highlightedFeed.properties.Source,
    Builder.title("A highlighted Feed item")
  )

  const untitledFeed = exportSourceToChange({
    ...readerSource,
    external_id: "reader-feed-untitled",
    title: null,
    readable_title: null,
  })
  assert.ok(untitledFeed)
  assert.deepEqual(
    untitledFeed.properties.Source,
    Builder.title("Untitled Readwise source 501")
  )
})

test("Highlights relate to Sources and expose synthesis fields", async () => {
  const { exported } = await parsedFixtures()
  const source = exported.sources[0]
  const change = highlightToChange(source, source.highlights[0])

  assert.equal(change.type, "upsert")
  assert.equal(change.key, "highlight:9001")
  assert.deepEqual(change.properties.Source, [
    Builder.relation("reader:reader-document-1"),
  ])
  assert.deepEqual(change.properties.Favorite, Builder.checkbox(true))
  assert.deepEqual(change.properties.Color, Builder.select("Yellow"))
  assert.deepEqual(
    change.properties["Open in Readwise"],
    Builder.url("https://readwise.io/open/9001")
  )
  assert.deepEqual(
    change.properties["Removed upstream"],
    Builder.checkbox(false)
  )
  assert.equal("pageContentMarkdown" in change, false)
})

test("explicit tombstones retain rows and mark them removed", async () => {
  const { exported } = await parsedFixtures()
  const activeSource = exported.sources[0]
  const deletedHighlight = highlightToChange(
    activeSource,
    activeSource.highlights[1]
  )
  assert.equal(deletedHighlight.type, "upsert")
  assert.equal(deletedHighlight.key, "highlight:9002")
  assert.deepEqual(Object.keys(deletedHighlight.properties).sort(), [
    "Highlight Key",
    "Removed upstream",
    "Source",
  ])
  assert.deepEqual(deletedHighlight.properties.Source, [
    Builder.relation("reader:reader-document-1"),
  ])
  assert.deepEqual(
    deletedHighlight.properties["Removed upstream"],
    Builder.checkbox(true)
  )

  const deletedSource = exportSourceToChange(exported.sources[2])
  assert.ok(deletedSource)
  assert.equal(deletedSource.type, "upsert")
  assert.equal(deletedSource.key, "readwise:503")
  assert.deepEqual(Object.keys(deletedSource.properties).sort(), [
    "Removed upstream",
    "Source Key",
  ])
  assert.deepEqual(
    deletedSource.properties["Removed upstream"],
    Builder.checkbox(true)
  )

  const child = highlightToChange(
    exported.sources[2],
    exported.sources[2].highlights[0]
  )
  assert.equal(child.type, "upsert")
  assert.deepEqual(child.properties["Removed upstream"], Builder.checkbox(true))

  assert.equal(
    exportSourceToChange({ ...activeSource, is_deleted: true }),
    undefined
  )

  const discarded = highlightToChange(activeSource, {
    ...activeSource.highlights[0],
    is_discard: true,
  })
  assert.deepEqual(
    discarded.properties["Removed upstream"],
    Builder.checkbox(true)
  )

  const deletedWithMetadata = highlightToChange(activeSource, {
    ...activeSource.highlights[0],
    is_deleted: true,
  })
  assert.deepEqual(
    deletedWithMetadata.properties.Highlight,
    Builder.title(
      "A durable note should retain the decision, its context, and the source that changed the team's mind."
    )
  )

  const sourceWithMetadata = exportSourceToChange({
    ...exported.sources[1],
    is_deleted: true,
  })
  assert.ok(sourceWithMetadata)
  assert.deepEqual(
    sourceWithMetadata.properties.Source,
    Builder.title("Designing Data-Intensive Applications")
  )
})

test("source metadata uses safe fallbacks and visible text bounds", async () => {
  const { books, exported } = await parsedFixtures()
  const source: ReadwiseSource = {
    ...exported.sources[1],
    readable_title: "   ",
    title: "Fallback source title",
    summary: "x".repeat(2_100),
  }
  const change = exportSourceToChange(source)
  assert.ok(change)
  assert.deepEqual(
    change.properties.Source,
    Builder.title("Fallback source title")
  )
  assert.equal("Original URL" in change.properties, false)
  const summary = boundedText(source.summary)
  assert.equal([...(summary ?? "")].length, 1_900)
  assert.ok(summary?.endsWith("…"))

  const bookChange = readwiseBookToChange({
    ...books.books[0],
    source_url: "https://example.com/fallback-source",
  })
  assert.ok(bookChange)
  assert.deepEqual(
    bookChange.properties["Original URL"],
    Builder.url("https://example.com/fallback-source")
  )
})

test("labels, tags, and URLs remain deterministic and safe", () => {
  assert.equal(displayLabel("pdf"), "PDF")
  assert.equal(displayLabel("rss_feed"), "RSS Feed")
  assert.equal(displayLabel("time-offset"), "Time Offset")
  assert.deepEqual(
    readerTagNames({ z: { name: "Zed" }, a: { name: "Alpha" } }),
    ["Alpha", "Zed"]
  )
  assert.deepEqual(uniqueSelectNames([" deep   work ", "topic,one"]), [
    "deep work",
    "topic，one",
  ])
  assert.equal(validUrl("javascript:alert(1)"), undefined)
  assert.equal(validUrl("https://example.com/a"), "https://example.com/a")
  const manyTags = uniqueSelectNames([
    TAG_OVERFLOW_SENTINEL,
    ...Array.from({ length: 105 }, (_, index) => `tag-${index}`),
  ])
  assert.equal(manyTags.length, 100)
  assert.equal(
    manyTags.filter((tag) => tag === TAG_OVERFLOW_SENTINEL).length,
    1
  )
  assert.equal(
    manyTags.filter((tag) => tag !== TAG_OVERFLOW_SENTINEL).length,
    99
  )
  assert.deepEqual(
    manyTags,
    uniqueSelectNames([
      ...Array.from({ length: 105 }, (_, index) => `tag-${index}`),
      TAG_OVERFLOW_SENTINEL,
    ])
  )

  const longTag = uniqueSelectNames(["x".repeat(512)])[0]
  assert.equal([...longTag].length, 100)
  assert.match(longTag, /…#[0-9a-f]{12}$/)
  assert.equal(longTag, uniqueSelectNames(["x".repeat(512)])[0])
  const collidingPrefixes = uniqueSelectNames([
    `${"same-prefix".repeat(20)}-a`,
    `${"same-prefix".repeat(20)}-b`,
  ])
  assert.equal(collidingPrefixes.length, 2)
  assert.notEqual(collidingPrefixes[0], collidingPrefixes[1])

  const emojiTag = uniqueSelectNames(["📚".repeat(100)])[0]
  assert.ok(emojiTag.length <= 100)
  assert.match(emojiTag, /…#[0-9a-f]{12}$/)
})

test("incremental windows pin a checkpoint and overlap completed cycles", () => {
  const now = Date.parse("2026-07-03T12:00:00.000Z")
  const initial = incrementalWindow(undefined, TEST_CREDENTIAL_FINGERPRINT, now)
  assert.equal(initial.updatedAfter, INITIAL_UPDATED_AFTER)
  assert.equal(initial.credentialFingerprint, TEST_CREDENTIAL_FINGERPRINT)
  assert.equal(
    initial.checkpoint,
    new Date(now - CONSISTENCY_BUFFER_MS).toISOString()
  )

  const completed = completedIncrementalState(
    initial.checkpoint,
    TEST_CREDENTIAL_FINGERPRINT
  )
  assert.equal(
    completed.updatedAfter,
    new Date(
      Date.parse(initial.checkpoint) - WATERMARK_OVERLAP_MS
    ).toISOString()
  )
  assert.equal("checkpoint" in completed, false)
  assert.throws(
    () => incrementalWindow(completed, "b".repeat(64)),
    /credentials changed/
  )
})

test("cursor state detects loops without storing raw provider cursors", () => {
  const guarded = nextCursorState(undefined, "cursor-a", "fixtures")
  const continued = nextCursorState(guarded, "cursor-b", "fixtures")
  assert.equal(guarded.pageCount, 1)
  assert.equal(continued.pageCount, 2)
  assert.equal(JSON.stringify(continued).includes("cursor-a"), false)
  assert.throws(
    () => nextCursorState(guarded, "cursor-a", "fixtures"),
    /repeated a cursor/
  )
  assert.throws(
    () =>
      nextCursorState(undefined, "x".repeat(MAX_CURSOR_LENGTH + 1), "fixtures"),
    /invalid pageCursor/
  )
  assert.throws(
    () =>
      incrementalWindow(
        {
          credentialFingerprint: TEST_CREDENTIAL_FINGERPRINT,
          updatedAfter: INITIAL_UPDATED_AFTER,
          pageCursor: "orphaned-cursor",
        },
        TEST_CREDENTIAL_FINGERPRINT
      ),
    /without a pinned checkpoint/
  )
})

test("continuation state and pagination retries stay bounded", () => {
  const safe = boundedSyncState({ value: "x".repeat(1_024) }, "test fixture")
  assert.ok(syncStateSize(safe) < MAX_SAFE_SYNC_STATE_BYTES)
  assert.throws(
    () =>
      boundedSyncState(
        { value: "x".repeat(MAX_SAFE_SYNC_STATE_BYTES) },
        "test fixture"
      ),
    /exceeded the 240 KiB safety budget/
  )
  assert.equal(nextPaginationRestartCount(0, "fixtures"), 1)
  assert.throws(
    () => nextPaginationRestartCount(MAX_PAGINATION_RESTARTS, "fixtures"),
    /remained unstable after 3 retries/
  )
})

test("Sources keep one checkpoint across Books, Export, and Reader", async () => {
  const { reader, books, exported } = await parsedFixtures()
  const calls: Array<{
    endpoint: "books" | "reader" | "readwise"
    updatedAfter?: string
    updatedBefore?: string
    pageCursor?: string
    page?: number
    includeDeleted?: boolean
  }> = []
  const client = queuedClient({
    calls,
    books: [
      {
        books: [books.books[0]],
        count: 2,
        nextPage: 2,
      },
      {
        books: [books.books[1]],
        count: 2,
        nextPage: undefined,
      },
    ],
    exported: [
      { sources: [exported.sources[0]], nextPageCursor: "export-next" },
      { sources: [exported.sources[1]], nextPageCursor: undefined },
    ],
    reader: [
      {
        documents: reader.documents.slice(0, 3),
        nextPageCursor: "reader-next",
      },
      { documents: [reader.documents[3]], nextPageCursor: undefined },
    ],
  })
  const now = Date.parse("2026-07-03T12:00:00.000Z")

  const first = await runSourcesIncrementalPage(client, undefined, now)
  const firstState = first.nextState as SourcesIncrementalSyncState
  assert.equal(firstState.phase, "books")
  assert.equal(firstState.pageCursor, "2")
  assert.equal(first.changes[0].key, "readwise:502")
  assert.equal("Source" in first.changes[0].properties, true)

  const second = await runSourcesIncrementalPage(client, firstState, now)
  const secondState = second.nextState as SourcesIncrementalSyncState
  assert.equal(secondState.phase, "readwise")
  assert.equal(secondState.pageCursor, undefined)
  assert.deepEqual(second.changes, [])

  const third = await runSourcesIncrementalPage(client, secondState, now)
  const thirdState = third.nextState as SourcesIncrementalSyncState
  assert.equal(thirdState.phase, "readwise")
  assert.equal(thirdState.pageCursor, "export-next")
  assert.equal(third.changes[0].key, "reader:reader-document-1")

  const fourth = await runSourcesIncrementalPage(client, thirdState, now)
  const fourthState = fourth.nextState as SourcesIncrementalSyncState
  assert.equal(fourthState.phase, "reader")
  assert.equal(fourthState.pageCursor, undefined)

  const fifth = await runSourcesIncrementalPage(client, fourthState, now)
  const fifthState = fifth.nextState as SourcesIncrementalSyncState
  assert.equal(fifthState.phase, "reader")
  assert.equal(fifthState.pageCursor, "reader-next")
  assert.deepEqual(
    fifth.changes.map((change) => change.key),
    ["reader:reader-document-1"]
  )

  const sixth = await runSourcesIncrementalPage(client, fifthState, now)
  assert.equal(sixth.hasMore, false)
  assert.equal(
    sixth.nextState.updatedAfter,
    new Date(now - CONSISTENCY_BUFFER_MS - WATERMARK_OVERLAP_MS).toISOString()
  )
  assert.equal(sixth.changes[0].key, "reader:reader-document-2")

  assert.deepEqual(
    calls.map(
      ({
        endpoint,
        updatedAfter,
        updatedBefore,
        pageCursor,
        page,
        includeDeleted,
      }) => ({
        endpoint,
        updatedAfter,
        updatedBefore,
        pageCursor,
        page,
        includeDeleted,
      })
    ),
    [
      {
        endpoint: "books",
        updatedAfter: INITIAL_UPDATED_AFTER,
        updatedBefore: new Date(now - CONSISTENCY_BUFFER_MS).toISOString(),
        pageCursor: undefined,
        page: undefined,
        includeDeleted: undefined,
      },
      {
        endpoint: "books",
        updatedAfter: INITIAL_UPDATED_AFTER,
        updatedBefore: new Date(now - CONSISTENCY_BUFFER_MS).toISOString(),
        pageCursor: undefined,
        page: 2,
        includeDeleted: undefined,
      },
      {
        endpoint: "readwise",
        updatedAfter: INITIAL_UPDATED_AFTER,
        updatedBefore: undefined,
        pageCursor: undefined,
        page: undefined,
        includeDeleted: false,
      },
      {
        endpoint: "readwise",
        updatedAfter: INITIAL_UPDATED_AFTER,
        updatedBefore: undefined,
        pageCursor: "export-next",
        page: undefined,
        includeDeleted: false,
      },
      {
        endpoint: "reader",
        updatedAfter: INITIAL_UPDATED_AFTER,
        updatedBefore: undefined,
        pageCursor: undefined,
        page: undefined,
        includeDeleted: undefined,
      },
      {
        endpoint: "reader",
        updatedAfter: INITIAL_UPDATED_AFTER,
        updatedBefore: undefined,
        pageCursor: "reader-next",
        page: undefined,
        includeDeleted: undefined,
      },
    ]
  )
  const allChanges = [
    ...first.changes,
    ...second.changes,
    ...third.changes,
    ...fourth.changes,
    ...fifth.changes,
    ...sixth.changes,
  ]
  assert.deepEqual(
    allChanges.map((change) => change.type),
    allChanges.map(() => "upsert")
  )
})

test("Sources restart when the Books count shifts between pages", async () => {
  const { books } = await parsedFixtures()
  const client = queuedClient({
    books: [
      {
        books: [books.books[0]],
        count: 1_001,
        nextPage: 2,
      },
      {
        books: [books.books[1]],
        count: 1_000,
        nextPage: undefined,
      },
    ],
  })

  await assert.rejects(
    () =>
      runSourcesIncrementalPage(client, {
        credentialFingerprint: TEST_CREDENTIAL_FINGERPRINT,
        updatedAfter: INITIAL_UPDATED_AFTER,
        checkpoint: "2026-07-03T12:00:00.000Z",
        phase: "books",
        booksExpectedCount: 1_001,
      }),
    /incomplete Books pagination/
  )

  const first = await runSourcesIncrementalPage(client, undefined)
  const result = await runSourcesIncrementalPage(
    client,
    first.nextState as SourcesIncrementalSyncState
  )
  const restarted = result.nextState as SourcesIncrementalSyncState

  assert.deepEqual(result.changes, [])
  assert.equal(result.hasMore, true)
  assert.equal(restarted.phase, "books")
  assert.equal(restarted.paginationRestartCount, 1)
  assert.equal(restarted.pageCursor, undefined)
})

test("Highlights skip historical tombstones, then retain new tombstones", async () => {
  const { exported } = await parsedFixtures()
  const activeSource = {
    ...exported.sources[0],
    highlights: [exported.sources[0].highlights[0]],
  }
  const deletedSource = {
    ...exported.sources[0],
    highlights: [exported.sources[0].highlights[1]],
  }
  const calls: Array<{
    endpoint: "reader" | "readwise"
    updatedAfter?: string
    pageCursor?: string
    includeDeleted?: boolean
  }> = []
  const client = queuedClient({
    calls,
    exported: [
      { sources: [activeSource], nextPageCursor: undefined },
      { sources: [deletedSource], nextPageCursor: undefined },
    ],
  })
  const now = Date.parse("2026-07-03T12:00:00.000Z")

  const initial = await runHighlightsIncrementalPage(client, undefined, now)
  assert.equal(calls[0].includeDeleted, false)
  assert.equal(initial.changes[0].key, "highlight:9001")

  const next = await runHighlightsIncrementalPage(
    client,
    initial.nextState as IncrementalSyncState,
    now + 15 * 60_000
  )
  assert.equal(calls[1].includeDeleted, true)
  assert.equal(next.changes[0].type, "upsert")
  assert.equal(next.changes[0].key, "highlight:9002")
  assert.deepEqual(
    next.changes[0].properties["Removed upstream"],
    Builder.checkbox(true)
  )
})

test("failed continuations replay the last committed cursor", async () => {
  const { exported } = await parsedFixtures()
  const seen: Array<{ updatedAfter?: string; pageCursor?: string }> = []
  let fail = false
  let successfulCalls = 0
  const client: ReadwiseClient = {
    credentialFingerprint() {
      return TEST_CREDENTIAL_FINGERPRINT
    },
    async listReaderDocuments() {
      return { documents: [], nextPageCursor: undefined }
    },
    async listReadwiseBooks() {
      throw new Error("unexpected Books request")
    },
    async exportHighlights(options) {
      seen.push(options)
      if (fail) throw new Error("fixture outage")
      successfulCalls += 1
      return {
        sources: successfulCalls === 1 ? [exported.sources[1]] : [],
        nextPageCursor: successfulCalls === 1 ? "safe-cursor" : undefined,
      }
    },
  }

  const first = await runHighlightsIncrementalPage(client, undefined)
  fail = true
  await assert.rejects(
    () => runHighlightsIncrementalPage(client, first.nextState),
    /fixture outage/
  )
  fail = false
  await runHighlightsIncrementalPage(client, first.nextState)

  assert.deepEqual(seen[1], seen[2])
  assert.equal(seen[1].pageCursor, "safe-cursor")
  assert.equal(seen[1].updatedAfter, INITIAL_UPDATED_AFTER)
})

test("cursor loops restart the pinned traversal without emitting suspect pages", async () => {
  const calls: Array<{ updatedAfter?: string; pageCursor?: string }> = []
  const client: ReadwiseClient = {
    credentialFingerprint() {
      return TEST_CREDENTIAL_FINGERPRINT
    },
    async listReaderDocuments() {
      throw new Error("unexpected Reader request")
    },
    async listReadwiseBooks() {
      throw new Error("unexpected Books request")
    },
    async exportHighlights(options) {
      calls.push(options)
      return {
        sources: [],
        nextPageCursor: calls.length < 3 ? "loop" : undefined,
      }
    },
  }

  const first = await runHighlightsIncrementalPage(client, undefined)
  const restarted = await runHighlightsIncrementalPage(client, first.nextState)
  assert.equal(restarted.hasMore, true)
  assert.deepEqual(restarted.changes, [])
  assert.equal(
    "pageCursor" in restarted.nextState
      ? restarted.nextState.pageCursor
      : undefined,
    undefined
  )
  assert.equal(restarted.nextState.paginationRestartCount, 1)

  const recovered = await runHighlightsIncrementalPage(
    client,
    restarted.nextState
  )
  assert.equal(recovered.hasMore, false)
  assert.deepEqual(
    calls.map(({ updatedAfter, pageCursor }) => ({
      updatedAfter,
      pageCursor,
    })),
    [
      { updatedAfter: INITIAL_UPDATED_AFTER, pageCursor: undefined },
      { updatedAfter: INITIAL_UPDATED_AFTER, pageCursor: "loop" },
      { updatedAfter: INITIAL_UPDATED_AFTER, pageCursor: undefined },
    ]
  )
})

test("duplicate keys in one provider page fail instead of racing updates", async () => {
  const { exported } = await parsedFixtures()
  const highlight = exported.sources[0].highlights[0]
  const source = {
    ...exported.sources[0],
    highlights: [highlight, highlight],
  }
  const client = queuedClient({
    exported: [{ sources: [source], nextPageCursor: undefined }],
  })

  await assert.rejects(
    () => runHighlightsIncrementalPage(client, undefined),
    /duplicate key highlight:9001/
  )
})
