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
// /add-advanced-enrichment (see
// domain-guides/advanced-enrichment/SKILL.md).
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
      { name: "Regional Phase", color: "pink" },
      { name: "PCT", color: "brown" },
      { name: "Reissue", color: "red" },
      { name: "Reexamination", color: "red" },
      { name: "Supplemental Examination", color: "red" },
      { name: "Design", color: "gray" },
      { name: "Plant", color: "green" },
      { name: "Provisional", color: "orange" },
      { name: "Substitute", color: "yellow" },
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
export function normalizeApplicationNumber(
  value: string,
  jurisdiction?: PatentRecord["jurisdiction"]
): string {
  let normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "")
  if (jurisdiction && normalized.startsWith(jurisdiction)) {
    normalized = normalized.slice(jurisdiction.length)
  }
  return normalized
}

export const applicationIdentity = (rec: PatentRecord): string =>
  `${rec.jurisdiction}:${normalizeApplicationNumber(rec.applicationNumber, rec.jurisdiction)}`

export const recordKey = (rec: PatentRecord): string =>
  `${rec.jurisdiction}-${normalizeApplicationNumber(rec.applicationNumber, rec.jurisdiction)}`

export type Enrichment = {
  docket: DocketInfo | null
  familyId: string | null
  spend: SpendInfo | null
  docketingEnabled?: boolean
  spendEnabled?: boolean
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
    Type: rec.type ? Builder.select(rec.type) : [],
    Status: rec.status ? Builder.richText(rec.status) : [],
    "Status Date": rec.statusDate ? Builder.date(rec.statusDate) : [],
    "Filing Date": rec.filingDate ? Builder.date(rec.filingDate) : [],
    "Grant Date": rec.grantDate ? Builder.date(rec.grantDate) : [],
    "Patent #": rec.patentNumber ? Builder.richText(rec.patentNumber) : [],
    "Publication #": rec.publicationNumber
      ? Builder.richText(rec.publicationNumber)
      : [],
    "Est. Expiry": rec.estExpiry ? Builder.date(rec.estExpiry) : [],
    "# Apps": [],
    "# Grants": [],
    ID: Builder.richText(recordKey(rec)),
    "Last Sync": Builder.date(lastSync),
    Parent: enrich.familyId ? [Builder.relation(enrich.familyId)] : [],
  }
  // Family membership is the Parent relation (Sub-items), not a text column.
  // Empty arrays are deliberate clears: incremental upserts retain every
  // property omitted from the payload.
  if (enrich.docketingEnabled ?? true) {
    out["Docket #"] = enrich.docket
      ? Builder.richText(enrich.docket.docketNumber)
      : []
  }
  if (enrich.spendEnabled) {
    // Spend is returned and displayed at family aggregate level. Application
    // rows must be blank—not a misleading numeric zero—and explicit clears
    // remove any values left by an earlier implementation.
    out["Total Spend"] = []
    out["Total Pending"] = []
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
  docketingEnabled?: boolean
  spendEnabled?: boolean
}

export function buildFamilyProperties(
  agg: FamilyAggregate,
  lastSync: string
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    Title: Builder.title(agg.title),
    Source: [],
    Jurisdiction: [],
    Type: Builder.select("Family"),
    "App. No.": [],
    Status: [],
    "Status Date": [],
    "Filing Date": agg.earliestFiling ? Builder.date(agg.earliestFiling) : [],
    "Grant Date": [],
    "Patent #": [],
    "Publication #": [],
    "Est. Expiry": [],
    "# Apps": Builder.number(agg.apps),
    "# Grants": Builder.number(agg.grants),
    ID: Builder.richText(agg.familyId),
    "Last Sync": Builder.date(lastSync),
    Parent: [],
  }
  if (agg.docketingEnabled) out["Docket #"] = []
  if (agg.spendEnabled ?? agg.spend !== null) {
    out["Total Spend"] = Builder.number(agg.spend?.realized ?? 0)
    out["Total Pending"] = Builder.number(agg.spend?.pending ?? 0)
  }
  return out
}
