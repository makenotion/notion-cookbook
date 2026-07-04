import assert from "node:assert/strict"
import test from "node:test"

import { RateLimitError } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"

import { credentialFingerprintForToken } from "./src/credential.js"
import { highlightSchema, highlightToChange } from "./src/highlights.js"
import worker from "./src/index.js"
import {
  MAX_RESPONSE_BYTES,
  ReadwiseApiError,
  createReadwiseClient,
  type ReaderDocumentPage,
  type ReadwiseClient,
  type ReadwiseExportPage,
  type ReadwiseSource,
} from "./src/readwise.js"
import {
  exportSourceKey,
  exportSourceToChange,
  exportSourceToReconciliationChange,
  readerDocumentToChange,
  readerSourceKey,
  sourceSchema,
} from "./src/sources.js"
import {
  CONSISTENCY_BUFFER_MS,
  INITIAL_UPDATED_AFTER,
  MAX_CURSOR_LENGTH,
  MAX_REPLACEMENT_CURSOR_PAGES,
  MAX_REPLACEMENT_IDENTITIES,
  MAX_REPLACEMENT_RECORDS,
  MAX_SAFE_SYNC_STATE_BYTES,
  SYNC_STATE_VERSION,
  WATERMARK_OVERLAP_MS,
  advanceGuardedInventory,
  boundedSyncState,
  completedIncrementalState,
  incrementalWindow,
  nextCursorState,
  syncStateSize,
  validateReconciliationState,
  type CursorGuardState,
  type IncrementalSyncState,
  type ReconciliationSyncState,
  type SourcesReconciliationSyncState,
} from "./src/state.js"
import {
  runHighlightsIncrementalPage,
  runHighlightsReconciliationPage,
  runSourcesIncrementalPage,
  runSourcesReconciliationPage,
} from "./src/syncs.js"
import {
  boundedText,
  displayLabel,
  readerTagNames,
  validUrl,
} from "./src/values.js"

const readerFixture = {
  count: 3,
  nextPageCursor: "reader-page-2",
  results: [
    {
      id: "reader-document-1",
      url: "https://read.readwise.io/new/read/reader-document-1",
      source_url: "https://example.com/durable-notes",
      title: "Durable notes for software teams",
      author: "A. Reader",
      source: "Reader add from import URL",
      category: "article",
      location: "later",
      tags: {
        engineering: { name: "Engineering" },
        "to-share": { name: "To share" },
      },
      site_name: "Example Engineering",
      word_count: 2_400,
      reading_time: "12 mins",
      listening_time: null,
      created_at: "2026-06-01T10:00:00Z",
      updated_at: "2026-06-02T12:00:00Z",
      published_date: "2026-05-31",
      notes: "Discuss this with the platform team.",
      summary: "How durable notes preserve decisions across tools.",
      image_url: "https://example.com/cover.png",
      parent_id: null,
      reading_progress: 0.55,
      first_opened_at: "2026-06-01T11:00:00Z",
      last_opened_at: "2026-06-02T11:45:00Z",
      saved_at: "2026-06-01T10:00:00Z",
      last_moved_at: "2026-06-01T10:05:00Z",
    },
    {
      id: "reader-note-1",
      url: "https://read.readwise.io/new/read/reader-note-1",
      source_url: null,
      title: "A nested Reader note",
      author: null,
      source: "Reader",
      category: "note",
      location: "new",
      tags: {},
      site_name: null,
      word_count: 8,
      reading_time: null,
      listening_time: null,
      created_at: "2026-06-02T12:00:00Z",
      updated_at: "2026-06-02T12:00:00Z",
      published_date: null,
      notes: null,
      summary: null,
      image_url: null,
      parent_id: "reader-document-1",
      reading_progress: null,
      first_opened_at: null,
      last_opened_at: null,
      saved_at: "2026-06-02T12:00:00Z",
      last_moved_at: null,
    },
    {
      id: "reader-document-2",
      url: "https://read.readwise.io/archive/read/reader-document-2",
      source_url: "https://example.com/design.pdf",
      title: "A practical systems design guide",
      author: "B. Builder",
      source: "Reader upload",
      category: "pdf",
      location: "archive",
      tags: {},
      site_name: "Example Research",
      word_count: 12_000,
      reading_time: "60 mins",
      listening_time: null,
      created_at: "2026-05-01T10:00:00Z",
      updated_at: "2026-06-03T09:00:00Z",
      published_date: "2026-04-15",
      notes: "Finished.",
      summary: "A systems design reference.",
      image_url: null,
      parent_id: null,
      reading_progress: 1,
      first_opened_at: "2026-05-02T10:00:00Z",
      last_opened_at: "2026-06-03T08:00:00Z",
      saved_at: "2026-05-01T10:00:00Z",
      last_moved_at: "2026-06-03T09:00:00Z",
    },
  ],
} satisfies Record<string, unknown>

const exportFixture = {
  count: 2,
  nextPageCursor: "export-page-2",
  results: [
    {
      user_book_id: 501,
      is_deleted: false,
      title: "Durable notes for software teams",
      readable_title: "Durable notes for software teams",
      author: "A. Reader",
      source: "reader",
      cover_image_url: "https://example.com/cover.png",
      unique_url: "https://example.com/durable-notes",
      book_tags: [{ id: 1, name: "Engineering" }],
      category: "articles",
      document_note: "Discuss this with the platform team.",
      summary: "How durable notes preserve decisions across tools.",
      readwise_url: "https://readwise.io/bookreview/501",
      source_url: "https://example.com/durable-notes",
      external_id: "reader-document-1",
      asin: null,
      highlights: [
        {
          id: 9_001,
          is_deleted: false,
          text: "A durable note should retain the decision, its context, and the source that changed the team's mind.",
          location: 12,
          location_type: "order",
          note: "This should become an architecture-decision prompt.",
          color: "yellow",
          highlighted_at: "2026-06-02T11:30:00Z",
          created_at: "2026-06-02T11:30:01Z",
          updated_at: "2026-06-02T12:30:00Z",
          external_id: "reader-highlight-9001",
          end_location: 13,
          url: "https://example.com/durable-notes#decision",
          book_id: 501,
          tags: [{ id: 2, name: "Architecture" }],
          is_favorite: true,
          is_discard: false,
          readwise_url: "https://readwise.io/open/9001",
        },
        {
          id: 9_002,
          is_deleted: true,
          text: null,
          location: null,
          location_type: null,
          note: null,
          color: null,
          highlighted_at: null,
          created_at: null,
          updated_at: "2026-06-02T12:35:00Z",
          external_id: null,
          end_location: null,
          url: null,
          book_id: 501,
          tags: [],
          is_favorite: false,
          is_discard: false,
          readwise_url: null,
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
      cover_image_url: null,
      unique_url: "",
      book_tags: [{ id: 3, name: "Distributed systems" }],
      category: "books",
      document_note: "",
      summary: "",
      readwise_url: "https://readwise.io/bookreview/502",
      source_url: "",
      external_id: null,
      asin: "1449373321",
      highlights: [
        {
          id: 9_100,
          is_deleted: false,
          text: "Reliability means continuing to work correctly, even when things go wrong.",
          location: 42,
          location_type: "location",
          note: null,
          color: "blue",
          highlighted_at: "2026-05-20T10:00:00Z",
          created_at: "2026-05-20T10:00:00Z",
          updated_at: "2026-05-20T10:00:00Z",
          external_id: "kindle-9100",
          end_location: 43,
          url: null,
          book_id: 502,
          tags: [],
          is_favorite: false,
          is_discard: false,
          readwise_url: "https://readwise.io/open/9100",
        },
      ],
    },
  ],
} satisfies Record<string, unknown>

process.env.READWISE_ACCESS_TOKEN = "offline-fixture-token"
process.env.READWISE_CREDENTIAL_FINGERPRINT = credentialFingerprintForToken(
  process.env.READWISE_ACCESS_TOKEN
)

const TEST_CREDENTIAL_FINGERPRINT = "f".repeat(64)

test("worker manifest registers related databases and four guarded schedules", () => {
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

  assert.deepEqual(Object.keys(sourceSchema.properties), [
    "Source",
    "Location",
    "Reading Progress",
    "Category",
    "Author",
    "Site",
    "Tags",
    "Open in Reader",
    "Saved",
    "Last Opened",
    "Summary",
    "Note",
    "Origin",
    "Archived",
    "Reading Time",
    "Word Count",
    "Published",
    "Updated",
    "Original URL",
    "Readwise Review",
    "Summary Truncated",
    "Note Truncated",
    "Reader Document ID",
    "Readwise Source ID",
    "Source Key",
  ])
  assert.deepEqual(Object.keys(highlightSchema.properties), [
    "Highlight",
    "Source",
    "Note",
    "Tags",
    "Highlighted",
    "Favorite",
    "Discarded",
    "Open in Readwise",
    "Source Author",
    "Quote",
    "Origin",
    "Color",
    "Source URL",
    "Location",
    "Location Type",
    "Created",
    "Updated",
    "Source Title",
    "Quote Truncated",
    "Note Truncated",
    "External ID",
    "Readwise Source ID",
    "Highlight Key",
  ])
  assert.equal(
    (sourceSchema.properties["Reading Progress"] as { format?: string }).format,
    "percent"
  )

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
        key: "sourcesReconciliationSync",
        databaseKey: "sources",
        mode: "replace",
        schedule: { type: "interval", intervalMs: 24 * 60 * 60_000 },
      },
      {
        key: "highlightsSync",
        databaseKey: "highlights",
        mode: "incremental",
        schedule: { type: "interval", intervalMs: 15 * 60_000 },
      },
      {
        key: "highlightsReconciliationSync",
        databaseKey: "highlights",
        mode: "replace",
        schedule: { type: "interval", intervalMs: 24 * 60 * 60_000 },
      },
    ]
  )
})

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  })
}

