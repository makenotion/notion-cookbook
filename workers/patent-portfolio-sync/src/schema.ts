// ──────────────────────────────────────────────────────────────────────
// Notion schema + row builders (keep these in lockstep)
// ──────────────────────────────────────────────────────────────────────
//
// The BASE schema is intentionally lean — the universally-meaningful patent
// fields. Source-specific columns are added only when that source is
// connected: Docket # with a docketing system, Total Spend/Pending with a
// spend system (see buildSchema). Richer EP register detail (designated
// states, renewals, X/Y citations), INPADOC family IDs, forward citations,
// and US term/prosecution fields are ADVANCED — added by
// /add-advanced-enrichment (see the advanced-enrichment skill).
//
// CUSTOMIZE: when you add a column, update the matching builder below AND
// make sure the join folds the value into the fingerprint
// (engine/fingerprint.ts). Those three edits travel together.

import * as Builder from "@notionhq/workers/builder"
import * as Schema from "@notionhq/workers/schema"
import type { DocketInfo, PatentRecord, SpendInfo } from "./sources/types.js"

export const DATABASE_KEY = "portfolio"

export type SchemaOpts = { docketing: boolean; spend: boolean }

// The schema is built from config so columns reflect what's actually
// connected. Note: ID is the required primary key (unique per row); family
// membership is expressed by the Parent relation / Sub-items, not a separate
// "Family ID" text column.
export function buildSchema(opts: SchemaOpts) {
  const base = {
    Title: Schema.title(),
    Source: Schema.select([
      { name: "USPTO", color: "blue" },
      { name: "EPO", color: "purple" },
    ]),
    Jurisdiction: Schema.select([
      { name: "US", color: "blue" },
      { name: "EP", color: "purple" },
    ]),
    Type: Schema.select([
      { name: "Family", color: "blue" },
      { name: "Original", color: "default" },
      { name: "Continuation", color: "green" },
      { name: "Continuation-in-Part", color: "yellow" },
      { name: "Divisional", color: "purple" },
      { name: "National Stage Entry", color: "pink" },
      { name: "National Phase", color: "pink" },
      { name: "PCT", color: "brown" },
      { name: "Reissue", color: "red" },
      { name: "Design", color: "gray" },
      { name: "Provisional", color: "orange" },
    ]),
    "App. No.": Schema.richText(),
    Status: Schema.richText(),
    "Status Date": Schema.date(),
    "Filing Date": Schema.date(),
    "Grant Date": Schema.date(),
    "Patent #": Schema.richText(),
    "Publication #": Schema.richText(),
    "Est. Expiry": Schema.date(),
    "# Apps": Schema.number(),
    "# Grants": Schema.number(),
    "Last Sync": Schema.date(),
    ID: Schema.richText(),
    Parent: Schema.relation(DATABASE_KEY, {
      twoWay: true,
      relatedPropertyName: "Sub-items",
    }),
  }
  // Conditional columns, added only when their source is connected.
  const extra: Record<string, ReturnType<typeof Schema.richText>> = {}
  if (opts.docketing) extra["Docket #"] = Schema.richText()
  if (opts.spend) {
    extra["Total Spend"] = Schema.number()
    extra["Total Pending"] = Schema.number()
  }
  return {
    properties: { ...base, ...extra },
    subItems: { parentPropertyName: "Parent", childPropertyName: "Sub-items" },
  }
}

// Stable, collision-proof row key (a US and EP application number could
// otherwise coincide). Also used as the ID column.
export const recordKey = (rec: PatentRecord): string =>
  `${rec.jurisdiction}-${rec.applicationNumber}`

export type Enrichment = {
  docket: DocketInfo | null
  familyId: string | null
  spend: SpendInfo | null
}

// Builders only emit a property when its value is present; Docket # and
// spend are gated by `enrich`, which the join populates only when those
// sources are connected — so they stay consistent with buildSchema.
export function buildAppProperties(
  rec: PatentRecord,
  enrich: Enrichment,
  lastSync: string
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    Title: Builder.title(rec.title),
    Source: Builder.select(rec.source),
    Jurisdiction: Builder.select(rec.jurisdiction),
    "App. No.": Builder.richText(rec.applicationNumber),
    ID: Builder.richText(recordKey(rec)),
    "Last Sync": Builder.date(lastSync),
  }
  if (rec.type) out.Type = Builder.select(rec.type)
  if (rec.status) out.Status = Builder.richText(rec.status)
  if (rec.statusDate) out["Status Date"] = Builder.date(rec.statusDate)
  if (rec.filingDate) out["Filing Date"] = Builder.date(rec.filingDate)
  if (rec.grantDate) out["Grant Date"] = Builder.date(rec.grantDate)
  if (rec.patentNumber) out["Patent #"] = Builder.richText(rec.patentNumber)
  if (rec.publicationNumber)
    out["Publication #"] = Builder.richText(rec.publicationNumber)
  if (rec.estExpiry) out["Est. Expiry"] = Builder.date(rec.estExpiry)
  // Family membership is the Parent relation (Sub-items), not a text column.
  if (enrich.familyId) out.Parent = [Builder.relation(enrich.familyId)]
  if (enrich.docket)
    out["Docket #"] = Builder.richText(enrich.docket.docketNumber)
  if (enrich.spend) {
    if (enrich.spend.realized > 0)
      out["Total Spend"] = Builder.number(enrich.spend.realized)
    if (enrich.spend.pending > 0)
      out["Total Pending"] = Builder.number(enrich.spend.pending)
  }
  return out
}

export type FamilyAggregate = {
  familyId: string
  title: string
  apps: number
  grants: number
  earliestFiling: string | null
  spend: SpendInfo | null
}

export function buildFamilyProperties(
  agg: FamilyAggregate,
  lastSync: string
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    Title: Builder.title(agg.title),
    Type: Builder.select("Family"),
    "# Apps": Builder.number(agg.apps),
    "# Grants": Builder.number(agg.grants),
    ID: Builder.richText(agg.familyId),
    "Last Sync": Builder.date(lastSync),
  }
  if (agg.earliestFiling) out["Filing Date"] = Builder.date(agg.earliestFiling)
  if (agg.spend) {
    if (agg.spend.realized > 0)
      out["Total Spend"] = Builder.number(agg.spend.realized)
    if (agg.spend.pending > 0)
      out["Total Pending"] = Builder.number(agg.spend.pending)
  }
  return out
}
