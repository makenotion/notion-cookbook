// ──────────────────────────────────────────────────────────────────────
// The join: assemble portfolio rows from all enabled sources
// ──────────────────────────────────────────────────────────────────────
//
// Each source fetch goes through the SourceRunner, so one upstream outage
// degrades gracefully instead of corrupting the portfolio. Office records
// become app rows; docketing (if enabled) links them into families and
// adds docket numbers; spend (if enabled) adds cost per family.
//
// EXTEND: cross-office dedup/suppression, INPADOC family IDs, member
// enrichment, citations, and richer family aggregation all hook in here.
// Keep fingerprintBasis in sync with whatever you add to the properties.

import { config } from "./config.js"
import {
  type SourceHealth,
  type SourceSnapshots,
  SourceRunner,
  type SyncMode,
} from "./engine/resilience.js"
import {
  buildAppProperties,
  buildFamilyProperties,
  type Enrichment,
  type FamilyAggregate,
  recordKey,
} from "./schema.js"
import { docketingAdapter } from "./sources/docketing.example.js"
import { spendAdapter } from "./sources/spend.example.js"
import { fetchEpoRecords } from "./sources/epo.js"
import type { DocketInfo, PatentRecord, SpendInfo } from "./sources/types.js"
import { fetchUsptoRecords } from "./sources/uspto.js"

export type PortfolioRow = {
  key: string
  properties: Record<string, unknown>
  fingerprintBasis: unknown // hashed for change detection; excludes Last Sync
}

// Group records into families from same-office parent links (union-find).
// Only records present in the portfolio are linked, so a chain whose parent
// is missing (abandoned, not returned) simply doesn't extend. Returns
// applicationNumber → familyId for every record; the family id is the
// earliest-filed member's application number (its founding application). A
// standalone application is its own one-member family (familyId = itself),
// so every app sits under a family — matching the docketing path, which
// also creates single-member families.
function deriveContinuityFamilies(
  records: PatentRecord[]
): Map<string, string> {
  const present = new Map(records.map((r) => [r.applicationNumber, r]))
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) && parent.get(r) !== r) r = parent.get(r)!
    parent.set(x, r)
    return r
  }
  const union = (a: string, b: string) => {
    parent.set(find(a), find(b))
  }
  for (const rec of records) {
    if (!parent.has(rec.applicationNumber))
      parent.set(rec.applicationNumber, rec.applicationNumber)
    for (const p of rec.parents) {
      if (present.has(p)) union(rec.applicationNumber, p)
    }
  }
  const groups = new Map<string, PatentRecord[]>()
  for (const rec of records) {
    const root = find(rec.applicationNumber)
    ;(groups.get(root) ?? groups.set(root, []).get(root)!).push(rec)
  }
  const out = new Map<string, string>()
  for (const members of groups.values()) {
    const founding = [...members].sort((a, b) =>
      (a.filingDate ?? "9999") < (b.filingDate ?? "9999")
        ? -1
        : (a.filingDate ?? "9999") > (b.filingDate ?? "9999")
          ? 1
          : a.applicationNumber < b.applicationNumber
            ? -1
            : 1
    )[0]
    for (const m of members)
      out.set(m.applicationNumber, founding.applicationNumber)
  }
  return out
}

export type BuildOpts = {
  mode: SyncMode
  nowIso: string
  prevSnapshots?: SourceSnapshots
  prevHealth?: SourceHealth
  pacers: { uspto: () => Promise<void>; epo: () => Promise<void> }
}