async function parsedFixtures(): Promise<{
  reader: ReaderDocumentPage
  exported: ReadwiseExportPage
}> {
  const client = createReadwiseClient(async () => {}, (async (input) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url
    )
    return jsonResponse(
      url.pathname === "/api/v3/list/" ? readerFixture : exportFixture
    )
  }) as typeof fetch)
  return {
    reader: await client.listReaderDocuments({}),
    exported: await client.exportHighlights({ includeDeleted: true }),
  }
}

function activeExportPage(page: ReadwiseExportPage): ReadwiseExportPage {
  return {
    ...page,
    sources: page.sources
      .filter((source) => !source.is_deleted)
      .map((source) => ({
        ...source,
        highlights: source.highlights.filter(
          (highlight) => !highlight.is_deleted
        ),
      })),
    nextPageCursor: undefined,
  }
}

function queuedClient(options: {
  reader?: ReaderDocumentPage[]
  exported?: ReadwiseExportPage[]
  credentialFingerprint?: string
}): ReadwiseClient {
  let readerIndex = 0
  let exportIndex = 0
  return {
    credentialFingerprint() {
      return options.credentialFingerprint ?? TEST_CREDENTIAL_FINGERPRINT
    },
    async listReaderDocuments() {
      const page = options.reader?.[readerIndex]
      assert.ok(page, `unexpected Reader request ${readerIndex + 1}`)
      readerIndex += 1
      return page
    },
    async exportHighlights() {
      const page = options.exported?.[exportIndex]
      assert.ok(page, `unexpected Export request ${exportIndex + 1}`)
      exportIndex += 1
      return page
    },
  }
}

type SourceReconciliationResult = Awaited<
  ReturnType<typeof runSourcesReconciliationPage>
>
type HighlightReconciliationResult = Awaited<
  ReturnType<typeof runHighlightsReconciliationPage>
>

function requiredSourceState(
  result: SourceReconciliationResult
): SourcesReconciliationSyncState {
  assert.equal(result.hasMore, true)
  if (!("nextState" in result) || !result.nextState) {
    throw new Error("expected source reconciliation continuation state")
  }
  return result.nextState
}

function requiredHighlightState(
  result: HighlightReconciliationResult
): ReconciliationSyncState {
  assert.equal(result.hasMore, true)
  if (!("nextState" in result) || !result.nextState) {
    throw new Error("expected highlight reconciliation continuation state")
  }
  return result.nextState
}

async function runSinglePageSourcePass(
  client: ReadwiseClient,
  state: SourcesReconciliationSyncState | undefined
) {
  const collection = await runSourcesReconciliationPage(client, state)
  const readwise = await runSourcesReconciliationPage(
    client,
    requiredSourceState(collection)
  )
  const reader = await runSourcesReconciliationPage(
    client,
    requiredSourceState(readwise)
  )
  return { collection, readwise, reader }
}

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
  assert.equal(requests[0].url.origin, "https://readwise.io")
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
  assert.equal(page.documents.length, 3)
  assert.equal(page.nextPageCursor, "reader-page-2")
})

test("typed client requests deletion tombstones from Readwise Export", async () => {
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
  assert.equal(page.sources.length, 2)
  assert.equal(page.sources[0].highlights[1].is_deleted, true)
})

