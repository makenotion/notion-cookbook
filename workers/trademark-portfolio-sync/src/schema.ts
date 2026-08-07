// ──────────────────────────────────────────────────────────────────────
// Portfolio schema — the Notion columns
// ──────────────────────────────────────────────────────────────────────
//
// Property order here is column order (left to right) in Notion. Two
// design rules worth keeping if you customize:
//
//   • Generous select option lists. Adding a select option later is a
//     schema migration, and a schema migration jams the delta until the
//     manual backfill runs — so offices and all 45 Nice classes are
//     pre-declared even if your portfolio uses a handful today.
//   • Managed-schema properties are READ-ONLY to workspace users and to
//     tools. Anything users or agent tools should edit (notes, owners,
//     file attachments like the mark images) belongs in user-space
//     properties added in the Notion UI — the sync never touches those.

import * as Schema from "@notionhq/workers/schema"

export const DATABASE_KEY = "trademarks"

// WIPO ST.3-style office codes seen in a typical mid-size portfolio, plus
// common Madrid designations — pre-declared so new filings rarely need a
// migration. EXTEND: add your offices; the join passes codes through.
const OFFICE_OPTIONS = [
  "US",
  "WO",
  "EU",
  "GB",
  "CA",
  "AU",
  "BR",
  "IN",
  "TH",
  "JP",
  "KR",
  "CN",
  "MX",
  "SG",
  "NZ",
  "CH",
  "IL",
  "AE",
  "NO",
  "TR",
  "ZA",
  "HK",
  "TW",
  "RU",
  "FR",
  "DE",
  "IT",
  "ES",
  "PL",
  "PT",
  "IE",
].map((name) => ({ name }))

// All 45 Nice international classes, so class changes never require a
// schema migration.
const NICE_CLASS_OPTIONS = Array.from({ length: 45 }, (_, i) => ({
  name: `IC ${String(i + 1).padStart(3, "0")}`,
}))

export function buildSchema(features: {
  counselDocket: boolean
  spend: boolean
}) {
  return {
    properties: {
      Mark: Schema.title(),
      // Registering office. US rows come from the USPTO adapter; the rest
      // from TMview (+ official overlays).
      Office: Schema.select(OFFICE_OPTIONS),
      // Where protection extends: the registering country for national
      // marks, the designated countries for Madrid IRs.
      Jurisdiction: Schema.multiSelect(OFFICE_OPTIONS),
      "Serial #": Schema.richText(),
      "Reg. #": Schema.richText(),
      // Madrid Protocol international registration number — the join key
      // between a national case and its IR.
      "IR #": Schema.richText(),
      // Coarse lifecycle bucket; the office's raw descriptor is preserved
      // in "Office Status".
      Status: Schema.select([
        { name: "Registered", color: "green" },
        { name: "Pending", color: "yellow" },
        { name: "Abandoned", color: "gray" },
        { name: "Cancelled", color: "red" },
        { name: "Expired", color: "red" },
      ]),
      "Office Status": Schema.richText(),
      "Status Date": Schema.date(),
      ...(features.counselDocket
        ? {
            // Counsel's docket says this mark is being deliberately
            // allowed to lapse (ALLOW TO LAPSE / RENUNCIATION in the
            // Properties Report). Register data can't know intent — this
            // flag can: the register shows a healthy registration for
            // months after the decision.
            "Lapse Instructed": Schema.checkbox(),
          }
        : {}),
      Type: Schema.select([
        { name: "Word", color: "blue" },
        { name: "Design", color: "purple" },
        { name: "Word + Design", color: "pink" },
      ]),
      Kind: Schema.multiSelect([
        { name: "Trademark", color: "blue" },
        { name: "Service Mark", color: "green" },
      ]),
      Classes: Schema.multiSelect(NICE_CLASS_OPTIONS),
      Filed: Schema.date(),
      Published: Schema.date(),
      Registered: Schema.date(),
      Register: Schema.select([
        { name: "Principal", color: "green" },
        { name: "Supplemental", color: "yellow" },
      ]),
      // Next action deadline across the whole lifecycle, with its type.
      // Statutory ESTIMATES (extensions and grace periods are not modeled
      // — an overdue date is a look-into-it signal, not proof of lapse);
      // where counsel's docket report covers a mark, counsel's exact
      // docketed date OVERRIDES the estimate.
      "Next Deadline": Schema.date(),
      "Deadline Type": Schema.select([
        { name: "OA Response", color: "red" },
        { name: "Statement of Use", color: "orange" },
        { name: "Opposition Window", color: "purple" },
        { name: "§8 Declaration", color: "yellow" },
        { name: "§8/§9 Renewal", color: "blue" },
        // Non-US registrations: the office's expiration date.
        { name: "Renewal", color: "green" },
        // Counsel-docketed action that doesn't map to a statutory type
        // above — the date is authoritative, the label generic.
        { name: "Docketed Action", color: "gray" },
      ]),
      Basis: Schema.select([
        { name: "1(a) Use", color: "green" },
        { name: "1(b) Intent to Use", color: "yellow" },
        { name: "44(d)/44(e) Foreign", color: "purple" },
        { name: "66(a) Madrid", color: "brown" },
      ]),
      "Goods & Services": Schema.richText(),
      // Disclaimed matter ("no exclusive claim to …") — scope-of-rights
      // signal.
      Disclaimer: Schema.richText(),
      // The prosecuting firm's reference, where the office has it on file.
      "Docket #": Schema.richText(),
      "Registry URL": Schema.url(),
      ...(features.spend
        ? {
            // From your e-billing adapter (src/sources/spend.example.ts).
            // When several live marks share a wordmark, split amounts
            // evenly so the column still sums to the true total.
            "Total Spend": Schema.number(),
            "Total Pending": Schema.number(),
          }
        : {}),
      "Last Sync": Schema.date(),
      ID: Schema.richText(),
    },
  }
}