export async function buildPortfolioRows(opts: BuildOpts): Promise<{
  rows: PortfolioRow[]
  snapshots: SourceSnapshots
  sourceHealth: SourceHealth
}> {
  const runner = new SourceRunner({
    mode: opts.mode,
    prevSnapshots: opts.prevSnapshots,
    prevHealth: opts.prevHealth,
    nowIso: opts.nowIso,
  })
  const lastSync = opts.nowIso.slice(0, 10)

  // At least one patent office must be on, or the portfolio has no records
  // to build from — and a strict backfill would mark-and-sweep every live
  // row. Fail loud instead. USPTO and EPO are independent: run either alone
  // (just supply that office's keys) or both.
  if (!config.sources.uspto && !config.sources.epo) {
    throw new Error(
      "No patent-office source enabled — set config.sources.uspto and/or config.sources.epo to true (at least one is required)."
    )
  }

  // 1. Fetch patent-office records (resilient per source).
  const records: PatentRecord[] = []
  if (config.sources.uspto) {
    records.push(
      ...(await runner.run("uspto", () =>
        fetchUsptoRecords(config.applicants, opts.pacers.uspto)
      ))
    )
  }
  if (config.sources.epo) {
    records.push(
      ...(await runner.run("epo", () =>
        fetchEpoRecords(config.applicants, opts.pacers.epo)
      ))
    )
  }

  // 2. Docketing enrichment (docket # + family grouping), if enabled.
  let docketByApp: Record<string, DocketInfo> = {}
  if (config.sources.docketing) {
    docketByApp = await runner.run("docketing", () =>
      docketingAdapter.lookup(records)
    )
  }

  // Family grouping comes from docketing when available; otherwise we
  // derive it from public continuity (same-office parent links — a
  // continuation/divisional and its parent are one family). Docket family
  // wins when both exist.
  const continuityFamily = deriveContinuityFamilies(records)

  const enrichByKey = new Map<string, Enrichment>()
  const familyMembers = new Map<string, PatentRecord[]>()
  for (const rec of records) {
    const docket = docketByApp[rec.applicationNumber] ?? null
    const familyId =
      docket?.familyId ?? continuityFamily.get(rec.applicationNumber) ?? null
    enrichByKey.set(recordKey(rec), { docket, familyId, spend: null })
    if (familyId) {
      const arr = familyMembers.get(familyId) ?? []
      arr.push(rec)
      familyMembers.set(familyId, arr)
    }
  }

  // 3. Spend enrichment keyed by family, if enabled (and families exist).
  let spendByFamily: Record<string, SpendInfo> = {}
  if (config.sources.spend && familyMembers.size > 0) {
    spendByFamily = await runner.run("spend", () =>
      spendAdapter.lookup([...familyMembers.keys()])
    )
  }

  // 4. Build rows.
  const rows: PortfolioRow[] = []
  for (const rec of records) {
    const enrich = enrichByKey.get(recordKey(rec)) ?? {
      docket: null,
      familyId: null,
      spend: null,
    }
    rows.push({
      key: recordKey(rec),
      properties: buildAppProperties(rec, enrich, lastSync),
      fingerprintBasis: {
        rec,
        docket: enrich.docket,
        familyId: enrich.familyId,
      },
    })
  }
  for (const [familyId, members] of familyMembers) {
    const earliest =
      members
        .map((m) => m.filingDate)
        .filter((d): d is string => Boolean(d))
        .sort()[0] ?? null
    const titleMember = [...members].sort((a, b) =>
      (a.filingDate ?? "") < (b.filingDate ?? "") ? -1 : 1
    )[0]
    const spend = spendByFamily[familyId] ?? null
    const agg: FamilyAggregate = {
      familyId,
      title: titleMember?.title ?? familyId,
      apps: members.length,
      grants: members.filter((m) => m.grantDate).length,
      earliestFiling: earliest,
      spend,
    }
    rows.push({
      key: familyId,
      properties: buildFamilyProperties(agg, lastSync),
      fingerprintBasis: { family: agg },
    })
  }

  // Deterministic, stable order by key. The backfill paginates by slicing
  // this list across the executes of one sync cycle, so the order must be
  // identical on every rebuild or a slice could skip or duplicate a row.
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  return {
    rows,
    snapshots: runner.snapshots,
    sourceHealth: runner.sourceHealth,
  }
}