test("429 responses become retryable Workers errors", async () => {
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

test("malformed provider pages fail closed", async () => {
  for (const nextPageCursor of [undefined, "   ", 42]) {
    const body: Record<string, unknown> = { count: 0, results: [] }
    if (nextPageCursor !== undefined) body.nextPageCursor = nextPageCursor
    const client = createReadwiseClient(async () => {}, (async () =>
      jsonResponse(body)) as typeof fetch)
    await assert.rejects(
      () => client.listReaderDocuments({}),
      /invalid nextPageCursor/
    )
    await assert.rejects(
      () => client.exportHighlights({ includeDeleted: false }),
      /invalid nextPageCursor/
    )
  }

  const terminalClient = createReadwiseClient(async () => {}, (async () =>
    jsonResponse({
      count: 0,
      nextPageCursor: null,
      results: [],
    })) as typeof fetch)
  assert.equal(
    (await terminalClient.listReaderDocuments({})).nextPageCursor,
    undefined
  )
  assert.equal(
    (await terminalClient.exportHighlights({ includeDeleted: false }))
      .nextPageCursor,
    undefined
  )
})

test("the deployment fingerprint rejects credential changes before requests", async () => {
  const originalToken = process.env.READWISE_ACCESS_TOKEN
  const originalFingerprint = process.env.READWISE_CREDENTIAL_FINGERPRINT
  let requests = 0
  try {
    const client = createReadwiseClient(async () => {}, (async () => {
      requests += 1
      return jsonResponse({ count: 0, nextPageCursor: null, results: [] })
    }) as typeof fetch)
    process.env.READWISE_ACCESS_TOKEN = "  first-private-token  "
    process.env.READWISE_CREDENTIAL_FINGERPRINT = credentialFingerprintForToken(
      "first-private-token"
    )
    const first = client.credentialFingerprint()
    process.env.READWISE_ACCESS_TOKEN = "first-private-token"
    assert.equal(client.credentialFingerprint(), first)

    process.env.READWISE_ACCESS_TOKEN = "second-private-token"
    assert.throws(
      () => client.credentialFingerprint(),
      /does not match READWISE_CREDENTIAL_FINGERPRINT/
    )
    await assert.rejects(
      () => client.listReaderDocuments({}),
      /does not match READWISE_CREDENTIAL_FINGERPRINT/
    )
    assert.equal(requests, 0)

    process.env.READWISE_CREDENTIAL_FINGERPRINT = credentialFingerprintForToken(
      "second-private-token"
    )
    const second = client.credentialFingerprint()

    assert.match(first, /^[0-9a-f]{64}$/)
    assert.notEqual(second, first)
    assert.equal(first.includes("first-private-token"), false)
    assert.equal(second.includes("second-private-token"), false)
  } finally {
    if (originalToken === undefined) delete process.env.READWISE_ACCESS_TOKEN
    else process.env.READWISE_ACCESS_TOKEN = originalToken
    if (originalFingerprint === undefined) {
      delete process.env.READWISE_CREDENTIAL_FINGERPRINT
    } else {
      process.env.READWISE_CREDENTIAL_FINGERPRINT = originalFingerprint
    }
  }
})

test("successful response bodies are byte-bounded before JSON parsing", async () => {
  const client = createReadwiseClient(
    async () => {},
    (async () =>
      new Response("{}", {
        status: 200,
        headers: { "Content-Length": String(MAX_RESPONSE_BYTES + 1) },
      })) as typeof fetch
  )

  await assert.rejects(
    () => client.listReaderDocuments({}),
    new RegExp(`exceeded ${MAX_RESPONSE_BYTES} bytes`)
  )
})

test("chunked responses are byte-bounded without trusting Content-Length", async () => {
  const client = createReadwiseClient(
    async () => {},
    (async () =>
      new Response(new Uint8Array(MAX_RESPONSE_BYTES + 1), {
        status: 200,
      })) as typeof fetch
  )

  await assert.rejects(
    () => client.exportHighlights({ includeDeleted: true }),
    new RegExp(`exceeded ${MAX_RESPONSE_BYTES} bytes`)
  )
})

test("API errors never echo provider bodies or private reading content", async () => {
  const privateDetail = "private-highlight-text-never-log"
  const client = createReadwiseClient(
    async () => {},
    (async () => new Response(privateDetail, { status: 403 })) as typeof fetch
  )

  await assert.rejects(
    () => client.exportHighlights({ includeDeleted: true }),
    (error: unknown) =>
      error instanceof ReadwiseApiError &&
      error.status === 403 &&
      !error.message.includes(privateDetail)
  )
})

test("delete-controlling flags must be real booleans", async () => {
  const malformedSource = structuredClone(exportFixture) as Record<
    string,
    unknown
  >
  const sourceResults = malformedSource.results as Array<
    Record<string, unknown>
  >
  sourceResults[0].is_deleted = "false"
  const sourceClient = createReadwiseClient(async () => {}, (async () =>
    jsonResponse(malformedSource)) as typeof fetch)
  await assert.rejects(
    () => sourceClient.exportHighlights({ includeDeleted: true }),
    /source is_deleted must be a boolean/
  )

  const malformedHighlight = structuredClone(exportFixture) as Record<
    string,
    unknown
  >
  const highlightResults = malformedHighlight.results as Array<
    Record<string, unknown>
  >
  const highlights = highlightResults[0].highlights as Array<
    Record<string, unknown>
  >
  highlights[0].is_deleted = 0
  const highlightClient = createReadwiseClient(async () => {}, (async () =>
    jsonResponse(malformedHighlight)) as typeof fetch)
  await assert.rejects(
    () => highlightClient.exportHighlights({ includeDeleted: true }),
    /highlight is_deleted must be a boolean/
  )
})

test("provider parsers require source highlights and an explicit Reader parent_id", async () => {
  const missingHighlights = structuredClone(exportFixture) as Record<
    string,
    unknown
  >
  const sources = missingHighlights.results as Array<Record<string, unknown>>
  delete sources[0].highlights
  const exportClient = createReadwiseClient(async () => {}, (async () =>
    jsonResponse(missingHighlights)) as typeof fetch)
  await assert.rejects(
    () => exportClient.exportHighlights({ includeDeleted: true }),
    /source highlights must be an array/
  )

  const missingParent = structuredClone(readerFixture) as Record<
    string,
    unknown
  >
  const documents = missingParent.results as Array<Record<string, unknown>>
  delete documents[0].parent_id
  const readerClient = createReadwiseClient(async () => {}, (async () =>
    jsonResponse(missingParent)) as typeof fetch)
  await assert.rejects(
    () => readerClient.listReaderDocuments({}),
    /Reader parent_id must be null or a valid stable id/
  )
})

test("provider parsers reject malformed identity and ownership fields", async (t) => {
  const exportCases: Array<{
    name: string
    mutate: (source: Record<string, unknown>) => void
    message: RegExp
  }> = [
    {
      name: "missing source discriminator",
      mutate: (source) => delete source.source,
      message: /source source must be a non-empty string/,
    },
    {
      name: "wrong source discriminator type",
      mutate: (source) => {
        source.source = 42
      },
      message: /source source must be a non-empty string/,
    },
    {
      name: "missing source external id",
      mutate: (source) => delete source.external_id,
      message: /source external_id must be a string or null/,
    },
    {
      name: "wrong source external id type",
      mutate: (source) => {
        source.external_id = 42
      },
      message: /source external_id must be a string or null/,
    },
    {
      name: "missing source tags",
      mutate: (source) => delete source.book_tags,
      message: /source tags must be an array/,
    },
    {
      name: "non-numeric source id",
      mutate: (source) => {
        source.user_book_id = "501"
      },
      message: /source is missing a valid stable id/,
    },
  ]

  for (const fixture of exportCases) {
    await t.test(fixture.name, async () => {
      const body = structuredClone(exportFixture) as Record<string, unknown>
      const [source] = body.results as Array<Record<string, unknown>>
      fixture.mutate(source)
      const client = createReadwiseClient(async () => {}, (async () =>
        jsonResponse(body)) as typeof fetch)
      await assert.rejects(
        () => client.exportHighlights({ includeDeleted: true }),
        fixture.message
      )
    })
  }

  const highlightCases: Array<{
    name: string
    mutate: (highlight: Record<string, unknown>) => void
    message: RegExp
  }> = [
    {
      name: "missing highlight external id",
      mutate: (highlight) => delete highlight.external_id,
      message: /highlight external_id must be a string or null/,
    },
    {
      name: "malformed highlight tags",
      mutate: (highlight) => {
        highlight.tags = null
      },
      message: /highlight tags must be an array/,
    },
    {
      name: "missing favorite flag",
      mutate: (highlight) => delete highlight.is_favorite,
      message: /highlight is_favorite must be a boolean/,
    },
    {
      name: "malformed discarded flag",
      mutate: (highlight) => {
        highlight.is_discard = "false"
      },
      message: /highlight is_discard must be a boolean/,
    },
    {
      name: "non-numeric highlight id",
      mutate: (highlight) => {
        highlight.id = "9001"
      },
      message: /highlight is missing a valid stable id/,
    },
    {
      name: "missing documented updated_at",
      mutate: (highlight) => {
        delete highlight.updated_at
        highlight.updated = "2026-06-02T12:30:00Z"
      },
      message: /highlight updated_at must be a string or null/,
    },
  ]

  for (const fixture of highlightCases) {
    await t.test(fixture.name, async () => {
      const body = structuredClone(exportFixture) as Record<string, unknown>
      const [source] = body.results as Array<Record<string, unknown>>
      const [highlight] = source.highlights as Array<Record<string, unknown>>
      fixture.mutate(highlight)
      const client = createReadwiseClient(async () => {}, (async () =>
        jsonResponse(body)) as typeof fetch)
      await assert.rejects(
        () => client.exportHighlights({ includeDeleted: true }),
        fixture.message
      )
    })
  }

  const malformedReader = structuredClone(readerFixture) as Record<
    string,
    unknown
  >
  const [document] = malformedReader.results as Array<Record<string, unknown>>
  document.tags = []
  const readerClient = createReadwiseClient(async () => {}, (async () =>
    jsonResponse(malformedReader)) as typeof fetch)
  await assert.rejects(
    () => readerClient.listReaderDocuments({}),
    /Reader document tags must be an object/
  )
})

test("provider parsers reject invalid dates and numeric domains", async (t) => {
  const readerCases: Array<{
    name: string
    field: string
    value: unknown
    message: RegExp
  }> = [
    {
      name: "invalid updated date",
      field: "updated_at",
      value: "not-a-date",
      message: /updated_at must be a valid date or null/,
    },
    {
      name: "out-of-range reading progress",
      field: "reading_progress",
      value: 1.1,
      message: /reading_progress must be between 0 and 1 or null/,
    },
    {
      name: "negative word count",
      field: "word_count",
      value: -1,
      message: /word_count must be a non-negative integer or null/,
    },
  ]
  for (const fixture of readerCases) {
    await t.test(fixture.name, async () => {
      const body = structuredClone(readerFixture) as Record<string, unknown>
      const [document] = body.results as Array<Record<string, unknown>>
      document[fixture.field] = fixture.value
      const client = createReadwiseClient(async () => {}, (async () =>
        jsonResponse(body)) as typeof fetch)
      await assert.rejects(
        () => client.listReaderDocuments({}),
        fixture.message
      )
    })
  }

  const highlightCases: Array<{
    name: string
    field: string
    value: unknown
    message: RegExp
  }> = [
    {
      name: "invalid highlight date",
      field: "updated_at",
      value: "not-a-date",
      message: /highlight updated_at must be a valid date or null/,
    },
    {
      name: "fractional highlight location",
      field: "location",
      value: 1.5,
      message: /highlight location must be a non-negative integer or null/,
    },
  ]
  for (const fixture of highlightCases) {
    await t.test(fixture.name, async () => {
      const body = structuredClone(exportFixture) as Record<string, unknown>
      const [source] = body.results as Array<Record<string, unknown>>
      const [highlight] = source.highlights as Array<Record<string, unknown>>
      highlight[fixture.field] = fixture.value
      const client = createReadwiseClient(async () => {}, (async () =>
        jsonResponse(body)) as typeof fetch)
      await assert.rejects(
        () => client.exportHighlights({ includeDeleted: true }),
        fixture.message
      )
    })
  }
})

test("provider parsers require non-negative safe integer counts", async (t) => {
  for (const count of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await t.test(`rejects ${String(count)}`, async () => {
      const body = { count, nextPageCursor: null, results: [] }
      const client = createReadwiseClient(async () => {}, (async () =>
        jsonResponse(body)) as typeof fetch)
      await assert.rejects(
        () => client.listReaderDocuments({}),
        /Reader document count must be a non-negative integer/
      )
      await assert.rejects(
        () => client.exportHighlights({ includeDeleted: false }),
        /highlight export count must be a non-negative integer/
      )
    })
  }

  const emptyClient = createReadwiseClient(async () => {}, (async () =>
    jsonResponse({
      count: 0,
      nextPageCursor: null,
      results: [],
    })) as typeof fetch)
  assert.equal((await emptyClient.listReaderDocuments({})).count, 0)
  assert.equal(
    (await emptyClient.exportHighlights({ includeDeleted: false })).count,
    0
  )
})

test("Reader children are excluded while top-level documents keep archive state", async () => {
  const { reader } = await parsedFixtures()
  const changes = reader.documents
    .map((document) => readerDocumentToChange(document))
    .filter((change): change is NonNullable<typeof change> => Boolean(change))

  assert.equal(changes.length, 2)
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
  assert.deepEqual(changes[1].properties.Archived, Builder.checkbox(true))
  assert.equal("pageContentMarkdown" in changes[0], false)
  assert.equal("Readwise Source ID" in changes[0].properties, false)
})

test("Reader and Readwise use one stable source key for Reader-backed highlights", async () => {
  const { reader, exported } = await parsedFixtures()
  const readerDocument = reader.documents[0]
  const source = exported.sources[0]
  const sourceChange = exportSourceToChange(source)

  assert.equal(readerSourceKey(readerDocument.id), "reader:reader-document-1")
  assert.equal(exportSourceKey(source), "reader:reader-document-1")
  assert.ok(sourceChange)
  assert.equal(sourceChange.key, "reader:reader-document-1")
  assert.equal(exportSourceKey(exported.sources[1]), "readwise:502")
})

test("highlights relate to stable Sources and preserve user-owned page content", async () => {
  const { exported } = await parsedFixtures()
  const source = exported.sources[0]
  const change = highlightToChange(source, source.highlights[0])

  assert.equal(change.type, "upsert")
  if (change.type !== "upsert") return
  assert.equal(change.key, "highlight:9001")
  assert.deepEqual(change.properties.Source, [
    Builder.relation("reader:reader-document-1"),
  ])
  assert.deepEqual(change.properties.Favorite, Builder.checkbox(true))
  assert.deepEqual(change.properties.Color, Builder.select("Yellow"))
  assert.deepEqual(change.properties["Location Type"], Builder.select("Order"))
  assert.deepEqual(
    change.properties["Open in Readwise"],
    Builder.url("https://readwise.io/open/9001")
  )
  assert.equal("pageContentMarkdown" in change, false)
})

test("Readwise deletion flags become explicit deletes", async () => {
  const { exported } = await parsedFixtures()
  const source = exported.sources[0]
  assert.deepEqual(highlightToChange(source, source.highlights[1]), {
    type: "delete",
    key: "highlight:9002",
  })

  const deletedSource = { ...source, is_deleted: true }
  assert.equal(exportSourceToChange(deletedSource), undefined)
  assert.deepEqual(highlightToChange(deletedSource, source.highlights[0]), {
    type: "delete",
    key: "highlight:9001",
  })

  const deletedKindleSource = {
    ...exported.sources[1],
    is_deleted: true,
  }
  assert.deepEqual(exportSourceToChange(deletedKindleSource), {
    type: "delete",
    key: "readwise:502",
  })

  const deletedUnlinkedReaderSource = {
    ...source,
    external_id: null,
    is_deleted: true,
  }
  assert.deepEqual(exportSourceToChange(deletedUnlinkedReaderSource), {
    type: "delete",
    key: "readwise:501",
  })
})

test("Reader-backed Export deltas update only Export-owned identity fields", async () => {
  const { exported } = await parsedFixtures()
  const change = exportSourceToChange(exported.sources[0])
  assert.ok(change && change.type === "upsert")
  assert.deepEqual(Object.keys(change.properties).sort(), [
    "Reader Document ID",
    "Readwise Review",
    "Readwise Source ID",
    "Source Key",
  ])
  assert.equal("Source" in change.properties, false)
  assert.equal("Original URL" in change.properties, false)
})

test("source reconciliation clears fields owned by a departed provider", async () => {
  const { reader, exported } = await parsedFixtures()
  const exportFallback = exportSourceToReconciliationChange(
    exported.sources[0],
    false
  )
  if (!("Location" in exportFallback.properties)) {
    assert.fail("expected a complete Export fallback row")
  }
  assert.deepEqual(exportFallback.properties.Location, [])
  assert.deepEqual(exportFallback.properties.Site, [])
  assert.deepEqual(exportFallback.properties["Open in Reader"], [])
  assert.deepEqual(exportFallback.properties["Reading Progress"], [])
  assert.deepEqual(exportFallback.properties.Saved, [])

  const readerFallback = readerDocumentToChange(reader.documents[0], {
    exportPresent: false,
  })
  assert.ok(readerFallback)
  assert.deepEqual(readerFallback.properties["Readwise Review"], [])
  assert.deepEqual(readerFallback.properties["Readwise Source ID"], [])
})

test("empty or invalid preferred source metadata falls back safely", async () => {
  const { exported } = await parsedFixtures()
  const source: ReadwiseSource = {
    ...exported.sources[1],
    readable_title: "   ",
    title: "Fallback source title",
    source_url: "javascript:alert(1)",
    unique_url: "https://example.com/fallback-source",
  }
  const sourceChange = exportSourceToChange(source)
  assert.ok(sourceChange && sourceChange.type === "upsert")
  if (!("Source" in sourceChange.properties)) {
    assert.fail("expected a complete standalone Export row")
  }
  assert.deepEqual(
    sourceChange.properties.Source,
    Builder.title("Fallback source title")
  )
  assert.deepEqual(
    sourceChange.properties["Original URL"],
    Builder.url("https://example.com/fallback-source")
  )

  const highlightChange = highlightToChange(
    { ...source, source_url: "https://example.com/source-fallback" },
    { ...source.highlights[0], url: "javascript:alert(1)" }
  )
  assert.equal(highlightChange.type, "upsert")
  if (highlightChange.type !== "upsert") return
  assert.deepEqual(
    highlightChange.properties["Source Title"],
    Builder.richText("Fallback source title")
  )
  assert.deepEqual(
    highlightChange.properties["Source URL"],
    Builder.url("https://example.com/source-fallback")
  )
})

test("long text is visibly bounded instead of silently overflowing Notion", () => {
  const result = boundedText("x".repeat(2_100))
  assert.equal(result.truncated, true)
  assert.equal([...(result.text ?? "")].length, 1_900)
  assert.ok(result.text?.endsWith("…"))
})

test("labels, tags, and URLs are deterministic and safe", () => {
  assert.equal(displayLabel("pdf"), "PDF")
  assert.equal(displayLabel("rss_feed"), "RSS Feed")
  assert.equal(displayLabel("time-offset"), "Time Offset")
  assert.equal(displayLabel("  "), undefined)
  assert.deepEqual(
    readerTagNames({ z: { name: "Zed" }, a: { name: "Alpha" }, raw: null }),
    ["Alpha", "raw", "Zed"]
  )
  assert.deepEqual(readerTagNames([" deep   work ", "topic,one"]), [
    "deep work",
    "topic，one",
  ])
  assert.equal(validUrl("javascript:alert(1)"), undefined)
  assert.equal(validUrl("https://example.com/a"), "https://example.com/a")
  assert.throws(
    () =>
      readerTagNames(Array.from({ length: 101 }, (_, index) => `tag-${index}`)),
    /more than 100 unique tags/
  )
  assert.throws(
    () => readerTagNames(["x".repeat(101)]),
    /tag names cannot exceed 100 characters/
  )
})

test("incremental windows pin a checkpoint and retain a five-minute overlap", () => {
  const now = Date.parse("2026-07-03T12:00:00.000Z")
  const initial = incrementalWindow(undefined, TEST_CREDENTIAL_FINGERPRINT, now)
  assert.equal(initial.updatedAfter, INITIAL_UPDATED_AFTER)
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
})

test("cursor guards reject cycles and incompatible continuation state", () => {
  const guarded = nextCursorState(undefined, "cursor-a", "fixtures")
  const continued = nextCursorState(guarded, "cursor-b", "fixtures")
  assert.equal(guarded.pageCount, 1)
  assert.equal(
    Buffer.from(guarded.cursorFingerprints, "base64url").byteLength,
    12
  )
  assert.equal(
    Buffer.from(continued.cursorFingerprints, "base64url").byteLength,
    24
  )
  assert.equal(JSON.stringify(continued).includes("cursor-a"), false)
  assert.throws(
    () => nextCursorState(guarded, "cursor-a", "fixtures"),
    /repeated a cursor/
  )
  assert.throws(
    () =>
      incrementalWindow(
        {
          stateVersion: SYNC_STATE_VERSION,
          credentialFingerprint: TEST_CREDENTIAL_FINGERPRINT,
          updatedAfter: INITIAL_UPDATED_AFTER,
          checkpoint: "2026-07-03T00:00:00.000Z",
          ...guarded,
          cursorFingerprints: `${guarded.cursorFingerprints}x`,
        },
        TEST_CREDENTIAL_FINGERPRINT
      ),
    /invalid cursor history/
  )
  assert.throws(
    () =>
      incrementalWindow(
        {
          stateVersion: SYNC_STATE_VERSION,
          credentialFingerprint: TEST_CREDENTIAL_FINGERPRINT,
          updatedAfter: INITIAL_UPDATED_AFTER,
          pageCursor: "orphaned-cursor",
        },
        TEST_CREDENTIAL_FINGERPRINT
      ),
    /without a pinned checkpoint/
  )
})

test("worst-case packed reconciliation state stays below 240 and 256 KiB", () => {
  const raw = Array.from({ length: 10_000 }, (_, index) => ({
    namespace: "raw",
    value: `raw-${index}`,
  }))
  const output = raw.map((_, index) => ({
    namespace: "output",
    value: `output-${index}`,
  }))
  const providerItems = raw.map((_, index) => ({
    namespace: "provider-item",
    value: `provider-item-${index}`,
  }))
  assert.equal(
    raw.length + output.length + providerItems.length,
    MAX_REPLACEMENT_IDENTITIES
  )
  const inventory = advanceGuardedInventory(
    undefined,
    undefined,
    MAX_REPLACEMENT_RECORDS,
    raw,
    output,
    "state-size fixture",
    {
      countMode: "export",
      guardIdentities: [...raw, ...output, ...providerItems],
      providerItemIdentities: providerItems,
    }
  )

  let cursors: CursorGuardState | undefined
  for (let index = 0; index < MAX_REPLACEMENT_CURSOR_PAGES; index += 1) {
    cursors = nextCursorState(
      cursors,
      index === MAX_REPLACEMENT_CURSOR_PAGES - 1
        ? "x".repeat(MAX_CURSOR_LENGTH)
        : `cursor-${index}`,
      "state-size fixture",
      MAX_REPLACEMENT_CURSOR_PAGES
    )
  }
  assert.ok(cursors)
  const state: ReconciliationSyncState = {
    stateVersion: SYNC_STATE_VERSION,
    credentialFingerprint: TEST_CREDENTIAL_FINGERPRINT,
    pass: "observe",
    active: inventory.active,
    ...inventory.guard,
    ...cursors,
  }
  validateReconciliationState(state)
  assert.equal(boundedSyncState(state, "state-size fixture"), state)

  const bytes = syncStateSize(state)
  assert.ok(bytes < MAX_SAFE_SYNC_STATE_BYTES, `${bytes} is not below 240 KiB`)
  assert.ok(bytes < 256 * 1_024, `${bytes} is not below 256 KiB`)

  assert.throws(
    () =>
      advanceGuardedInventory(
        undefined,
        undefined,
        MAX_REPLACEMENT_RECORDS + 1,
        [],
        [],
        "oversized fixture"
      ),
    /cannot fit in bounded replacement state/
  )
})

test("combined Source guards fit 7,500 fully unified rows", () => {
  function sourceGuardFixture(count: number) {
    const readerRaw = Array.from({ length: count }, (_, index) => ({
      namespace: "reader-document",
      value: `reader-${index}`,
    }))
    const readerOutput = readerRaw.map((_, index) => ({
      namespace: "reader-source-key",
      value: `reader:reader-${index}`,
    }))
    const reader = advanceGuardedInventory(
      undefined,
      undefined,
      count,
      readerRaw,
      readerOutput,
      "Reader capacity fixture",
      { guardIdentities: readerOutput }
    )

    const exportRaw = readerRaw.map((_, index) => ({
      namespace: "readwise-source",
      value: `source-${index}`,
    }))
    const exportOutput = readerRaw.map((_, index) => ({
      namespace: "readwise-source-key",
      value: `reader:reader-${index}`,
    }))
    const highlights = readerRaw.map((_, index) => ({
      namespace: "readwise-export-highlight",
      value: `highlight-${index}`,
    }))
    return advanceGuardedInventory(
      undefined,
      reader.guard,
      count,
      exportRaw,
      exportOutput,
      "Export capacity fixture",
      {
        countMode: "export",
        guardIdentities: [...exportRaw, ...exportOutput, ...highlights],
        providerItemIdentities: highlights,
      }
    )
  }

  const maximumFullyUnifiedRows = Math.floor(MAX_REPLACEMENT_IDENTITIES / 4)
  const atLimit = sourceGuardFixture(maximumFullyUnifiedRows)
  assert.equal(atLimit.guard.identityCount, MAX_REPLACEMENT_IDENTITIES)
  assert.throws(
    () => sourceGuardFixture(maximumFullyUnifiedRows + 1),
    /exceeded 30000 bounded uniqueness checks/
  )
})

test("Sources keep one updatedAfter boundary across both cursor phases", async () => {
  const { reader, exported } = await parsedFixtures()
  const calls: Array<{
    endpoint: "reader" | "readwise"
    updatedAfter?: string
    pageCursor?: string
  }> = []
  let readerCall = 0
  let exportCall = 0
  const client: ReadwiseClient = {
    credentialFingerprint() {
      return TEST_CREDENTIAL_FINGERPRINT
    },
    async listReaderDocuments(options) {
      calls.push({ endpoint: "reader", ...options })
      readerCall += 1
      return readerCall === 1
        ? {
            documents: reader.documents,
            count: reader.count,
            nextPageCursor: "reader-next",
          }
        : { documents: [], count: reader.count, nextPageCursor: undefined }
    },
    async exportHighlights(options) {
      calls.push({ endpoint: "readwise", ...options })
      exportCall += 1
      return exportCall === 1
        ? {
            sources: exported.sources,
            count: exported.count,
            nextPageCursor: "export-next",
          }
        : { sources: [], count: exported.count, nextPageCursor: undefined }
    },
  }
  const now = Date.parse("2026-07-03T12:00:00.000Z")

  const first = await runSourcesIncrementalPage(client, undefined, now)
  assert.equal(first.hasMore, true)
  assert.equal(first.nextState.phase, "readwise")
  const initialReaderBackedExport = first.changes.find(
    (change) => change.key === "reader:reader-document-1"
  )
  assert.ok(
    initialReaderBackedExport && initialReaderBackedExport.type === "upsert"
  )
  assert.equal("Source" in initialReaderBackedExport.properties, true)

  const second = await runSourcesIncrementalPage(client, first.nextState, now)
  assert.equal(second.nextState.phase, "reader")
  assert.equal(second.nextState.pageCursor, undefined)

  const third = await runSourcesIncrementalPage(client, second.nextState, now)
  assert.equal(third.nextState.phase, "reader")
  assert.equal(third.nextState.pageCursor, "reader-next")

  const fourth = await runSourcesIncrementalPage(client, third.nextState, now)
  assert.equal(fourth.hasMore, false)
  assert.equal("checkpoint" in fourth.nextState, false)
  assert.equal(
    fourth.nextState.updatedAfter,
    new Date(now - CONSISTENCY_BUFFER_MS - WATERMARK_OVERLAP_MS).toISOString()
  )

  assert.deepEqual(
    calls.map(({ endpoint, updatedAfter, pageCursor }) => ({
      endpoint,
      updatedAfter,
      pageCursor,
    })),
    [
      {
        endpoint: "readwise",
        updatedAfter: INITIAL_UPDATED_AFTER,
        pageCursor: undefined,
      },
      {
        endpoint: "readwise",
        updatedAfter: INITIAL_UPDATED_AFTER,
        pageCursor: "export-next",
      },
      {
        endpoint: "reader",
        updatedAfter: INITIAL_UPDATED_AFTER,
        pageCursor: undefined,
      },
      {
        endpoint: "reader",
        updatedAfter: INITIAL_UPDATED_AFTER,
        pageCursor: "reader-next",
      },
    ]
  )
})

test("a failed continuation replays from the last committed cursor", async () => {
  const { exported } = await parsedFixtures()
  const seen: Array<{ updatedAfter?: string; pageCursor?: string }> = []
  let fail = false
  let successfulCalls = 0
  const client: ReadwiseClient = {
    credentialFingerprint() {
      return TEST_CREDENTIAL_FINGERPRINT
    },
    async listReaderDocuments() {
      return { documents: [], count: 0, nextPageCursor: undefined }
    },
    async exportHighlights(options) {
      seen.push(options)
      if (fail) throw new Error("fixture outage")
      successfulCalls += 1
      return {
        sources: successfulCalls === 1 ? exported.sources : [],
        count: exported.count,
        nextPageCursor: successfulCalls === 1 ? "safe-cursor" : undefined,
      }
    },
  }

  const first = await runSourcesIncrementalPage(
    client,
    undefined,
    Date.parse("2026-07-03T12:00:00.000Z")
  )
  fail = true
  await assert.rejects(
    () => runSourcesIncrementalPage(client, first.nextState),
    /fixture outage/
  )
  fail = false
  await runSourcesIncrementalPage(client, first.nextState)

  assert.deepEqual(seen[1], seen[2])
  assert.equal(seen[1].pageCursor, "safe-cursor")
  assert.equal(seen[1].updatedAfter, INITIAL_UPDATED_AFTER)
})

test("credential changes fail before all four capabilities make requests", async (t) => {
  const { reader, exported } = await parsedFixtures()
  const readerPage = { ...reader, nextPageCursor: undefined }
  const exportPage = activeExportPage(exported)

  const sourceIncremental = await runSourcesIncrementalPage(
    queuedClient({ exported: [exportPage] }),
    undefined
  )
  const highlightIncremental = await runHighlightsIncrementalPage(
    queuedClient({ exported: [exportPage] }),
    undefined
  )
  const sourceReconciliation = await runSourcesReconciliationPage(
    queuedClient({ reader: [readerPage] }),
    undefined
  )
  const highlightReconciliation = await runHighlightsReconciliationPage(
    queuedClient({ exported: [exportPage] }),
    undefined
  )

  const cases: Array<{
    name: string
    run: (client: ReadwiseClient) => Promise<unknown>
  }> = [
    {
      name: "Sources incremental",
      run: (client) =>
        runSourcesIncrementalPage(client, sourceIncremental.nextState),
    },
    {
      name: "Highlights incremental",
      run: (client) =>
        runHighlightsIncrementalPage(client, highlightIncremental.nextState),
    },
    {
      name: "Sources reconciliation",
      run: (client) =>
        runSourcesReconciliationPage(
          client,
          requiredSourceState(sourceReconciliation)
        ),
    },
    {
      name: "Highlights reconciliation",
      run: (client) =>
        runHighlightsReconciliationPage(
          client,
          requiredHighlightState(highlightReconciliation)
        ),
    },
  ]

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      let requests = 0
      const changedClient: ReadwiseClient = {
        credentialFingerprint() {
          return "e".repeat(64)
        },
        async listReaderDocuments() {
          requests += 1
          throw new Error("request should not run")
        },
        async exportHighlights() {
          requests += 1
          throw new Error("request should not run")
        },
      }
      await assert.rejects(
        () => fixture.run(changedClient),
        /credentials changed/
      )
      assert.equal(requests, 0)
    })
  }

  const rebound = await runHighlightsIncrementalPage(
    queuedClient({
      credentialFingerprint: "e".repeat(64),
      exported: [{ sources: [], count: 0, nextPageCursor: undefined }],
    }),
    undefined
  )
  assert.equal(rebound.nextState.credentialFingerprint, "e".repeat(64))
})

