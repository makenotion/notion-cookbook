import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import { RateLimitError } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"

import { highlightToChange } from "./src/highlights.js"
import worker from "./src/index.js"
import {
  MAX_RESPONSE_BYTES,
  ReadwiseApiError,
  createReadwiseClient,
  type ReaderDocumentPage,
  type ReadwiseClient,
  type ReadwiseExportPage,
} from "./src/readwise.js"
import {
  exportSourceKey,
  exportSourceToChange,
  readerDocumentToChange,
  readerSourceKey,
} from "./src/sources.js"
import {
  CONSISTENCY_BUFFER_MS,
  INITIAL_UPDATED_AFTER,
  SYNC_STATE_VERSION,
  WATERMARK_OVERLAP_MS,
  completedIncrementalState,
  incrementalWindow,
  nextCursorState,
} from "./src/state.js"
import {
  runHighlightsIncrementalPage,
  runHighlightsReconciliationPage,
  runSourcesIncrementalPage,
} from "./src/syncs.js"
import { boundedText, readerTagNames, validUrl } from "./src/values.js"

const readerFixture = JSON.parse(
  readFileSync(join(process.cwd(), "fixtures/reader-page.json"), "utf8")
) as unknown
const exportFixture = JSON.parse(
  readFileSync(join(process.cwd(), "fixtures/export-page.json"), "utf8")
) as unknown

process.env.READWISE_ACCESS_TOKEN = "offline-fixture-token"

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
  const client = createReadwiseClient(async () => {}, (async () =>
    jsonResponse({ nextPageCursor: 42, results: [] })) as typeof fetch)
  await assert.rejects(
    () => client.listReaderDocuments({}),
    /invalid nextPageCursor/
  )
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

test("Reader children are excluded while top-level documents keep archive state", async () => {
  const { reader } = await parsedFixtures()
  const changes = reader.documents
    .map(readerDocumentToChange)
    .filter((change): change is NonNullable<typeof change> => Boolean(change))

  assert.equal(changes.length, 2)
  assert.deepEqual(
    changes.map((change) => change.key),
    ["reader:reader-document-1", "reader:reader-document-2"]
  )
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
})

test("long text is visibly bounded instead of silently overflowing Notion", () => {
  const result = boundedText("x".repeat(2_100))
  assert.equal(result.truncated, true)
  assert.equal([...(result.text ?? "")].length, 1_900)
  assert.ok(result.text?.endsWith("…"))
})

test("tag and URL normalization is deterministic and safe", () => {
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
  const initial = incrementalWindow(undefined, now)
  assert.equal(initial.updatedAfter, INITIAL_UPDATED_AFTER)
  assert.equal(
    initial.checkpoint,
    new Date(now - CONSISTENCY_BUFFER_MS).toISOString()
  )

  const completed = completedIncrementalState(initial.checkpoint)
  assert.equal(
    completed.updatedAfter,
    new Date(
      Date.parse(initial.checkpoint) - WATERMARK_OVERLAP_MS
    ).toISOString()
  )
})

test("cursor guards reject cycles and incompatible continuation state", () => {
  assert.throws(
    () =>
      nextCursorState(
        { pageCursor: "cursor-a", recentCursors: [], pageCount: 1 },
        "cursor-a",
        "fixtures"
      ),
    /repeated a cursor/
  )
  assert.throws(
    () =>
      incrementalWindow({
        stateVersion: SYNC_STATE_VERSION,
        updatedAfter: INITIAL_UPDATED_AFTER,
        pageCursor: "orphaned-cursor",
      }),
    /without a pinned checkpoint/
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
    async listReaderDocuments(options) {
      calls.push({ endpoint: "reader", ...options })
      readerCall += 1
      return readerCall === 1
        ? { documents: reader.documents, nextPageCursor: "reader-next" }
        : { documents: [], nextPageCursor: undefined }
    },
    async exportHighlights(options) {
      calls.push({ endpoint: "readwise", ...options })
      exportCall += 1
      return exportCall === 1
        ? { sources: exported.sources, nextPageCursor: "export-next" }
        : { sources: [], nextPageCursor: undefined }
    },
  }
  const now = Date.parse("2026-07-03T12:00:00.000Z")

  const first = await runSourcesIncrementalPage(client, undefined, now)
  assert.equal(first.hasMore, true)
  assert.equal(first.nextState.phase, "readwise")

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
    async listReaderDocuments() {
      return { documents: [], nextPageCursor: undefined }
    },
    async exportHighlights(options) {
      seen.push(options)
      if (fail) throw new Error("fixture outage")
      successfulCalls += 1
      return {
        sources: successfulCalls === 1 ? exported.sources : [],
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

test("highlight delta requests tombstones while reconciliation relies on mark-and-sweep", async () => {
  const { exported } = await parsedFixtures()
  const includeDeleted: boolean[] = []
  const client: ReadwiseClient = {
    async listReaderDocuments() {
      return { documents: [], nextPageCursor: undefined }
    },
    async exportHighlights(options) {
      includeDeleted.push(options.includeDeleted)
      return { sources: exported.sources, nextPageCursor: undefined }
    },
  }

  const incremental = await runHighlightsIncrementalPage(
    client,
    undefined,
    Date.parse("2026-07-03T12:00:00.000Z")
  )
  const reconciliation = await runHighlightsReconciliationPage(
    client,
    undefined
  )

  assert.deepEqual(includeDeleted, [true, false])
  assert.ok(
    incremental.changes.some(
      (change) => change.type === "delete" && change.key === "highlight:9002"
    )
  )
  assert.equal(reconciliation.hasMore, false)
})
