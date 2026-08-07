// ──────────────────────────────────────────────────────────────────────
// Spend adapter — EXAMPLE STUB (you implement this)
// ──────────────────────────────────────────────────────────────────────
//
// Adds legal cost per mark from your e-billing system (SimpleLegal, Legal
// Tracker, TyMetrix, an AP export, …) so the portfolio can
// answer fiscal-year cost questions. The keys you receive are US serial
// numbers paired with their wordmarks — trademark invoices rarely carry
// anything docket-shaped, but e-billing systems usually NAME trademark
// matters after the mark, so matching matter descriptions to wordmarks is
// the practical join. Return spend keyed by serial; {} adds no enrichment.
//
// The default returns {} — no spend enrichment. To enable:
//   1. Set config.sources.spend = true in config.ts.
//   2. Implement lookup() against your billing API (add auth to .env).
//
// NOTE (resolution budgeting): a cold cache may need many paced lookups,
// and a sync handler has a hard ~5-minute limit. If your system needs one
// call per matter, resolve in bounded chunks and cache results in sync
// state across cycles rather than fetching everything in one execute. See
// AGENTS.md (the ~5-minute per-execute budget) and the sync-engine skill's
// "Resolution budgeting" section.
//
// NOTE (state budgeting): if you cache raw per-invoice data in sync state,
// pre-aggregate it to per-matter sums first. Invoice counts grow without
// bound while matters track portfolio size — and the platform's run-input
// ceiling on sync state is undocumented and moving (observed as low as
// ~99KB in August 2026). See the sync-engine skill.

import type { SpendAdapter, SpendInfo } from "./types.js"

export const spendAdapter: SpendAdapter = {
  async lookup(
    keys: Array<{ serial: string; wordmark: string | null }>
  ): Promise<Record<string, SpendInfo>> {
    void keys
    // EXAMPLE — replace with a real call. The practical trademark join:
    //
    //   const norm = (s: string) =>
    //     s.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim()
    //   const token = await authenticate()
    //   const out: Record<string, SpendInfo> = {}
    //   for (const matter of await fetchTrademarkMatters(token)) {
    //     // Matters are usually named after the mark, so join on the
    //     // normalized description ↔ wordmark. The ≥4-char guard keeps a
    //     // short mark like "N" from matching half the ledger.
    //     const marks = keys.filter(
    //       (k) =>
    //         k.wordmark &&
    //         norm(k.wordmark).length >= 4 &&
    //         norm(matter.description) === norm(k.wordmark)
    //     )
    //     if (marks.length === 0) continue // log it — portfolio-level
    //     //   work (watch programs, enforcement) has no per-mark home
    //     // A matter naming several marks splits evenly, in integer
    //     // cents with the remainder on the first mark, so the shares
    //     // sum exactly and column totals stay truthful.
    //     const share = Math.floor(matter.approvedCents / marks.length)
    //     let rem = matter.approvedCents - share * marks.length
    //     for (const k of marks) {
    //       const cur = out[k.serial] ?? { realized: 0, pending: 0 }
    //       cur.realized += share + rem
    //       rem = 0
    //       out[k.serial] = cur
    //     }
    //   }
    //   return out
    return {}
  },
}
