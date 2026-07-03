// A read-only personal reading hub: top-level Reader documents and Readwise
// highlight sources become related managed databases in Notion. Incremental
// polls keep active libraries current; daily replacement sweeps repair drift
// and remove upstream records that list endpoints no longer return.

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
  ReconciliationSyncState,
  SourcesIncrementalSyncState,
  SourcesReconciliationSyncState,
} from "./state.js"
import {
  runHighlightsIncrementalPage,
  runHighlightsReconciliationPage,
  runSourcesIncrementalPage,
  runSourcesReconciliationPage,
} from "./syncs.js"

const worker = new Worker()

// Reader LIST is documented at 20 requests/minute per token. All four syncs
// share a conservative 15/minute budget; provider 429s also become retryable
// Workers RateLimitError values in the client.
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

worker.sync("sourcesReconciliationSync", {
  database: sources,
  mode: "replace",
  schedule: "1d",
  execute: (state: SourcesReconciliationSyncState | undefined) =>
    runSourcesReconciliationPage(readwiseClient(), state),
})

worker.sync("highlightsSync", {
  database: highlights,
  mode: "incremental",
  schedule: "15m",
  execute: (state: IncrementalSyncState | undefined) =>
    runHighlightsIncrementalPage(readwiseClient(), state),
})

worker.sync("highlightsReconciliationSync", {
  database: highlights,
  mode: "replace",
  schedule: "1d",
  execute: (state: ReconciliationSyncState | undefined) =>
    runHighlightsReconciliationPage(readwiseClient(), state),
})

export default worker
