// ──────────────────────────────────────────────────────────────────────
// Trademark Portfolio worker — capability wiring
// ──────────────────────────────────────────────────────────────────────
//
// Three syncs (backfill + delta + health) plus the database. The
// interesting logic lives in join.ts (assembly + derivations),
// src/sources/ (adapters), schema.ts (columns), and engine/ (resilience,
// state, change detection). You rarely edit this file; start in config.ts.

import { Worker } from "@notionhq/workers"
import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"
import { config } from "./config.js"
import { canonicalUtcTimestamp } from "./engine/date.js"
import { DERIVATION_VERSION, fingerprint } from "./engine/fingerprint.js"
import type { SourceHealth, SourceSnapshots } from "./engine/resilience.js"
import {
  assertSafeSyncState,
  packJson,
  packSnapshots,
  unpackJson,
  unpackSnapshots,
} from "./engine/state.js"
import {
  assemblePortfolioRows,
  buildPortfolioRows,
  type PortfolioRow,
} from "./join.js"
import { DATABASE_KEY, buildSchema } from "./schema.js"
import {
  docketInboxPageId,
  probeCounselDocket,
} from "./sources/counsel-docket.js"
import { probeEuipo } from "./sources/euipo.js"
import { probeIpAustralia } from "./sources/ipaustralia.js"
import { probeTmview } from "./sources/tmview.js"
import {
  probeTmsearch,
  probeTsdrKeyed,
  tsdrKeyConfigured,
} from "./sources/uspto.js"
import { registerDocumentTools } from "./tools/documents.js"

const worker = new Worker()
export default worker

// Optional on-demand tools: list + attach US file-wrapper documents
// (office actions, specimens, registration certificates — needs
// TSDR_API_KEY) and refreshMarkImages (uploads validated mark images as
// in-table thumbnails + page icons — needs NOTION_API_TOKEN). They run
// only when invoked, so they add no background sync load. Remove this
// line to drop the feature.
registerDocumentTools(worker)

// Pacers encode each vendor's tolerance (shared across all syncs +
// probes). The two keyless registry backends are UNDOCUMENTED and
// WAF-fronted — their budgets are deliberately tiny so nothing this
// worker does ever looks like scraping traffic:
//   tmsearch.uspto.gov — ~1 request per cycle in practice.
//   TSDR — documented 60/min for status-class calls.
//   TMview — one applicant query + a bounded status-date budget.
//   Official office APIs (IP Australia + EUIPO) share one pacer — each
//   makes a handful of calls per cycle, and the platform caps workers at
//   5 pacers total.
const tmSearchApi = worker.pacer("tmSearchApi", {
  allowedRequests: 10,
  intervalMs: 60_000,
})
const tsdrApi = worker.pacer("tsdrApi", {
  allowedRequests: 60,
  intervalMs: 60_000,
})
const tmviewApi = worker.pacer("tmviewApi", {
  allowedRequests: 6,
  intervalMs: 60_000,
})
const officialApi = worker.pacer("officialApi", {
  allowedRequests: 60,
  intervalMs: 60_000,
})

const pacers = {
  tmsearch: () => tmSearchApi.wait(),
  tsdr: () => tsdrApi.wait(),
  tmview: () => tmviewApi.wait(),
  official: () => officialApi.wait(),
}

const portfolio = worker.database(DATABASE_KEY, {
  type: "managed",
  initialTitle: config.notionDatabaseTitle,
  primaryKeyProperty: "ID",
  schema: buildSchema({
    counselDocket: config.sources.counselDocket,
    spend: config.sources.spend,
  }),
})

// Each write-side execute (backfill, and delta on a mass-change cycle)
// emits at most this many rows, then yields with hasMore. Keep it well
// under the platform's changes-per-execute cap.
const BATCH_SIZE = 100
const STATE_VERSION = 2 as const
const MAX_PERSISTED_ERROR_CHARS = 500

const requiredSnapshotKeys = (): string[] => [
  ...(config.sources.uspto ? ["uspto"] : []),
  ...(config.sources.tmview ? ["tmview"] : []),
  ...(config.sources.counselDocket ? ["counselDocket"] : []),
]

