// ──────────────────────────────────────────────────────────────────────
// Source resilience: last-known-good snapshots + staleness cap
// ──────────────────────────────────────────────────────────────────────
//
// A single upstream outage must never blank or corrupt the portfolio. Each
// source fetch goes through a SourceRunner: on success it records the
// payload as a snapshot; on failure it serves the last-known-good snapshot
// (within STALENESS_CAP_MS) so the join stays internally consistent.
//
//   • "strict" mode (backfill): ANY failure throws before a row is built,
//     so a replace-mode cycle can never emit a partial dataset and
//     mark-and-sweep live rows.
//   • "resilient" mode (delta): serves snapshots within the cap; past the
//     cap (or with no snapshot) it rethrows — fail loud, never serve
//     indefinitely-stale data.
//
// Bootstrap caveat: resilience needs one prior SUCCESSFUL fetch to seed a
// snapshot. It protects against future outages and against blips in other
// sources while one is down — not against an outage that predates any
// success. The optional absentFallback is an escape hatch for that case
// (see STALENESS_CAP_EXEMPT in the README runbook).

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
export const MAX_PERSISTED_ERROR_CHARS = 500

export function nextConsecutiveFailureCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return 1
  return value === Number.MAX_SAFE_INTEGER
    ? Number.MAX_SAFE_INTEGER
    : (value as number) + 1
}

function boundedErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (raw.length <= MAX_PERSISTED_ERROR_CHARS) return raw
  return `${raw.slice(0, MAX_PERSISTED_ERROR_CHARS - 3)}...`
}

// Source keys listed (comma-separated) in STALENESS_CAP_EXEMPT may serve a
// beyond-cap snapshot, or use their absentFallback when no snapshot exists.
// Read at call time, not module scope: the deploy-time runtime snapshot
// evaluates modules before per-run env injection.
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
    absentFallback?: () => T
  ): Promise<T> {
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
      // Health lives in sync state. Never allow an upstream response body to
      // turn one failure into an over-limit state that wedges every later run.
      const msg = boundedErrorMessage(err)
      if (this.mode === "strict") throw new Error(`[${key}] ${msg}`)

      const exempt = stalenessCapExempt().has(key)
      const snap = this.prevSnapshots[key]
      const nowMs = Date.parse(this.nowIso)
      const lastSuccessMs = snap ? Date.parse(snap.lastSuccessAt) : NaN
      const validSnapshotTime =
        Number.isFinite(nowMs) &&
        Number.isFinite(lastSuccessMs) &&
        lastSuccessMs <= nowMs
      const ageMs = validSnapshotTime
        ? nowMs - lastSuccessMs
        : Number.POSITIVE_INFINITY
      const beyondCap = ageMs > STALENESS_CAP_MS

      // Exemptions may extend a valid old snapshot, but must never bless a
      // corrupt or future timestamp: its age is unknowable.
      if (snap && validSnapshotTime && (!beyondCap || exempt)) {
        if (beyondCap) {
          console.warn(
            `[resilience] STALENESS_CAP_EXEMPT: serving "${key}" snapshot ${Math.round(ageMs / 3_600_000)}h old (cap ${STALENESS_CAP_MS / 3_600_000}h)`
          )
        }
        this.snapshots[key] = snap
        this.sourceHealth[key] = {
          ok: false,
          lastSuccessAt: snap.lastSuccessAt,
          consecutiveFailures: nextConsecutiveFailureCount(
            this.prevHealth[key]?.consecutiveFailures
          ),
          lastError: msg,
          servedFromCache: true,
        }
        return snap.data as T
      }

      if (exempt && absentFallback) {
        // No snapshot to serve. Deliberately NOT stored as a snapshot —
        // an empty "last known good" would be served as real data later.
        console.warn(
          `[resilience] STALENESS_CAP_EXEMPT: "${key}" failed with no snapshot — degraded fallback: ${msg}`
        )
        this.sourceHealth[key] = {
          ok: false,
          lastSuccessAt: this.prevHealth[key]?.lastSuccessAt ?? null,
          consecutiveFailures: nextConsecutiveFailureCount(
            this.prevHealth[key]?.consecutiveFailures
          ),
          lastError: msg,
          servedFromCache: false,
        }
        return absentFallback()
      }

      const invalidTime = snap && !validSnapshotTime
      throw new Error(
        `[${key}] ${msg}${invalidTime ? " (snapshot lastSuccessAt is invalid or in the future)" : ""}`
      )
    }
  }
}