test("incremental cursor loops restart the pinned traversal and recover", async (t) => {
  await t.test("Highlights", async () => {
    const calls: Array<{ updatedAfter?: string; pageCursor?: string }> = []
    const client: ReadwiseClient = {
      credentialFingerprint() {
        return TEST_CREDENTIAL_FINGERPRINT
      },
      async listReaderDocuments() {
        throw new Error("unexpected Reader request")
      },
      async exportHighlights(options) {
        calls.push(options)
        return {
          sources: [],
          count: 0,
          nextPageCursor: calls.length < 3 ? "loop" : undefined,
        }
      },
    }

    const first = await runHighlightsIncrementalPage(client, undefined)
    const restarted = await runHighlightsIncrementalPage(
      client,
      first.nextState
    )
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

  await t.test("Sources preserve their current phase", async () => {
    const exportCursors: Array<string | undefined> = []
    const client: ReadwiseClient = {
      credentialFingerprint() {
        return TEST_CREDENTIAL_FINGERPRINT
      },
      async listReaderDocuments() {
        return { documents: [], count: 0, nextPageCursor: undefined }
      },
      async exportHighlights(options) {
        exportCursors.push(options.pageCursor)
        return {
          sources: [],
          count: 0,
          nextPageCursor: exportCursors.length < 3 ? "loop" : undefined,
        }
      },
    }

    const first = await runSourcesIncrementalPage(client, undefined)
    const restarted = await runSourcesIncrementalPage(client, first.nextState)
    assert.equal(restarted.nextState.phase, "readwise")
    assert.equal(restarted.nextState.pageCursor, undefined)
    assert.equal(restarted.nextState.paginationRestartCount, 1)
    const exportFinished = await runSourcesIncrementalPage(
      client,
      restarted.nextState
    )
    assert.equal(exportFinished.nextState.phase, "reader")
    const recovered = await runSourcesIncrementalPage(
      client,
      exportFinished.nextState
    )
    assert.equal(recovered.hasMore, false)
    assert.deepEqual(exportCursors, [undefined, "loop", undefined])
  })

  await t.test("Stops after three bounded restarts", async () => {
    const client: ReadwiseClient = {
      credentialFingerprint() {
        return TEST_CREDENTIAL_FINGERPRINT
      },
      async listReaderDocuments() {
        throw new Error("unexpected Reader request")
      },
      async exportHighlights() {
        return { sources: [], count: 0, nextPageCursor: "loop" }
      },
    }
    let state: IncrementalSyncState | undefined
    for (let restart = 1; restart <= 3; restart += 1) {
      const page = await runHighlightsIncrementalPage(client, state)
      const repeated = await runHighlightsIncrementalPage(
        client,
        page.nextState
      )
      assert.equal(repeated.nextState.paginationRestartCount, restart)
      state = repeated.nextState
    }
    const page = await runHighlightsIncrementalPage(client, state)
    await assert.rejects(
      () => runHighlightsIncrementalPage(client, page.nextState),
      /pagination remained unstable after 3 retries/
    )
  })
})

test("highlight delta requests tombstones while stable reconciliation confirms before emitting", async () => {
  const { exported } = await parsedFixtures()
  const incrementalPage = { ...exported, nextPageCursor: undefined }
  const reconciliationPage = activeExportPage(exported)
  const includeDeleted: boolean[] = []
  const client: ReadwiseClient = {
    credentialFingerprint() {
      return TEST_CREDENTIAL_FINGERPRINT
    },
    async listReaderDocuments() {
      return { documents: [], count: 0, nextPageCursor: undefined }
    },
    async exportHighlights(options) {
      includeDeleted.push(options.includeDeleted)
      return options.includeDeleted ? incrementalPage : reconciliationPage
    },
  }

  const incremental = await runHighlightsIncrementalPage(
    client,
    undefined,
    Date.parse("2026-07-03T12:00:00.000Z")
  )
  const observation = await runHighlightsReconciliationPage(client, undefined)
  const confirmation = await runHighlightsReconciliationPage(
    client,
    requiredHighlightState(observation)
  )
  const emission = await runHighlightsReconciliationPage(
    client,
    requiredHighlightState(confirmation)
  )

  assert.deepEqual(includeDeleted, [true, false, false, false])
  assert.ok(
    incremental.changes.some(
      (change) => change.type === "delete" && change.key === "highlight:9002"
    )
  )
  assert.deepEqual(observation.changes, [])
  assert.equal(requiredHighlightState(observation).pass, "confirm")
  assert.deepEqual(confirmation.changes, [])
  assert.equal(requiredHighlightState(confirmation).pass, "emit")
  assert.equal(emission.hasMore, false)
  assert.equal(emission.changes.length, 2)
})

test("replacement inventories validate Export count units and nested identities", async (t) => {
  const { exported } = await parsedFixtures()
  const expanded = activeExportPage(structuredClone(exported))
  const firstHighlight = expanded.sources[0].highlights[0]
  expanded.sources[0].highlights.push({
    ...firstHighlight,
    id: "9003",
    external_id: "reader-highlight-9003",
  })

  await t.test("accepts a source-container count", async () => {
    const result = await runHighlightsReconciliationPage(
      queuedClient({
        exported: [{ ...expanded, count: expanded.sources.length }],
      }),
      undefined
    )
    assert.equal(
      requiredHighlightState(result).baseline?.providerCountUnit,
      "raw"
    )
  })

  await t.test("accepts a nested-highlight count", async () => {
    const highlightCount = expanded.sources.reduce(
      (total, source) => total + source.highlights.length,
      0
    )
    const result = await runHighlightsReconciliationPage(
      queuedClient({ exported: [{ ...expanded, count: highlightCount }] }),
      undefined
    )
    assert.equal(
      requiredHighlightState(result).baseline?.providerCountUnit,
      "provider-items"
    )
  })

  await t.test("rejects a count matching neither unit", async () => {
    const result = await runHighlightsReconciliationPage(
      queuedClient({ exported: [{ ...expanded, count: 99 }] }),
      undefined
    )
    const restarted = requiredHighlightState(result)
    assert.equal(restarted.pass, "observe")
    assert.equal(restarted.restartCount, 1)
    assert.equal(restarted.baseline, undefined)
  })

  await t.test("does not emit when the count unit changes", async () => {
    const highlightCount = expanded.sources.reduce(
      (total, source) => total + source.highlights.length,
      0
    )
    const client = queuedClient({
      exported: [
        { ...expanded, count: expanded.sources.length },
        { ...expanded, count: highlightCount },
      ],
    })
    const observation = await runHighlightsReconciliationPage(client, undefined)
    const confirmation = await runHighlightsReconciliationPage(
      client,
      requiredHighlightState(observation)
    )
    const retry = requiredHighlightState(confirmation)
    assert.deepEqual(confirmation.changes, [])
    assert.equal(retry.pass, "confirm")
    assert.equal(retry.restartCount, 1)
    assert.equal(retry.baseline?.providerCountUnit, "provider-items")
  })

  await t.test(
    "fails closed when a highlight count omits an empty source",
    async () => {
      const emptySource = { ...expanded.sources[0], highlights: [] }
      const client = queuedClient({
        reader: [{ documents: [], count: 0, nextPageCursor: undefined }],
        exported: [
          { sources: [emptySource], count: 0, nextPageCursor: undefined },
        ],
      })
      const collected = await runSourcesReconciliationPage(client, undefined)
      await assert.rejects(
        () =>
          runSourcesReconciliationPage(client, requiredSourceState(collected)),
        /highlight-based count does not cover 1 empty source container/
      )
    }
  )

  await t.test(
    "accepts an empty source when the source count proves it",
    async () => {
      const emptySource = { ...expanded.sources[0], highlights: [] }
      const client = queuedClient({
        reader: [{ documents: [], count: 0, nextPageCursor: undefined }],
        exported: [
          { sources: [emptySource], count: 1, nextPageCursor: undefined },
        ],
      })
      const collected = await runSourcesReconciliationPage(client, undefined)
      const exportedPage = await runSourcesReconciliationPage(
        client,
        requiredSourceState(collected)
      )
      assert.equal(requiredSourceState(exportedPage).phase, "reader")
    }
  )

  await t.test(
    "rejects an ambiguous count when one source is empty",
    async () => {
      const ambiguousSources = [
        expanded.sources[0],
        { ...expanded.sources[1], highlights: [] },
      ]
      const client = queuedClient({
        reader: [{ documents: [], count: 0, nextPageCursor: undefined }],
        exported: [
          {
            sources: ambiguousSources,
            count: ambiguousSources.length,
            nextPageCursor: undefined,
          },
        ],
      })
      const collected = await runSourcesReconciliationPage(client, undefined)
      await assert.rejects(
        () =>
          runSourcesReconciliationPage(client, requiredSourceState(collected)),
        /highlight-based count does not cover 1 empty source container/
      )
    }
  )

  await t.test("restarts on a cross-page duplicate highlight id", async () => {
    const firstSource = {
      ...expanded.sources[0],
      highlights: [expanded.sources[0].highlights[0]],
    }
    const secondSource = {
      ...expanded.sources[1],
      highlights: [
        {
          ...expanded.sources[1].highlights[0],
          id: expanded.sources[0].highlights[0].id,
        },
      ],
    }
    const client = queuedClient({
      reader: [{ documents: [], count: 0, nextPageCursor: undefined }],
      exported: [
        { sources: [firstSource], count: 2, nextPageCursor: "next" },
        { sources: [secondSource], count: 2, nextPageCursor: undefined },
      ],
    })
    const collected = await runSourcesReconciliationPage(client, undefined)
    const firstPage = await runSourcesReconciliationPage(
      client,
      requiredSourceState(collected)
    )
    const duplicate = await runSourcesReconciliationPage(
      client,
      requiredSourceState(firstPage)
    )
    const restarted = requiredSourceState(duplicate)
    assert.deepEqual(duplicate.changes, [])
    assert.equal(restarted.phase, "collect-reader")
    assert.equal(restarted.restartCount, 1)
  })
})

test("source reconciliation counts Reader children and preserves unified ownership", async () => {
  const { reader, exported } = await parsedFixtures()
  const readerPage = { ...reader, nextPageCursor: undefined }
  const exportPage = activeExportPage(exported)
  const client = queuedClient({
    reader: Array.from({ length: 6 }, () => readerPage),
    exported: [exportPage, exportPage, exportPage],
  })

  const observation = await runSinglePageSourcePass(client, undefined)
  assert.deepEqual(observation.collection.changes, [])
  assert.deepEqual(observation.readwise.changes, [])
  assert.deepEqual(observation.reader.changes, [])

  const afterCollection = requiredSourceState(observation.collection)
  assert.equal(afterCollection.collectedReader?.providerCount, 3)
  assert.equal(afterCollection.collectedReader?.raw.count, 3)
  assert.equal(afterCollection.collectedReader?.output.count, 2)

  const confirmationState = requiredSourceState(observation.reader)
  assert.equal(confirmationState.pass, "confirm")
  assert.equal(confirmationState.phase, "collect-reader")
  const confirmation = await runSinglePageSourcePass(client, confirmationState)
  assert.deepEqual(confirmation.readwise.changes, [])
  assert.deepEqual(confirmation.reader.changes, [])
  const emissionState = requiredSourceState(confirmation.reader)
  assert.equal(emissionState.pass, "emit")
  const emission = await runSinglePageSourcePass(client, emissionState)

  const exportChange = emission.readwise.changes.find(
    (change) => change.key === "reader:reader-document-1"
  )
  assert.ok(exportChange && exportChange.type === "upsert")
  assert.deepEqual(Object.keys(exportChange.properties).sort(), [
    "Reader Document ID",
    "Readwise Review",
    "Readwise Source ID",
    "Source Key",
  ])

  const readerChange = emission.reader.changes.find(
    (change) => change.key === "reader:reader-document-1"
  )
  assert.ok(readerChange && readerChange.type === "upsert")
  assert.equal("Readwise Review" in readerChange.properties, false)
  assert.equal("Readwise Source ID" in readerChange.properties, false)
  assert.equal(emission.reader.hasMore, false)
})

test("multi-page reconciliation completes observe, confirm, and emit passes", async (t) => {
  const { reader, exported } = await parsedFixtures()
  const active = activeExportPage(exported)
  const readerPages: ReaderDocumentPage[] = [
    {
      documents: reader.documents.slice(0, 2),
      count: reader.documents.length,
      nextPageCursor: "reader-page-2",
    },
    {
      documents: reader.documents.slice(2),
      count: reader.documents.length,
      nextPageCursor: undefined,
    },
  ]
  const exportPages: ReadwiseExportPage[] = [
    {
      sources: active.sources.slice(0, 1),
      count: active.sources.length,
      nextPageCursor: "export-page-2",
    },
    {
      sources: active.sources.slice(1),
      count: active.sources.length,
      nextPageCursor: undefined,
    },
  ]

  await t.test("Sources", async () => {
    const client = queuedClient({
      reader: Array.from({ length: 6 }, () => readerPages).flat(),
      exported: Array.from({ length: 3 }, () => exportPages).flat(),
    })
    let state: SourcesReconciliationSyncState | undefined
    const emittedKeys: string[] = []
    let calls = 0
    while (true) {
      calls += 1
      assert.ok(calls <= 18, "source reconciliation did not terminate")
      const result = await runSourcesReconciliationPage(client, state)
      emittedKeys.push(...result.changes.map((change) => change.key))
      if (!result.hasMore) break
      state = requiredSourceState(result)
    }

    assert.equal(calls, 18)
    assert.deepEqual(emittedKeys.sort(), [
      "reader:reader-document-1",
      "reader:reader-document-1",
      "reader:reader-document-2",
      "readwise:502",
    ])
  })

  await t.test("Highlights", async () => {
    const client = queuedClient({
      exported: Array.from({ length: 3 }, () => exportPages).flat(),
    })
    let state: ReconciliationSyncState | undefined
    const emittedKeys: string[] = []
    let calls = 0
    while (true) {
      calls += 1
      assert.ok(calls <= 6, "highlight reconciliation did not terminate")
      const result = await runHighlightsReconciliationPage(client, state)
      emittedKeys.push(...result.changes.map((change) => change.key))
      if (!result.hasMore) break
      state = requiredHighlightState(result)
    }

    assert.equal(calls, 6)
    assert.deepEqual(emittedKeys.sort(), ["highlight:9001", "highlight:9100"])
  })
})

test("source reconciliation handles one-sided and absent representations", async (t) => {
  const { reader, exported } = await parsedFixtures()
  const readerDocument = reader.documents[0]
  const readerPage: ReaderDocumentPage = {
    documents: [readerDocument],
    count: 1,
    nextPageCursor: undefined,
  }
  const emptyReaderPage: ReaderDocumentPage = {
    documents: [],
    count: 0,
    nextPageCursor: undefined,
  }
  const exportedSource = activeExportPage(exported).sources[0]
  const exportPage: ReadwiseExportPage = {
    sources: [exportedSource],
    count: 1,
    nextPageCursor: undefined,
  }
  const emptyExportPage: ReadwiseExportPage = {
    sources: [],
    count: 0,
    nextPageCursor: undefined,
  }

  async function stableEmission(
    oneReaderPage: ReaderDocumentPage,
    oneExportPage: ReadwiseExportPage
  ) {
    const client = queuedClient({
      reader: Array.from({ length: 6 }, () => oneReaderPage),
      exported: Array.from({ length: 3 }, () => oneExportPage),
    })
    const observation = await runSinglePageSourcePass(client, undefined)
    const confirmation = await runSinglePageSourcePass(
      client,
      requiredSourceState(observation.reader)
    )
    assert.deepEqual(confirmation.readwise.changes, [])
    assert.deepEqual(confirmation.reader.changes, [])
    const emissionState = requiredSourceState(confirmation.reader)
    assert.equal(emissionState.pass, "emit")
    return runSinglePageSourcePass(client, emissionState)
  }

  await t.test("Reader only clears departed Export fields", async () => {
    const emission = await stableEmission(readerPage, emptyExportPage)
    assert.deepEqual(emission.readwise.changes, [])
    assert.equal(emission.reader.hasMore, false)
    assert.equal(emission.reader.changes.length, 1)
    const [change] = emission.reader.changes
    assert.ok(change.type === "upsert")
    assert.deepEqual(change.properties["Readwise Review"], [])
    assert.deepEqual(change.properties["Readwise Source ID"], [])
  })

  await t.test("Export only writes a complete fallback", async () => {
    const emission = await stableEmission(emptyReaderPage, exportPage)
    assert.equal(emission.reader.hasMore, false)
    assert.deepEqual(emission.reader.changes, [])
    assert.equal(emission.readwise.changes.length, 1)
    const [change] = emission.readwise.changes
    assert.ok(change.type === "upsert")
    if (!("Location" in change.properties)) {
      assert.fail("expected a complete Export fallback row")
    }
    assert.equal("Source" in change.properties, true)
    for (const property of [
      "Location",
      "Site",
      "Open in Reader",
      "Reading Progress",
      "Word Count",
      "Reading Time",
      "Published",
      "Saved",
      "Last Opened",
      "Updated",
    ] as const) {
      assert.deepEqual(change.properties[property], [], property)
    }
    assert.deepEqual(change.properties.Archived, Builder.checkbox(false))
  })

  await t.test("neither representation emits no key before sweep", async () => {
    const emission = await stableEmission(emptyReaderPage, emptyExportPage)
    assert.deepEqual(emission.readwise.changes, [])
    assert.deepEqual(emission.reader.changes, [])
    assert.equal(emission.reader.hasMore, false)
  })
})

test("changed confirmation inventories are promoted and retried", async (t) => {
  const { reader, exported } = await parsedFixtures()
  const clean = activeExportPage(exported)

  await t.test("highlights", async () => {
    const changed = structuredClone(clean)
    changed.sources[0].highlights[0].id = "changed-highlight"
    const client = queuedClient({
      exported: [clean, changed, changed, changed],
    })

    const observation = await runHighlightsReconciliationPage(client, undefined)
    const confirmation = await runHighlightsReconciliationPage(
      client,
      requiredHighlightState(observation)
    )
    const retryState = requiredHighlightState(confirmation)
    assert.equal(retryState.pass, "confirm")
    assert.equal(retryState.restartCount, 1)
    assert.ok(retryState.baseline)
    assert.deepEqual(confirmation.changes, [])

    const retry = await runHighlightsReconciliationPage(client, retryState)
    const emissionState = requiredHighlightState(retry)
    assert.equal(emissionState.pass, "emit")
    assert.deepEqual(retry.changes, [])
    const emission = await runHighlightsReconciliationPage(
      client,
      emissionState
    )
    assert.equal(emission.hasMore, false)
    assert.equal(emission.changes[0].key, "highlight:changed-highlight")
  })

  await t.test("sources", async () => {
    const readerPage = { ...reader, nextPageCursor: undefined }
    const changed = structuredClone(clean)
    changed.sources[1].user_book_id = "changed-source"
    const client = queuedClient({
      reader: Array.from({ length: 8 }, () => readerPage),
      exported: [clean, changed, changed, changed],
    })

    const observation = await runSinglePageSourcePass(client, undefined)
    const confirmation = await runSinglePageSourcePass(
      client,
      requiredSourceState(observation.reader)
    )
    const retryState = requiredSourceState(confirmation.reader)
    assert.equal(retryState.pass, "confirm")
    assert.equal(retryState.phase, "collect-reader")
    assert.equal(retryState.restartCount, 1)
    assert.ok(retryState.baselineReadwise)
    assert.deepEqual(confirmation.readwise.changes, [])

    const retry = await runSinglePageSourcePass(client, retryState)
    const emissionState = requiredSourceState(retry.reader)
    assert.equal(emissionState.pass, "emit")
    assert.deepEqual(retry.readwise.changes, [])
    const emission = await runSinglePageSourcePass(client, emissionState)
    assert.equal(emission.reader.hasMore, false)
    assert.ok(
      emission.readwise.changes.some(
        (change) => change.key === "readwise:changed-source"
      )
    )
  })
})

test("unstable highlight inventories restart observation", async (t) => {
  const { exported } = await parsedFixtures()
  const [firstSource, secondSource] = activeExportPage(exported).sources
  const cases: Array<{ name: string; pages: ReadwiseExportPage[] }> = [
    {
      name: "early terminal page",
      pages: [{ sources: [firstSource], count: 2, nextPageCursor: undefined }],
    },
    {
      name: "provider count drift",
      pages: [
        { sources: [firstSource], count: 2, nextPageCursor: "next" },
        { sources: [secondSource], count: 3, nextPageCursor: undefined },
      ],
    },
    {
      name: "cross-page duplicate",
      pages: [
        { sources: [firstSource], count: 2, nextPageCursor: "next" },
        { sources: [firstSource], count: 2, nextPageCursor: undefined },
      ],
    },
  ]

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const client = queuedClient({ exported: fixture.pages })
      let result = await runHighlightsReconciliationPage(client, undefined)
      if (fixture.pages.length > 1) {
        result = await runHighlightsReconciliationPage(
          client,
          requiredHighlightState(result)
        )
      }
      const restarted = requiredHighlightState(result)
      assert.deepEqual(result.changes, [])
      assert.equal(restarted.pass, "observe")
      assert.equal(restarted.restartCount, 1)
      assert.equal(restarted.pageCursor, undefined)
      assert.equal(restarted.active, undefined)
    })
  }
})