// Compact marker for every source toggle that changes row assembly/schema.
const sourceConfigSignature = (): string =>
  `u${Number(config.sources.uspto)}t${Number(config.sources.tmview)}c${Number(config.sources.counselDocket)}a${Number(config.sources.ipAustralia)}e${Number(config.sources.euipo)}s${Number(config.sources.spend)}`

function snapshotsCoverRequiredSources(snapshots: SourceSnapshots): boolean {
  return requiredSnapshotKeys().every((key) =>
    Object.prototype.hasOwnProperty.call(snapshots, key)
  )
}

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function validateNowIso(value: unknown, label: string): string {
  const normalized = canonicalUtcTimestamp(value)
  if (!normalized)
    throw new Error(`[${label}] cycleNowIso must be a valid ISO timestamp`)
  return normalized
}

function validateSourceHealth(value: unknown, label: string): SourceHealth {
  if (!isObject(value))
    throw new Error(`[${label}] sourceHealth must be an object`)
  const normalized: SourceHealth = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!isObject(entry))
      throw new Error(`[${label}] sourceHealth.${key} must be an object`)
    const lastSuccessAt =
      entry.lastSuccessAt === null
        ? null
        : canonicalUtcTimestamp(entry.lastSuccessAt)
    if (
      typeof entry.ok !== "boolean" ||
      (entry.lastSuccessAt !== null && lastSuccessAt === null) ||
      !Number.isSafeInteger(entry.consecutiveFailures) ||
      (entry.consecutiveFailures as number) < 0 ||
      (entry.lastError !== null && typeof entry.lastError !== "string") ||
      typeof entry.servedFromCache !== "boolean"
    ) {
      throw new Error(`[${label}] sourceHealth.${key} is malformed`)
    }
    const rawError = entry.lastError as string | null
    normalized[key] = {
      ok: entry.ok as boolean,
      lastSuccessAt,
      consecutiveFailures: entry.consecutiveFailures as number,
      lastError:
        rawError && rawError.length > MAX_PERSISTED_ERROR_CHARS
          ? `${rawError.slice(0, MAX_PERSISTED_ERROR_CHARS - 3)}...`
          : rawError,
      servedFromCache: entry.servedFromCache as boolean,
    }
  }
  return normalized
}

function validateSnapshots(value: unknown, label: string): SourceSnapshots {
  if (!isObject(value))
    throw new Error(`[${label}] snapshots must be an object`)
  const normalized: SourceSnapshots = {}
  for (const [key, snapshot] of Object.entries(value)) {
    const lastSuccessAt = isObject(snapshot)
      ? canonicalUtcTimestamp(snapshot.lastSuccessAt)
      : null
    if (!isObject(snapshot) || !("data" in snapshot) || !lastSuccessAt) {
      throw new Error(`[${label}] snapshot "${key}" is malformed`)
    }
    normalized[key] = { data: snapshot.data, lastSuccessAt }
  }
  return normalized
}

function unpackRequiredSnapshots(
  packed: string,
  label: string
): SourceSnapshots {
  return validateSnapshots(unpackJson<unknown>(packed, label), label)
}

function unpackKeys(packed: string, label: string): string[] {
  const value = unpackJson<unknown>(packed, label)
  if (
    !Array.isArray(value) ||
    value.some((key) => typeof key !== "string" || key.length === 0)
  ) {
    throw new Error(`[${label}] must contain an array of non-empty keys`)
  }
  if (new Set(value).size !== value.length)
    throw new Error(`[${label}] contains duplicate keys`)
  return value as string[]
}

function rowsByKey(
  rows: PortfolioRow[],
  label: string
): Map<string, PortfolioRow> {
  const indexed = new Map<string, PortfolioRow>()
  for (const row of rows) {
    if (!row.key || indexed.has(row.key))
      throw new Error(
        `[${label}] assembled duplicate or empty row key "${row.key}"`
      )
    indexed.set(row.key, row)
  }
  return indexed
}

