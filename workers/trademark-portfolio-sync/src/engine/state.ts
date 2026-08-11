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

export function packSnapshots(s: SourceSnapshots): string {
  return gzipSync(Buffer.from(JSON.stringify(s), "utf8")).toString("base64")
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
      return JSON.parse(
        gunzipSync(Buffer.from(packed, "base64")).toString("utf8")
      ) as SourceSnapshots
    } catch (err) {
      console.warn(
        `[state] failed to unpack snapshots, starting without: ${err}`
      )
      return {}
    }
  }
  return legacy ?? {}
}
