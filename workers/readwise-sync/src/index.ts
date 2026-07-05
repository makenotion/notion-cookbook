// A read-only personal reading archive: top-level Reader documents and Readwise
// highlights become related managed databases in Notion. Incremental polling
// adds and updates records without removing knowledge that disappeared upstream.

import { Worker } from "@notionhq/workers"

import {
  HIGHLIGHTS_INITIAL_TITLE,
  HIGHLIGHTS_PRIMARY_KEY,
  highlightSchema,
} from "./highlights.js"
import { createReadwiseClient, type ReadwiseClient } from "./readwise.js"
import {
  SOURCES_INITIAL_TITLE,
  SOURCES_PRIMARY_KEY,
  sourceSchema,
} from "./sources.js"
import type {
  IncrementalSyncState,
  SourcesIncrementalSyncState,
} from "./state.js"
import {
  runHighlightsIncrementalPage,
  runSourcesIncrementalPage,
} from "./syncs.js"

const worker = new Worker()

// Reader LIST and Readwise Books LIST are documented at 20 requests/minute per
// token. Both syncs share a conservative 15/minute budget; provider 429s also
// become retryable Workers RateLimitError values in the client.
const pacer = worker.pacer("readwise", {
  allowedRequests: 15,
  intervalMs: 60_000,
})

let client: ReadwiseClient | undefined
function readwiseClient() {
  return (client ??= createReadwiseClient(() => pacer.wait()))
}

const sources = worker.database("sources", {
  type: "managed",
  initialTitle: SOURCES_INITIAL_TITLE,
  primaryKeyProperty: SOURCES_PRIMARY_KEY,
  schema: sourceSchema,
})

const highlights = worker.database("highlights", {
  type: "managed",
  initialTitle: HIGHLIGHTS_INITIAL_TITLE,
  primaryKeyProperty: HIGHLIGHTS_PRIMARY_KEY,
  schema: highlightSchema,
})

// Register source capabilities before highlight capabilities so an initial
// manual trigger can establish relation targets in the recommended order.
worker.sync("sourcesSync", {
  database: sources,
  mode: "incremental",
  schedule: "15m",
  execute: (state: SourcesIncrementalSyncState | undefined) =>
    runSourcesIncrementalPage(readwiseClient(), state),
})

worker.sync("highlightsSync", {
  database: highlights,
  mode: "incremental",
  schedule: "15m",
  execute: (state: IncrementalSyncState | undefined) =>
    runHighlightsIncrementalPage(readwiseClient(), state),
})

export default worker