function selectRows(
  rows: PortfolioRow[],
  keys: string[],
  label: string
): PortfolioRow[] {
  const indexed = rowsByKey(rows, label)
  return keys.map((key) => {
    const row = indexed.get(key)
    if (!row)
      throw new Error(`[${label}] frozen key "${key}" is absent from snapshot`)
    return row
  })
}

function rowChanges(rows: PortfolioRow[]) {
  return rows.map((row) => ({
    type: "upsert" as const,
    key: row.key,
    properties: row.properties,
  }))
}

function fingerprintsFor(rows: PortfolioRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) out[row.key] = fingerprint(row.fingerprintBasis)
  return out
}

type BackfillState = {
  v: typeof STATE_VERSION
  phase: "emit"
  derivationVersion: string
  configSignature: string
  cycleNowIso: string
  snapshotsGz: string
  pendingKeysGz: string
}

function parseBackfillState(state: unknown): BackfillState | undefined {
  if (state === undefined) return undefined
  if (!isObject(state))
    throw new Error("[portfolioBackfill] state must be an object")
  if (
    state.v !== STATE_VERSION ||
    state.phase !== "emit" ||
    typeof state.derivationVersion !== "string" ||
    typeof state.configSignature !== "string" ||
    typeof state.snapshotsGz !== "string" ||
    typeof state.pendingKeysGz !== "string"
  ) {
    throw new Error(
      "[portfolioBackfill] invalid or legacy pagination state; restart the replace cycle from an empty state"
    )
  }
  if (state.derivationVersion !== DERIVATION_VERSION)
    throw new Error(
      "[portfolioBackfill] derivation changed during a frozen cycle; restart the replace cycle"
    )
  if (state.configSignature !== sourceConfigSignature())
    throw new Error(
      "[portfolioBackfill] enabled sources changed during a frozen cycle; restart the replace cycle"
    )
  return {
    v: STATE_VERSION,
    phase: "emit",
    derivationVersion: state.derivationVersion,
    configSignature: state.configSignature,
    cycleNowIso: validateNowIso(state.cycleNowIso, "portfolioBackfill"),
    snapshotsGz: state.snapshotsGz,
    pendingKeysGz: state.pendingKeysGz,
  }
}

// Backfill: replace mode, manual. Strict — any row-defining source failure
// throws before a row is built, so a replace cycle can never mark-and-sweep
// live rows on partial data. Also applies schema migrations (run it after
// any schema change, or the delta will fail to start).
worker.sync("portfolioBackfill", {
  database: portfolio,
  mode: "replace",
  schedule: "manual",
  execute: async (rawState: BackfillState | undefined) => {
    const state = parseBackfillState(rawState)
    let rows: PortfolioRow[]
    let snapshotsGz: string
    let cycleNowIso: string

    if (state) {
      cycleNowIso = state.cycleNowIso
      const snapshots = unpackRequiredSnapshots(
        state.snapshotsGz,
        "portfolioBackfill snapshots"
      )
      snapshotsGz = packSnapshots(snapshots)
      if (!snapshotsCoverRequiredSources(snapshots))
        throw new Error(
          "[portfolioBackfill] frozen snapshots do not cover enabled row-defining sources; restart the replace cycle"
        )
      rows = selectRows(
        assemblePortfolioRows({ snapshots, nowIso: cycleNowIso }),
        unpackKeys(state.pendingKeysGz, "portfolioBackfill pending keys"),
        "portfolioBackfill"
      )
    } else {
      cycleNowIso = new Date().toISOString()
      const acquired = await buildPortfolioRows({
        mode: "strict",
        nowIso: cycleNowIso,
        pacers,
      })
      rows = acquired.rows
      snapshotsGz = packSnapshots(acquired.snapshots)
    }

    const page = rows.slice(0, BATCH_SIZE)
    const remainingKeys = rows.slice(BATCH_SIZE).map((row) => row.key)
    const hasMore = remainingKeys.length > 0
    let nextState: BackfillState | undefined
    if (hasMore) {
      nextState = {
        v: STATE_VERSION,
        phase: "emit",
        derivationVersion: DERIVATION_VERSION,
        configSignature: sourceConfigSignature(),
        cycleNowIso,
        snapshotsGz,
        pendingKeysGz: packJson(remainingKeys),
      }
      assertSafeSyncState(nextState, "portfolioBackfill")
    }
    console.warn(
      `[portfolioBackfill] emitted ${page.length}; ${remainingKeys.length} frozen rows remain${hasMore ? " (more)" : " (done)"}`
    )
    return {
      changes: rowChanges(page) as never,
      hasMore,
      nextState,
    }
  },
})

