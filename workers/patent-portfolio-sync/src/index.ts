// ──────────────────────────────────────────────────────────────────────
// Patent Portfolio worker — capability wiring
// ──────────────────────────────────────────────────────────────────────
//
// Three syncs (backfill + delta + health) plus the database. The
// interesting logic lives in join.ts (assembly), src/sources/ (adapters),
// schema.ts (columns), and engine/ (resilience, state, change detection).
// You rarely edit this file; start in config.ts.

import { Worker } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"
import { config } from "./config.js"
import { fingerprint } from "./engine/fingerprint.js"
import { packSnapshots, unpackSnapshots } from "./engine/state.js"
import type { SourceHealth, SourceSnapshots } from "./engine/resilience.js"
import { buildPortfolioRows } from "./join.js"
import { DATABASE_KEY, buildSchema } from "./schema.js"
import { probeEpo } from "./sources/epo.js"
import { probeUspto } from "./sources/uspto.js"
import { registerDocumentTools } from "./tools/documents.js"

const worker = new Worker()
export default worker

// Optional on-demand tools: list + attach prosecution-history documents
// (US/WO via USPTO ODP, EP via EPO OPS + the EP Register). They run only when
// invoked, so they add no background sync load; `attach` additionally needs
// NOTION_API_TOKEN. See the `document-retrieval` skill. Remove this line to
// drop the feature.
registerDocumentTools(worker)

// Pacers encode each vendor's tolerance (shared across all syncs + probes).
// USPTO: documented 60/min. EPO OPS: 30/min, deliberately under OPS's
// dynamic per-service throttle floor.
const usptoApi = worker.pacer("usptoApi", {
  allowedRequests: 60,
  intervalMs: 60_000,
})
const epoApi = worker.pacer("epoApi", {
  allowedRequests: 30,
  intervalMs: 60_000,
})

const portfolio = worker.database(DATABASE_KEY, {
  type: "managed",
  initialTitle: config.notionDatabaseTitle,
  primaryKeyProperty: "ID",
  schema: buildSchema({
    docketing: config.sources.docketing,
    spend: config.sources.spend,
  }),
})

const pacers = {
  uspto: () => usptoApi.wait(),
  epo: () => epoApi.wait(),
}

// Each write-side execute (backfill, and delta on a mass-change cycle) emits
// at most this many rows, then yields with hasMore. Keep it well under the
// platform's changes-per-execute cap (~100 is safe).
const BATCH_SIZE = 100

type BackfillState = { offset?: number }

// Backfill: replace mode, manual. Strict — any source failure throws before
// a row is built, so a replace cycle can never mark-and-sweep live rows on
// partial data. Also applies schema migrations (run it after any schema
// change, or the delta will fail to start).
worker.sync("portfolioBackfill", {
  database: portfolio,
  mode: "replace",
  schedule: "manual",
  execute: async (state: BackfillState | undefined) => {
    // The join is global — family grouping needs the full record set — so
    // each execute rebuilds the whole (deterministically ordered) row list
    // and emits a BATCH_SIZE slice, advancing `offset` in nextState
    // until it runs past the end. Only the cursor lives in nextState, never
    // the rows, to stay under the ~200KB run-input cap. Replace-mode
    // mark-and-sweep is unaffected: the runtime tracks every key upserted
    // across the whole cycle and prunes the rest only when the final page
    // returns hasMore:false. Caveat: this re-fetches upstream once per page,
    // so it lifts the changes-per-execute cap but not the ~5-min-per-execute
    // fetch budget (a portfolio too large to fetch in one execute needs a
    // multi-phase resolve design instead).
    const offset = state?.offset ?? 0
    const { rows } = await buildPortfolioRows({
      mode: "strict",
      nowIso: new Date().toISOString(),
      pacers,
    })
    const page = rows.slice(offset, offset + BATCH_SIZE)
    const nextOffset = offset + page.length
    const hasMore = nextOffset < rows.length
    console.warn(
      `[portfolioBackfill] rows ${offset}–${nextOffset} of ${rows.length}${hasMore ? " (more)" : " (done)"}`
    )
    return {
      changes: page.map((r) => ({
        type: "upsert" as const,
        key: r.key,
        properties: r.properties,
      })) as never,
      hasMore,
      nextState: hasMore ? { offset: nextOffset } : undefined,
    }
  },
})

type DeltaState = {
  fingerprints?: Record<string, string>
  snapshotsGz?: string
  sourceHealth?: SourceHealth
}

