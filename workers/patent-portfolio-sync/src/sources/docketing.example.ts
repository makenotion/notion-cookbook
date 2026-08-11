// ──────────────────────────────────────────────────────────────────────
// Docketing adapter — EXAMPLE STUB (you implement this)
// ──────────────────────────────────────────────────────────────────────
//
// Patent offices don't know your firm's docket numbers or how you group
// applications into families. Your docketing system does (Anaqua,
// Foundation IP, CPA Global, an in-house DB, a spreadsheet export, …).
// This adapter is the bridge.
//
// The default implementation returns {} — no enrichment, so the portfolio
// runs on public office data alone. To enable it:
//   1. Set config.sources.docketing = true and config.docket in config.ts.
//   2. Implement lookup() against your system's API (add auth to .env).
//   3. Have your AI coding agent read AGENTS.md and the source-adapter skill
//      (.claude/skills/source-adapter) first — adding enrichment touches the
//      schema, the join, and the fingerprint.
//
// Returns docket info keyed by applicationNumber. familyId groups offices
// (US + EP + …) into one family; null leaves a row ungrouped.

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
    //     out[normalizeAppNo(m.applicationNumber)] = {
    //       docketNumber: m.docket,            // e.g. "ACME.1234.US01"
    //       familyId: familyFromDocket(m.docket), // e.g. "1234", or null
    //     };
    //   }
    //   return out;
    return {}
  },
}
