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
  // Canonical office identifier: US serial (8 digits), PCT/CCYYYY/NNNNNN,
  // or EP application number (8 digits). Join logic adds jurisdiction to keys.
  applicationNumber: string
  title: string
  type: string | null // Original / Continuation / Regional Phase / ...
  filingDate: string | null // YYYY-MM-DD
  status: string | null
  statusDate: string | null
  grantDate: string | null
  patentNumber: string | null
  publicationNumber: string | null
  estExpiry: string | null // grant-gated term estimate, computed per office
  // Parent application numbers (same office) — e.g. the apps this one is a
  // continuation/divisional of. Used to group a portfolio into families
  // from public data alone, without a docketing system. USPTO parent
  // continuity and EPO divisional relations populate this; cross-office
  // grouping still comes from docketing or an authoritative family source.
  parents: string[]
}

export type DocketInfo = {
  docketNumber: string // non-empty; surrounding whitespace is discarded
  familyId: string | null // non-empty groups offices; null = explicitly ungrouped
}

export type DocketLookup = Record<string, DocketInfo>

export interface DocketingAdapter {
  // Resolve docket info for the given records. Prefer jurisdiction-qualified
  // keys (`US:17123456`, `EP:16730001`). Bare application-number keys remain
  // supported only when they identify exactly one jurisdiction in the fetched
  // portfolio; an ambiguous legacy key fails closed instead of enriching the
  // wrong row. Return only requested applications. Duplicate keys that normalize
  // to one application must agree. `familyId: null` deliberately leaves that
  // application ungrouped. Results are validated before becoming an LKG snapshot.
  lookup(records: PatentRecord[]): Promise<DocketLookup>
}

export type SpendInfo = { realized: number; pending: number }

export interface SpendAdapter {
  // Resolve aggregate spend for the requested matter/family keys. Omitted keys
  // mean zero; extra keys are rejected. realized/pending must both be finite,
  // non-negative numbers (decimals are allowed). Return {} for none. Results are
  // validated before becoming an LKG snapshot.
  lookup(keys: string[]): Promise<Record<string, SpendInfo>>
}
