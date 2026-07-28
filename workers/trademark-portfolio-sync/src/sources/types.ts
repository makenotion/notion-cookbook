// ──────────────────────────────────────────────────────────────────────
// Source adapter contracts
// ──────────────────────────────────────────────────────────────────────
//
// Three families of source feed the portfolio:
//
//   • Registry adapters discover marks and normalize them — USPTO for US
//     rows (UsCase), TMview for everything else (ForeignMark), plus
//     official per-office overlays (OfficialOverlay) that refine TMview
//     rows with authoritative data.
//   • The counsel-docket adapter parses your outside counsel's .xlsx
//     reports into DocketEntry/DocketAction — exact deadlines, lapse
//     instructions, and filings no registry API can enumerate.
//   • A spend adapter adds legal cost per mark from your e-billing system
//     (ships as a stub).

// Registry office codes (WIPO ST.3-style): "US", "EU", "GB", "WO", …
export type Office = string

// A US case as normalized from the USPTO search backend, optionally
// overlaid with same-day TSDR data when a TSDR_API_KEY is configured.
// null means "not provided / not applicable".
export type UsCase = {
  serial: string // 8 digits — also the row key
  registrationNumber: string | null
  wordmark: string | null // the literal element; null for pure designs
  markDescription: string | null
  hasDesignElement: boolean
  statusText: string | null // office descriptor, e.g. "Registered."
  tm5StatusDesc: string | null // harmonized "LIVE/…" | "DEAD/…"
  statusDate: string | null // YYYY-MM-DD (all dates below likewise)
  filingDate: string | null
  registrationDate: string | null
  publishedDate: string | null
  noticeOfAllowanceDate: string | null
  dateAbandoned: string | null
  dateCancelled: string | null
  basis: string | null // "1a" use / "1b" intent-to-use / "44e" / "66a"
  niceClasses: string[] // zero-padded, e.g. ["009", "042"]
  goodsAndServices: string | null
  section8Accepted: boolean // §8/§71 declaration accepted on record
  register: string | null // Principal / Supplemental
  irNumber: string | null // Madrid IR number for 66(a) filings
  attorneyDocket: string | null // your firm's reference, when on file
  disclaimer: string | null
}

// A non-US mark as normalized from TMview. ST13 is WIPO's global mark
// identifier and the row key for foreign rows.
export type ForeignMark = {
  st13: string
  office: Office
  name: string | null
  applicationNumber: string | null
  registrationNumber: string | null
  applicationDate: string | null
  registrationDate: string | null
  expirationDate: string | null
  oppositionDeadline: string | null
  status: string | null // TMview status text
  statusDate: string | null
  tmType: string | null // Individual / Figurative / Combined / …
  niceClasses: string[]
  designations: string[] // Madrid IRs: designated offices; else empty
}

// Authoritative overlay from an official office API (IP Australia, EUIPO).
// Applied onto the matching ForeignMark — enrichment only, never row-
// defining, so a failure degrades instead of aborting a cycle.
export type OfficialOverlay = {
  status: string | null
  statusDate: string | null
  applicationDate: string | null
  registrationDate: string | null
  renewalDue: string | null
}

// One filing row from counsel's Properties Report (the full-portfolio
// listing). Rows whose office+number match no registry row become
// standalone "DKT-" rows — typically direct national filings in offices
// TMview's index misses.
export type DocketEntry = {
  mark: string
  office: Office
  applicationNumber: string
  registrationNumber: string
  filedDate: string | null
  registrationDate: string | null
  status: string // counsel's status vocabulary, kept raw
  classes: string[]
  lapseInstructed: boolean // ALLOW TO LAPSE / RENUNCIATION
}

// One statutory action from counsel's Docket Report (upcoming deadlines).
// Where an action matches a row, counsel's exact date OVERRIDES the
// computed deadline estimate.
export type DocketAction = {
  dueDate: string | null
  action: string // e.g. "STATEMENT OF USE", "RESPONSE: OA (NON-FINAL)"
  reference: string // the firm's per-filing reference
  office: Office | null
  number: string // digits of the reg/serial the action attaches to
  title: string
}

export type CounselDocketData = {
  properties?: { fingerprint: string; file: string; entries: DocketEntry[] }
  docket?: { fingerprint: string; file: string; actions: DocketAction[] }
}

export type SpendInfo = { realized: number; pending: number }

export interface SpendAdapter {
  // Resolve spend for the given marks. `keys` are US serial numbers paired
  // with their wordmarks — most e-billing systems name trademark matters
  // after the mark, so wordmark matching is the practical join. Return {}
  // (keyed by serial) to add no enrichment.
  lookup(
    keys: Array<{ serial: string; wordmark: string | null }>
  ): Promise<Record<string, SpendInfo>>
}
