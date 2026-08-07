// ──────────────────────────────────────────────────────────────────────
// Spend adapter — EXAMPLE STUB (you implement this)
// ──────────────────────────────────────────────────────────────────────
//
// Adds legal cost per matter/family from your e-billing system (SimpleLegal,
// Legal Tracker, TyMetrix, an AP export, …) so the portfolio can answer
// fiscal-year cost questions. The keys you receive are the
// docket family IDs (or matter IDs) present in the portfolio — whatever
// your docketing adapter put on the rows.
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
  async lookup(keys: string[]): Promise<Record<string, SpendInfo>> {
    void keys
    // EXAMPLE — replace with a real call:
    //
    //   const token = await authenticate();
    //   const out: Record<string, SpendInfo> = {};
    //   for (const key of keys) {
    //     const invoices = await fetchInvoices(key);
    //     out[key] = {
    //       realized: sum(invoices.filter(i => i.status === "Approved")),
    //       pending:  sum(invoices.filter(i => i.status === "Pending")),
    //     };
    //   }
    //   return out;
    return {}
  },
}
