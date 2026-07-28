// ──────────────────────────────────────────────────────────────────────
// Source resilience: last-known-good snapshots + staleness caps
// ──────────────────────────────────────────────────────────────────────
//
// A single upstream outage must never blank or corrupt the portfolio. Each
// source fetch goes through a SourceRunner: on success it records the
// payload as a snapshot; on failure it serves the last-known-good snapshot
// (within that source's staleness cap) so the join stays internally
// consistent.
//
//   • "strict" mode (backfill): ANY failure throws before a row is built,
//     so a replace-mode cycle can never emit a partial dataset and
//     mark-and-sweep live rows.
//   • "resilient" mode (delta): serves snapshots within the cap; past the
//     cap (or with no snapshot) it rethrows — fail loud, never serve
//     indefinitely-stale data.
//
// Per-source caps: registry mirrors default to 24h, but sources deserve a
// cap that matches how their data decays. The WAF-fronted keyless backends
// this template reads (tmsearch, TMview) get 7 days — blocks can outlast a
// day while the underlying data barely moves. Counsel reports get NO cap
// (Infinity): a docket report stays the truth until the next one arrives.
//
// Serving from cache is NEVER silent: the delta looks HEALTHY while doing
// it, so the log line here (and the Sync Health table) are the only tells
// that fresh data is not being ingested.
//
// Bootstrap caveat: resilience needs one prior SUCCESSFUL fetch to seed a
// snapshot. The optional absentFallback is the escape hatch for a source
// that is down before any success (see STALENESS_CAP_EXEMPT in the README
// runbook).

export type SyncMode = "strict" | "resilient"

export type SourceSnapshot = {
  data: unknown
  lastSuccessAt: string /* ISO UTC */
}
export type SourceSnapshots = Record<string, SourceSnapshot>

export type SourceHealthEntry = {
  ok: boolean
  lastSuccessAt: string | null
  consecutiveFailures: number
  lastError: string | null
  servedFromCache: boolean
}
export type SourceHealth = Record<string, SourceHealthEntry>

export const STALENESS_CAP_MS = 24 * 60 * 60 * 1000 // 24h
// For undocumented, WAF-fronted upstreams whose blocks can outlast a day.
export const WAF_STALENESS_CAP_MS = 7 * 24 * 60 * 60 * 1000 // 7d

// Source keys listed (comma-separated) in STALENESS_CAP_EXEMPT may serve a
// beyond-cap snapshot, or use their absentFallback when no snapshot exists.
// Read at call time, not module scope: the deploy-time runtime snapshot
// evaluates modules before per-run env injection. Unset it once the outage
// ends — a forgotten exempt on a source with a fresher fallback pins the
// worker to aging data.
export function stalenessCapExempt(): ReadonlySet<string> {
  return new Set(
    (process.env.STALENESS_CAP_EXEMPT ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  )
}

export class SourceRunner {
  readonly snapshots: SourceSnapshots = {}
  readonly sourceHealth: SourceHealth = {}
  private readonly mode: SyncMode
  private readonly prevSnapshots: SourceSnapshots
  private readonly prevHealth: SourceHealth
  private readonly nowIso: string

  constructor(opts: {
    mode: SyncMode
    prevSnapshots?: SourceSnapshots
    prevHealth?: SourceHealth
    nowIso: string
  }) {
    this.mode = opts.mode
    this.prevSnapshots = opts.prevSnapshots ?? {}
    this.prevHealth = opts.prevHealth ?? {}
    this.nowIso = opts.nowIso
  }

  async run<T>(
    key: string,
    fetcher: () => Promise<T>,
    opts?: { capMs?: number; absentFallback?: () => T }
  ): Promise<T> {
    const capMs = opts?.capMs ?? STALENESS_CAP_MS
    try {
      const data = await fetcher()
      this.snapshots[key] = { data, lastSuccessAt: this.nowIso }
      this.sourceHealth[key] = {
        ok: true,
        lastSuccessAt: this.nowIso,
        consecutiveFailures: 0,
        lastError: null,
        servedFromCache: false,
      }
      return data
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (this.mode === "strict") throw new Error(`[${key}] ${msg}`)

      const exempt = stalenessCapExempt().has(key)
      const snap = this.prevSnapshots[key]
      const ageMs = snap
        ? Date.parse(this.nowIso) - Date.parse(snap.lastSuccessAt)
        : Number.POSITIVE_INFINITY
      const beyondCap = ageMs > capMs

      if (snap && (!beyondCap || exempt)) {
        if (beyondCap) {
          console.warn(
            `[resilience] STALENESS_CAP_EXEMPT: serving "${key}" snapshot ${Math.round(ageMs / 3_600_000)}h old (cap ${capMs / 3_600_000}h)`
          )
        }
        console.warn(
          `[resilience] "${key}" failed — serving snapshot from ${snap.lastSuccessAt}: ${msg.slice(0, 300)}`
        )
        this.snapshots[key] = snap
        this.sourceHealth[key] = {
          ok: false,
          lastSuccessAt: snap.lastSuccessAt,
          consecutiveFailures:
            (this.prevHealth[key]?.consecutiveFailures ?? 0) + 1,
          // Truncated: WAF block pages arrive as full HTML documents, and
          // sourceHealth persists RAW (ungzipped) in sync state — see the
          // size-discipline notes in engine/state.ts.
          lastError: msg.slice(0, 500),
          servedFromCache: true,
        }
        return snap.data as T
      }

      if (exempt && opts?.absentFallback) {
        // No snapshot to serve. Deliberately NOT stored as a snapshot —
        // an empty "last known good" would be served as real data later.
        console.warn(
          `[resilience] STALENESS_CAP_EXEMPT: "${key}" failed with no snapshot — degraded fallback: ${msg.slice(0, 300)}`
        )
        this.sourceHealth[key] = {
          ok: false,
          lastSuccessAt: this.prevHealth[key]?.lastSuccessAt ?? null,
          consecutiveFailures:
            (this.prevHealth[key]?.consecutiveFailures ?? 0) + 1,
          lastError: msg.slice(0, 500),
          servedFromCache: false,
        }
        return opts.absentFallback()
      }

      throw new Error(`[${key}] ${msg}`)
    }
  }
}