type LegacyDeltaState = {
  fingerprints?: Record<string, string>
  snapshotsGz?: string
  sourceHealth?: SourceHealth
}

type DeltaSteadyState = {
  v: typeof STATE_VERSION
  phase: "steady"
  derivationVersion: string
  configSignature: string
  snapshotsGz: string
  sourceHealth: SourceHealth
}

type DeltaEmitState = {
  v: typeof STATE_VERSION
  phase: "emit"
  derivationVersion: string
  configSignature: string
  cycleNowIso: string
  snapshotsGz: string
  sourceHealth: SourceHealth
  pendingKeysGz: string
}

type DeltaState = LegacyDeltaState | DeltaSteadyState | DeltaEmitState

type ParsedDeltaState =
  | { kind: "empty" }
  | { kind: "legacy"; state: LegacyDeltaState }
  | { kind: "steady"; state: DeltaSteadyState }
  | { kind: "emit"; state: DeltaEmitState }

function validateLegacyFingerprints(
  value: unknown
): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (
    !isObject(value) ||
    Object.values(value).some((fp) => typeof fp !== "string")
  ) {
    throw new Error("[portfolioDelta] legacy fingerprints are malformed")
  }
  return value as Record<string, string>
}

function parseDeltaState(state: unknown): ParsedDeltaState {
  if (state === undefined) return { kind: "empty" }
  if (!isObject(state))
    throw new Error("[portfolioDelta] state must be an object")

  if (state.v === STATE_VERSION) {
    if (
      typeof state.derivationVersion !== "string" ||
      typeof state.configSignature !== "string" ||
      typeof state.snapshotsGz !== "string"
    ) {
      throw new Error("[portfolioDelta] versioned state is malformed")
    }
    const sourceHealth = validateSourceHealth(
      state.sourceHealth,
      "portfolioDelta"
    )
    if (state.phase === "steady") {
      return {
        kind: "steady",
        state: {
          v: STATE_VERSION,
          phase: "steady",
          derivationVersion: state.derivationVersion,
          configSignature: state.configSignature,
          snapshotsGz: state.snapshotsGz,
          sourceHealth,
        },
      }
    }
    if (state.phase === "emit" && typeof state.pendingKeysGz === "string") {
      if (state.derivationVersion !== DERIVATION_VERSION)
        throw new Error(
          "[portfolioDelta] derivation changed during a frozen cycle; restart the incremental cycle"
        )
      if (state.configSignature !== sourceConfigSignature())
        throw new Error(
          "[portfolioDelta] enabled sources changed during a frozen cycle; restart the incremental cycle"
        )
      return {
        kind: "emit",
        state: {
          v: STATE_VERSION,
          phase: "emit",
          derivationVersion: state.derivationVersion,
          configSignature: state.configSignature,
          cycleNowIso: validateNowIso(state.cycleNowIso, "portfolioDelta"),
          snapshotsGz: state.snapshotsGz,
          sourceHealth,
          pendingKeysGz: state.pendingKeysGz,
        },
      }
    }
    throw new Error(
      `[portfolioDelta] unknown state phase "${String(state.phase)}"`
    )
  }

  if (state.v !== undefined || state.phase !== undefined)
    throw new Error("[portfolioDelta] unsupported state version")
  if (state.snapshotsGz !== undefined && typeof state.snapshotsGz !== "string")
    throw new Error("[portfolioDelta] legacy snapshotsGz must be a string")
  return {
    kind: "legacy",
    state: {
      fingerprints: validateLegacyFingerprints(state.fingerprints),
      snapshotsGz: state.snapshotsGz as string | undefined,
      sourceHealth:
        state.sourceHealth === undefined
          ? undefined
          : validateSourceHealth(state.sourceHealth, "portfolioDelta legacy"),
    },
  }
}

