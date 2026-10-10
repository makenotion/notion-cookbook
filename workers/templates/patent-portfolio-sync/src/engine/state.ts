// ──────────────────────────────────────────────────────────────────────
// Sync-state serialization + size discipline
// ──────────────────────────────────────────────────────────────────────
//
// Sync state has TWO distinct size limits, and the bigger one is not the
// one the docs mention:
//
//   1. The platform REJECTS SAVES over 256KB.
//   2. More subtly, a run FAILS TO *START* (instant exit, empty logs) when
//      handed state above an undocumented ceiling that has TIGHTENED over
//      time — ~200KB held in June 2026; production workers wedged at ~99KB
//      in August 2026. A state that saved fine can poison every subsequent
//      run; `sync state reset` recovers, but only until state regrows.
//
// So we (a) store the last-known-good snapshots gzip+base64 (≈10:1 on this
// data), (b) project hard at the fetch boundary (keep only the fields the
// join reads), and (c) pre-aggregate unbounded terms (per-transaction rows
// reduce to per-entity sums — history must never accumulate in state).
// Each delta cycle logs the packed size — budget the TOTAL state to stay
// well under ~80KB and shrink projections BEFORE it bites; the failure
// mode is silent.

import { gunzipSync, gzipSync } from "node:zlib"
import type { SourceSnapshots } from "./resilience.js"

// Leave headroom below the moving ~80KB run-input ceiling. Every state
// returned by a sync must pass this guard before any changes leave execute().
export const MAX_SAFE_SYNC_STATE_BYTES = 78_000

export function packJson(value: unknown): string {
  return gzipSync(Buffer.from(JSON.stringify(value), "utf8")).toString("base64")
}

export function unpackJson<T>(packed: string, label: string): T {
  if (!packed) throw new Error(`[state] ${label} is empty`)
  try {
    return JSON.parse(
      gunzipSync(Buffer.from(packed, "base64")).toString("utf8")
    ) as T
  } catch (err) {
    throw new Error(
      `[state] failed to unpack ${label}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

export function packSnapshots(s: SourceSnapshots): string {
  return packJson(s)
}

export function serializedStateBytes(state: unknown): number {
  let json: string | undefined
  try {
    json = JSON.stringify(state)
  } catch (err) {
    throw new Error(
      `[state] sync state is not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (json === undefined)
    throw new Error("[state] sync state is not JSON-serializable")
  return Buffer.byteLength(json, "utf8")
}

export function assertSafeSyncState(state: unknown, label: string): number {
  const bytes = serializedStateBytes(state)
  console.warn(
    `[${label}] total serialized state ${bytes}B (safe maximum ${MAX_SAFE_SYNC_STATE_BYTES - 1}B)`
  )
  if (bytes >= MAX_SAFE_SYNC_STATE_BYTES) {
    throw new Error(
      `[${label}] next state is ${bytes} UTF-8 bytes; refusing to return it because the safe maximum is ${MAX_SAFE_SYNC_STATE_BYTES - 1} bytes. Reduce the portfolio projection or move frozen sync data to durable sharded storage.`
    )
  }
  return bytes
}

// Accepts the packed form (preferred) or a plain object (tests / legacy
// state). A corrupt blob degrades to "no snapshots" — same as a first run —
// rather than failing the cycle.
export function unpackSnapshots(
  packed: string | undefined,
  legacy: SourceSnapshots | undefined
): SourceSnapshots {
  if (packed) {
    try {
      return unpackJson<SourceSnapshots>(packed, "snapshots")
    } catch (err) {
      console.warn(
        `[state] failed to unpack snapshots, starting without: ${err}`
      )
      return {}
    }
  }
  return legacy ?? {}
}