// Delta: incremental, hourly. Resilient — serves last-known-good snapshots
// on a source outage. Emits a row only when its fingerprint changes.
// Deletions are handled by the backfill's mark-and-sweep, not here.
worker.sync("portfolioDelta", {
  database: portfolio,
  mode: "incremental",
  schedule: "1h",
  execute: async (state: DeltaState | undefined) => {
    const nowIso = new Date().toISOString()
    const { rows, snapshots, sourceHealth } = await buildPortfolioRows({
      mode: "resilient",
      nowIso,
      prevSnapshots: unpackSnapshots(state?.snapshotsGz, undefined),
      prevHealth: state?.sourceHealth,
      pacers,
    })

    for (const [key, h] of Object.entries(sourceHealth)) {
      if (h.servedFromCache) {
        console.warn(
          `[portfolioDelta] source "${key}" served from cache (last good ${h.lastSuccessAt}, ${h.consecutiveFailures} consecutive failures): ${h.lastError}`
        )
      }
    }

    // Diff against the committed baseline. A row leaves `changed` only once
    // its new fingerprint has been committed — which happens in the page
    // that emits it — so this list shrinks each page until it fits in one.
    const base = state?.fingerprints ?? {}
    const nextFingerprints: Record<string, string> = {}
    const changed: typeof rows = []
    for (const r of rows) {
      const fp = fingerprint(r.fingerprintBasis)
      nextFingerprints[r.key] = fp // rebuilt from live rows → stale keys drop out
      if (base[r.key] !== fp) changed.push(r)
    }

    const page = changed.slice(0, BATCH_SIZE)
    const hasMore = changed.length > BATCH_SIZE
    const changes = page.map((r) => ({
      type: "upsert" as const,
      key: r.key,
      properties: r.properties,
    }))

    if (hasMore) {
      // Advance only the emitted rows' fingerprints and carry snapshots /
      // health untouched; the rest stay "changed" and emit next page/run,
      // so an interrupted mass-change cycle resumes cleanly.
      const advanced = { ...base }
      for (const r of page) advanced[r.key] = nextFingerprints[r.key]
      console.warn(
        `[portfolioDelta] ${changed.length} changed, emitted ${page.length} (more)`
      )
      return {
        changes: changes as never,
        hasMore,
        nextState: {
          fingerprints: advanced,
          snapshotsGz: state?.snapshotsGz,
          sourceHealth: state?.sourceHealth,
        },
      }
    }

    // Final page: commit the fresh full map (drops stale keys) + snapshots.
    const snapshotsGz = packSnapshots(snapshots as SourceSnapshots)
    console.warn(
      `[portfolioDelta] ${changed.length} changed, emitted ${page.length}; packed snapshots ${snapshotsGz.length}B`
    )
    return {
      changes: changes as never,
      hasMore,
      nextState: { fingerprints: nextFingerprints, snapshotsGz, sourceHealth },
    }
  },
})

// ── Sync Health dashboard ───────────────────────────────────────────────
// Because the delta degrades gracefully, `ntn workers sync status` reports
// HEALTHY during an outage. This table is the real signal: one row per
// source, refreshed every 15m, never throws. Incremental so Down Since /
// Consecutive Failures persist across cycles.

const syncHealth = worker.database("syncHealth", {
  type: "managed",
  initialTitle: "Sync Health",
  primaryKeyProperty: "Endpoint",
  schema: {
    properties: {
      Endpoint: Schema.title(),
      Status: Schema.select([
        { name: "Up", color: "green" },
        { name: "Down", color: "red" },
      ]),
      "Last Checked": Schema.date(),
      "Last Success": Schema.date(),
      "Down Since": Schema.richText(),
      "Consecutive Failures": Schema.number(),
      "Last Error": Schema.richText(),
    },
  },
})

// Only probe the office sources that are actually enabled — otherwise a
// portfolio running on USPTO alone would report EPO OPS permanently "Down"
// (no credentials), drowning the real outage signal in false alarms.
const HEALTH_ENDPOINTS: Array<{ name: string; probe: () => Promise<void> }> = [
  ...(config.sources.uspto
    ? [{ name: "USPTO", probe: () => probeUspto(pacers.uspto) }]
    : []),
  ...(config.sources.epo
    ? [{ name: "EPO OPS", probe: () => probeEpo(pacers.epo) }]
    : []),
]

type HealthEntry = {
  lastSuccessAt: string | null
  downSince: string | null
  consecutiveFailures: number
}
type HealthState = Record<string, HealthEntry>

worker.sync("healthSync", {
  database: syncHealth,
  mode: "incremental",
  schedule: "15m",
  execute: async (state: HealthState | undefined) => {
    const prev = state ?? {}
    const now = new Date().toISOString().slice(0, 10)
    const nextState: HealthState = {}
    const results = await Promise.all(
      HEALTH_ENDPOINTS.map(async (ep) => {
        let ok = true
        let error: string | null = null
        try {
          await ep.probe()
        } catch (err) {
          ok = false
          error = err instanceof Error ? err.message : String(err)
        }
        const p = prev[ep.name] ?? {
          lastSuccessAt: null,
          downSince: null,
          consecutiveFailures: 0,
        }
        const entry: HealthEntry = ok
          ? { lastSuccessAt: now, downSince: null, consecutiveFailures: 0 }
          : {
              lastSuccessAt: p.lastSuccessAt,
              downSince: p.downSince ?? now,
              consecutiveFailures: p.consecutiveFailures + 1,
            }
        nextState[ep.name] = entry
        return { name: ep.name, ok, error, entry }
      })
    )

    const changes = results.map(({ name, ok, error, entry }) => {
      const props: Record<string, unknown> = {
        Endpoint: Builder.title(name),
        Status: Builder.select(ok ? "Up" : "Down"),
        "Last Checked": Builder.date(now),
        "Consecutive Failures": Builder.number(entry.consecutiveFailures),
        // Explicitly blank when healthy — incremental upserts leave
        // unspecified properties alone, so a recovered row would keep
        // stale outage data otherwise.
        "Down Since":
          !ok && entry.downSince
            ? Builder.richText(entry.downSince)
            : Builder.richText(""),
        "Last Error": error
          ? Builder.richText(error.slice(0, 1900))
          : Builder.richText(""),
      }
      if (entry.lastSuccessAt)
        props["Last Success"] = Builder.date(entry.lastSuccessAt)
      return { type: "upsert" as const, key: name, properties: props }
    })

    return { changes: changes as never, hasMore: false, nextState }
  },
})
