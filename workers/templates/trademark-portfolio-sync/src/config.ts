// ──────────────────────────────────────────────────────────────────────
// Customization surface — start here
// ──────────────────────────────────────────────────────────────────────
//
// This is the main file you (or your AI coding agent, via /setup) edit to
// make the template yours. Code beyond src/sources/ and src/schema.ts
// rarely needs touching.

export const config = {
  // The Notion database title created on first deploy.
  notionDatabaseTitle: "Trademark Portfolio",

  // CUSTOMIZE: your company's name(s) exactly as recorded as the owner /
  // applicant with trademark offices — this drives discovery in both the
  // USPTO search backend and TMview. Check TSDR or TMview for the exact
  // string ("Acme Corporation" vs "Acme Corp."). Override locally for
  // testing with PORTFOLIO_OWNERS="Name A,Name B" in .env.
  ownerNames: process.env.PORTFOLIO_OWNERS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? ["ACME Corporation"],

  // Toggle sources. USPTO and TMview work out of the box WITH NO API KEY —
  // that is this template's superpower: deploy first, add keys later.
  //   uspto         — US marks: enumeration + full case data (keyless);
  //                   setting TSDR_API_KEY in .env upgrades freshness and
  //                   enables the document tools, no code change.
  //   tmview        — all non-US marks via EUIPN's cross-office aggregator
  //                   (keyless; a mirror, not the register of record).
  //   counselDocket — ingest your outside counsel's docket/properties
  //                   reports (.xlsx) from a Notion "Docket Inbox" page.
  //                   Needs DOCKET_INBOX_PAGE_ID + NOTION_API_TOKEN in
  //                   .env; see ONBOARDING.md step 6.
  //   ipAustralia / euipo — official office overlays for AU / EU rows
  //                   (authoritative statuses + renewal dates). Each needs
  //                   its own free-but-approved API credentials.
  //   spend         — per-mark legal cost from your e-billing system.
  //                   Ships as a stub (src/sources/spend.example.ts).
  sources: {
    uspto: true,
    tmview: true,
    counselDocket: false,
    ipAustralia: false,
    euipo: false,
    spend: false,
  },

  // CUSTOMIZE only if counselDocket is enabled: your client number at the
  // firm, exactly as it appears in the docket report's criteria block
  // (e.g. "Client: 123456"). The ingester REFUSES a report exported for a
  // different client — a guard against the firm attaching the wrong
  // client's docket. null skips the check.
  docketClientNumber: null as string | null,
}
