// ──────────────────────────────────────────────────────────────────────
// Docketing adapter — EXAMPLE STUB (you implement this)
// ──────────────────────────────────────────────────────────────────────
//
// Patent offices don't know your firm's docket numbers or how you group
// applications into families. Your docketing system does (Anaqua,
// Foundation IP, CPA Global, an in-house DB, a spreadsheet export, …).
// This adapter is the bridge.
//
// The untouched stub deliberately throws if enabled, so an unimplemented
// source can never be recorded as a healthy empty result. Leave docketing
// disabled to run on public office data alone. To enable it:
//   1. Set config.sources.docketing = true and config.docket in config.ts.
//   2. Implement lookup() against your system's API (add auth to .env).
//   3. Have your AI coding agent read DEVELOPMENT.md and
//      domain-guides/source-adapter/SKILL.md first — adding enrichment touches
//      the schema, the join, and the fingerprint.
//
// Return docket info keyed preferably by jurisdiction-qualified application
// identity (for example US:17123456 or EP:16730001). A bare application number
// is accepted only when it identifies exactly one fetched jurisdiction.
// familyId groups offices (US + EP + …) into one family; null deliberately
// leaves that application ungrouped.

import type { DocketingAdapter, DocketInfo, PatentRecord } from "./types.js"

export const docketingAdapter: DocketingAdapter = {
  async lookup(records: PatentRecord[]): Promise<Record<string, DocketInfo>> {
    void records
    // EXAMPLE — replace with a real call. The shape you return:
    //
    //   const token = await authenticate(process.env.DOCKETING_API_KEY);
    //   const matters = await fetchMatters(token);
    //   const out: Record<string, DocketInfo> = {};
    //   for (const m of matters) {
    //     out[`${m.jurisdiction}:${normalizeAppNo(m.applicationNumber)}`] = {
    //       docketNumber: m.docket,            // e.g. "ACME.1234.US01"
    //       familyId: familyFromDocket(m.docket), // e.g. "1234", or null
    //     };
    //   }
    //   return out;
    throw new Error(
      "docketing source is enabled, but src/sources/docketing.example.ts is still the example stub; implement lookup() or set config.sources.docketing to false"
    )
  },
}
