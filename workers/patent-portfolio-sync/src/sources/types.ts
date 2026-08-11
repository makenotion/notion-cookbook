// ──────────────────────────────────────────────────────────────────────
// Source adapter contracts
// ──────────────────────────────────────────────────────────────────────
//
// A *patent office* adapter discovers applications for your applicant and
// normalizes them into PatentRecord[]. A *docketing* adapter enriches those
// rows with your firm's docket number + family grouping. A *spend* adapter
// adds legal cost. USPTO + EPO ship working; docketing + spend ship as
// stubs for you to implement against your own systems.

export type Jurisdiction = "US" | "EP"

// The normalized shape every patent-office adapter produces. Office-specific
// fields are nullable; null means "not applicable / not provided here."
export type PatentRecord = {
  source: "USPTO" | "EPO"
  jurisdiction: Jurisdiction
  applicationNumber: string // raw, office format (also the row key)
  title: string
  type: string | null // Original / Continuation / National Phase / ...
  filingDate: string | null // YYYY-MM-DD
  status: string | null
  statusDate: string | null
  grantDate: string | null
  patentNumber: string | null
  publicationNumber: string | null
  estExpiry: string | null // grant-gated term estimate, computed per office
  // Parent application numbers (same office) — e.g. the apps this one is a
  // continuation/divisional of. Used to group a portfolio into families
  // from public data alone, without a docketing system. US continuity
  // populates this; other offices leave it empty (cross-office grouping
  // comes from docketing or the optional INPADOC enrichment).
  parents: string[]
}

export type DocketInfo = {
  docketNumber: string
  familyId: string | null // groups offices into one family; null = ungrouped
}

export interface DocketingAdapter {
  // Resolve docket info for the given records, keyed by applicationNumber.
  // Return {} to add no enrichment.
  lookup(records: PatentRecord[]): Promise<Record<string, DocketInfo>>
}

export type SpendInfo = { realized: number; pending: number }

export interface SpendAdapter {
  // Resolve spend for the given matter/family keys. Return {} for none.
  lookup(keys: string[]): Promise<Record<string, SpendInfo>>
}