function steadyDeltaState(
  snapshotsGz: string,
  sourceHealth: SourceHealth
): DeltaSteadyState {
  return {
    v: STATE_VERSION,
    phase: "steady",
    derivationVersion: DERIVATION_VERSION,
    configSignature: sourceConfigSignature(),
    snapshotsGz,
    sourceHealth,
  }
}

// Delta: incremental, hourly. Resilient — serves last-known-good snapshots
// on a source outage (loudly; see engine/resilience.ts). Emits a row only
// when its fingerprint changes. Deletions are handled by the backfill's
// mark-and-sweep, not here.
worker.sync("portfolioDelta", {
  database: portfolio,
  mode: "incremental",
  schedule: "1h",
  execute: async (rawState: DeltaState | undefined) => {
    const parsed = parseDeltaState(rawState)

    if (parsed.kind === "emit") {
      const frozen = parsed.state
      const snapshots = unpackRequiredSnapshots(
        frozen.snapshotsGz,
        "portfolioDelta frozen snapshots"
      )
      const snapshotsGz = packSnapshots(snapshots)
      if (!snapshotsCoverRequiredSources(snapshots))
        throw new Error(
          "[portfolioDelta] frozen snapshots do not cover enabled row-defining sources; restart the incremental cycle"
        )
      const pendingKeys = unpackKeys(
        frozen.pendingKeysGz,
        "portfolioDelta pending keys"
      )
      if (pendingKeys.length === 0)
        throw new Error(
          "[portfolioDelta] frozen emission state has no pending keys"
        )
      const pendingRows = selectRows(
        assemblePortfolioRows({
          snapshots,
          nowIso: frozen.cycleNowIso,
        }),
        pendingKeys,
        "portfolioDelta"
      )
      const page = pendingRows.slice(0, BATCH_SIZE)
      const remainingKeys = pendingKeys.slice(BATCH_SIZE)
      const hasMore = remainingKeys.length > 0
      const nextState: DeltaEmitState | DeltaSteadyState = hasMore
        ? {
            ...frozen,
            snapshotsGz,
            pendingKeysGz: packJson(remainingKeys),
          }
        : steadyDeltaState(snapshotsGz, frozen.sourceHealth)
      assertSafeSyncState(nextState, "portfolioDelta")
      console.warn(
        `[portfolioDelta] emitted ${page.length} frozen changes; ${remainingKeys.length} remain${hasMore ? " (more)" : " (done)"}`
      )
      return {
        changes: rowChanges(page) as never,
        hasMore,
        nextState,
      }
    }

    const nowIso = new Date().toISOString()
    let prevSnapshots: SourceSnapshots | undefined
    let prevHealth: SourceHealth | undefined
    let base: Record<string, string> = {}

    if (parsed.kind === "steady") {
      prevSnapshots = unpackRequiredSnapshots(
        parsed.state.snapshotsGz,
        "portfolioDelta snapshots"
      )
      prevHealth = parsed.state.sourceHealth
      const configMatches =
        parsed.state.configSignature === sourceConfigSignature()
      const snapshotsComplete = snapshotsCoverRequiredSources(prevSnapshots)
      if (
        parsed.state.derivationVersion === DERIVATION_VERSION &&
        configMatches &&
        snapshotsComplete
      ) {
        base = fingerprintsFor(
          assemblePortfolioRows({ snapshots: prevSnapshots, nowIso })
        )
      } else if (!configMatches || !snapshotsComplete) {
        console.warn(
          "[portfolioDelta] enabled sources changed or prior snapshots are incomplete; forcing a full re-emit"
        )
      }
    } else if (parsed.kind === "legacy") {
      prevSnapshots = unpackSnapshots(parsed.state.snapshotsGz, undefined)
      prevHealth = parsed.state.sourceHealth
      base = parsed.state.fingerprints ?? {}
    }

    const { rows, snapshots, sourceHealth } = await buildPortfolioRows({
      mode: "resilient",
      nowIso,
      prevSnapshots,
      prevHealth,
      pacers,
    })

    for (const [key, health] of Object.entries(sourceHealth)) {
      if (health.servedFromCache) {
        console.warn(
          `[portfolioDelta] source "${key}" served from cache (last good ${health.lastSuccessAt}, ${health.consecutiveFailures} consecutive failures): ${health.lastError}`
        )
      }
    }

    const changed: typeof rows = []
    for (const r of rows) {
      const fp = fingerprint(r.fingerprintBasis)
      if (base[r.key] !== fp) changed.push(r)
    }

    const page = changed.slice(0, BATCH_SIZE)
    const hasMore = changed.length > BATCH_SIZE
    const snapshotsGz = packSnapshots(snapshots)
    const nextState: DeltaEmitState | DeltaSteadyState = hasMore
      ? {
          v: STATE_VERSION,
          phase: "emit",
          derivationVersion: DERIVATION_VERSION,
          configSignature: sourceConfigSignature(),
          cycleNowIso: nowIso,
          snapshotsGz,
          sourceHealth,
          pendingKeysGz: packJson(
            changed.slice(BATCH_SIZE).map((row) => row.key)
          ),
        }
      : steadyDeltaState(snapshotsGz, sourceHealth)
    assertSafeSyncState(nextState, "portfolioDelta")
    console.warn(
      `[portfolioDelta] ${changed.length} changed, emitted ${page.length}; ${hasMore ? `${changed.length - page.length} frozen changes remain` : "done"}`
    )
    return {
      changes: rowChanges(page) as never,
      hasMore,
      nextState,
    }
  },
})