test("unstable source inventories restart Reader collection", async (t) => {
  const { reader } = await parsedFixtures()
  const [firstDocument, secondDocument] = reader.documents
  const cases: Array<{ name: string; pages: ReaderDocumentPage[] }> = [
    {
      name: "early terminal page",
      pages: [
        { documents: [firstDocument], count: 2, nextPageCursor: undefined },
      ],
    },
    {
      name: "provider count drift",
      pages: [
        { documents: [firstDocument], count: 2, nextPageCursor: "next" },
        { documents: [secondDocument], count: 3, nextPageCursor: undefined },
      ],
    },
    {
      name: "cross-page duplicate",
      pages: [
        { documents: [firstDocument], count: 2, nextPageCursor: "next" },
        { documents: [firstDocument], count: 2, nextPageCursor: undefined },
      ],
    },
  ]

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const client = queuedClient({ reader: fixture.pages })
      let result = await runSourcesReconciliationPage(client, undefined)
      if (fixture.pages.length > 1) {
        result = await runSourcesReconciliationPage(
          client,
          requiredSourceState(result)
        )
      }
      const restarted = requiredSourceState(result)
      assert.deepEqual(result.changes, [])
      assert.equal(restarted.pass, "observe")
      assert.equal(restarted.phase, "collect-reader")
      assert.equal(restarted.restartCount, 1)
      assert.equal(restarted.pageCursor, undefined)
      assert.equal(restarted.active, undefined)
    })
  }
})
