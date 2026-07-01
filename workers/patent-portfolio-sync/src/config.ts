// ──────────────────────────────────────────────────────────────────────
// Customization surface — start here
// ──────────────────────────────────────────────────────────────────────
//
// This is the main file you (or your AI coding agent, via /setup) edit to
// make the template yours. Code beyond src/sources/ and src/schema.ts
// rarely needs touching.

export type DocketConfig = {
  // Applied to a docket number; the first capture group is the family id
  // used to group offices (US + EP + …) into one family. Example for
  // "ACME.1234.US01":  /\.(\d+)\./
  familyRegex: RegExp
}

export const config = {
  // The Notion database title created on first deploy.
  notionDatabaseTitle: "Patent Portfolio",

  // CUSTOMIZE: your applicant name(s) exactly as registered with patent
  // offices — this drives USPTO and EPO discovery. Override locally for
  // testing with PORTFOLIO_APPLICANTS="Name A,Name B" in .env.
  applicants: process.env.PORTFOLIO_APPLICANTS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? ["ACME Corporation"],

  // Toggle sources. USPTO and EPO each work out of the box and are fully
  // independent — enable AT LEAST ONE (both is fine). Turn off the office
  // you don't have keys for yet: e.g. set epo: false to deploy on US data
  // alone, and add Europe later by flipping it back on. docketing + spend
  // are example stubs you implement against your own systems (see
  // src/sources/*.example.ts) — leave false until then.
  sources: {
    uspto: true,
    epo: true,
    docketing: false,
    spend: false,
  },

  // CUSTOMIZE only if docketing is enabled: how to derive a family id from
  // your docket numbers. null = no family grouping.
  docket: null as DocketConfig | null,
}