// ── Sync Health dashboard ──────────────────────────────────────────────
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

// Probe rules learned the hard way:
//   • Only probe sources that are actually enabled — a permanently-red row
//     for an office you never configured drowns the real outage signal.
//   • Probes must be CHEAP (single-request). A probe that walks the full
//     enrichment path both starves the shared pacers and looks like
//     scraping to WAF-fronted backends.
//   • The counsel-docket probe is the deliberate exception: it dry-runs
//     the full listing→download→parse→validate path, because the sync
//     serves the previous snapshot (by design) when the newest report is
//     bad — this row going red is how a bad or misnamed report actually
//     gets noticed.
//   • Key-gated probes appear only when their key is configured (checked
//     at RUN time, so setting the env var upgrades the next cycle with no
//     redeploy).
function healthEndpoints(): Array<{
  name: string
  probe: () => Promise<void>
}> {
  const inbox = config.sources.counselDocket ? docketInboxPageId() : null
  return [
    ...(config.sources.uspto
      ? [
          {
            name: "USPTO search",
            probe: () => probeTmsearch(config.ownerNames, pacers.tmsearch),
          },
        ]
      : []),
    ...(config.sources.uspto && tsdrKeyConfigured()
      ? [
          {
            name: "USPTO TSDR (keyed)",
            probe: () =>
              probeTsdrKeyed(config.ownerNames, {
                search: pacers.tmsearch,
                tsdr: pacers.tsdr,
              }),
          },
        ]
      : []),
    ...(config.sources.tmview
      ? [{ name: "TMview", probe: () => probeTmview(pacers.tmview) }]
      : []),
    ...(inbox
      ? [
          {
            name: "Counsel Docket Inbox",
            probe: () =>
              probeCounselDocket(inbox, {
                ownerNames: config.ownerNames,
                clientNumber: config.docketClientNumber,
                parserVersion: DERIVATION_VERSION,
              }),
          },
        ]
      : []),
    ...(config.sources.ipAustralia
      ? [
          {
            name: "IP Australia",
            probe: () => probeIpAustralia(pacers.official),
          },
        ]
      : []),
    ...(config.sources.euipo
      ? [{ name: "EUIPO", probe: () => probeEuipo(pacers.official) }]
      : []),
  ]
}

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
      healthEndpoints().map(async (ep) => {
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
