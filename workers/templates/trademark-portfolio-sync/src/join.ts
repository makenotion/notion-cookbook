// ──────────────────────────────────────────────────────────────────────
// The join: sources → derivations → portfolio rows
// ──────────────────────────────────────────────────────────────────────
//
// Assembly order matters and encodes the trust model:
//
//   0. Counsel docket reports (if enabled) — resolved FIRST because
//      deadline overrides, lapse flags, and docket-only rows feed every
//      other row builder. In strict mode a docket failure ABORTS the
//      cycle: a replace-mode sweep built without the docket would delete
//      the docket-only rows, and the delta's unchanged fingerprints would
//      keep the deletion invisible afterwards.
//   1. USPTO — US rows (row-defining; strict failures abort).
//   2. TMview — all non-US rows (row-defining; strict failures abort).
//   3. Official overlays (IP Australia, EUIPO) — enrichment of TMview
//      rows. NEVER cycle-fatal, even in strict mode: fingerprints
//      self-heal the enriched values when the office API recovers.
//   4. Spend — enrichment of US rows via your adapter. Never cycle-fatal.
//
// Deadline precedence, most→least authoritative:
//   counsel's docketed date  >  computed statutory estimate  >  office
//   expiration date (foreign)  >  none.

import * as Builder from "@notionhq/workers/builder"
import { SourceRunner, WAF_STALENESS_CAP_MS } from "./engine/resilience.js"
import type {
  SourceHealth,
  SourceSnapshots,
  SyncMode,
} from "./engine/resilience.js"
import { config } from "./config.js"
import { DERIVATION_VERSION } from "./engine/fingerprint.js"
import {
  docketInboxPageId,
  fetchCounselDocket,
} from "./sources/counsel-docket.js"
import { fetchForeignMarks, TMVIEW_PAGE_URL } from "./sources/tmview.js"
import { fetchIpaOverlays } from "./sources/ipaustralia.js"
import { fetchEuipoOverlays } from "./sources/euipo.js"
import { fetchUsCases } from "./sources/uspto.js"
import { spendAdapter } from "./sources/spend.example.js"
import type {
  CounselDocketData,
  DocketAction,
  DocketEntry,
  ForeignMark,
  Office,
  OfficialOverlay,
  SpendInfo,
  UsCase,
} from "./sources/types.js"

export type PortfolioRow = {
  key: string // US serial | ST13 | DKT-{office}-{A|R}-{normalized identifier}
  properties: Record<string, unknown>
  fingerprintBasis: unknown
}

export type Pacers = {
  tmsearch: () => Promise<void>
  tsdr: () => Promise<void>
  tmview: () => Promise<void>
  official: () => Promise<void>
}

// ── Small date helpers (YYYY-MM-DD strings; UTC; no Date-object drift) ──

// Month arithmetic with month-end clamping (Jan 31 + 3mo → Apr 30).
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number)
  const total = y * 12 + (m - 1) + months
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate()
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-${String(
    Math.min(d, lastDay)
  ).padStart(2, "0")}`
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

// Year arithmetic via addMonths so a Feb-29 anniversary clamps to Feb-28
// instead of emitting an invalid date.
const addYears = (iso: string, years: number): string =>
  addMonths(iso, years * 12)

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

// ── Status bucketing ───────────────────────────────────────────────────

export type StatusBucket =
  | "Registered"
  | "Pending"
  | "Abandoned"
  | "Cancelled"
  | "Expired"

// Coarse lifecycle bucket. The TM5 harmonized status ("LIVE/…" | "DEAD/…")
// plus the explicit abandon/cancel dates carry the signal; descriptor
// keywords only DISAMBIGUATE a dead state — they must never establish one.
// A live registration in an adversarial proceeding carries descriptors
// like "A cancellation proceeding is pending…", and bucketing it Cancelled
// would both mislabel the mark and suppress its renewal deadline on
// exactly the row under attack.
export function statusBucket(c: UsCase): StatusBucket {
  const s = c.statusText ?? ""
  const dead =
    /^DEAD/i.test(c.tm5StatusDesc ?? "") ||
    Boolean(c.dateAbandoned) ||
    Boolean(c.dateCancelled)
  if (dead) {
    if (c.dateCancelled || /cancell/i.test(s)) return "Cancelled"
    if (/expir/i.test(s)) return "Expired"
    return "Abandoned"
  }
  if (c.registrationNumber) return "Registered"
  return "Pending"
}

// Foreign status values are short harmonized labels (TMview) or office
// overlay descriptors. Match complete lifecycle words, never arbitrary
// substrings: "Pending" contains "end", and terminal descriptors can also
// retain words such as "protected" (for example "Protection expired").
export function foreignStatusBucket(status: string | null): StatusBucket {
  const value = (status ?? "").trim()
  // Descriptor prose can mention a refusal appeal, opposition, or pending
  // cancellation while the right remains live. Those words must not create a
  // terminal lifecycle state merely by appearing somewhere in the text.
  const activeProceeding =
    /\b(?:pending|appeal(?:ed|ing)?|proceeding|opposition|suspended|under review)\b/i.test(
      value
    )
  if (activeProceeding) {
    return /\b(?:registered|protected|registration active|live)\b/i.test(value)
      ? "Registered"
      : "Pending"
  }

  // Expiration labels are terminal even when the office phrases them as
  // "Protection expired". The active-proceeding guard above still prevents
  // an appeal/pending descriptor from establishing finality by prose alone.
  if (
    /^(?:dead[\s/:;-]+)?(?:protection |registration )?(?:expired|expiry|expiration|lapsed)(?:[\s.!/:;-].*)?$/i.test(
      value
    )
  )
    return "Expired"

  if (
    /^(?:dead[\s/:;-]+)?(?:(?:trade ?mark|mark|registration|protection)[\s/:;-]+(?:is |has been )?)?(?:cancelled|canceled)(?:[\s.!/:;-].*)?$/i.test(
      value
    )
  )
    return "Cancelled"
  if (
    /^(?:(?:trade ?mark )?application (?:is |has been )?)?(?:end|ended|withdrawn|withdrawal|refused|refusal|abandoned|dead|total refusal)(?:[\s.!/:;-].*)?$/i.test(
      value
    )
  )
    return "Abandoned"
  if (/\b(?:registered|protected|registration active|live)\b/i.test(value))
    return "Registered"
  return "Pending"
}

// ── US deadline engine ─────────────────────────────────────────────────

type Deadline = { date: string; type: string }

// Next §8/§9 maintenance deadline for a US registration:
//   • §8 declaration of use: due by the 6th anniversary of registration.
//   • §8/§9 combined renewal: due by the 10th anniversary, then every 10
//     years. Once the §8 is accepted on record, the year-6 deadline is
//     behind us and the next 10-year renewal is what's due.
function nextRenewalDue(
  registrationDate: string | null,
  section8Accepted: boolean,
  today: string
): string | null {
  if (!registrationDate) return null
  if (!section8Accepted) {
    // Past-due with no acceptance on record is still shown — an overdue
    // §8 is precisely the lapse-risk signal this column exists for.
    return addYears(registrationDate, 6)
  }
  for (let k = 1; k <= 20; k++) {
    const due = addYears(registrationDate, 10 * k)
    if (due >= today) return due
  }
  return null
}

// Next US action deadline across the lifecycle. Statutory estimates —
// extensions of time and grace periods are NOT modeled, so an overdue
// date means "look into it", not necessarily "lapsed":
//   • Outstanding office action → mail date + 3 months (§2.62 shortened
//     period, post-2022; extendable to 6 for a fee).
//   • Notice of Allowance / extensions → Statement of Use due on a strict
//     6-month lattice from the NOA date (up to the 36-month maximum).
//   • Published for opposition → the 30-day window's end, FUTURE ONLY
//     (the opposition deadline belongs to third parties; once closed it
//     is noise, unlike an overdue OA response).
//   • Registered → §8 at year 6 until accepted, then §8/§9 renewals.
// States with the ball in the office's court (new application, SOU under
// review, suspended) and dead marks get no deadline.
export function computeNextDeadline(c: UsCase, today: string): Deadline | null {
  const bucket = statusBucket(c)
  if (bucket === "Abandoned" || bucket === "Cancelled" || bucket === "Expired")
    return null
  if (bucket === "Registered") {
    const due = nextRenewalDue(c.registrationDate, c.section8Accepted, today)
    if (!due) return null
    const isSection8 =
      !c.section8Accepted &&
      c.registrationDate != null &&
      due === addMonths(c.registrationDate, 72)
    return { date: due, type: isSection8 ? "§8 Declaration" : "§8/§9 Renewal" }
  }
  const st = c.statusText ?? ""
  const anchor = c.statusDate
  if (
    /(non-?final|final) (office )?action.*(mailed|sent|issued)|office action has been (sent|issued)/i.test(
      st
    )
  ) {
    return anchor ? { date: addMonths(anchor, 3), type: "OA Response" } : null
  }
  // SOU pipeline: allowance → extensions → SOU under review. Deadlines run
  // on a strict 6-month lattice from the Notice of Allowance date — the
  // lattice reproduces what firms docket, where status-date-based
  // estimates drift by the office's processing lag.
  if (/notice of allowance|extension|statement of use|^SU /i.test(st)) {
    if (c.noticeOfAllowanceDate) {
      for (let n = 1; n <= 6; n++) {
        const due = addMonths(c.noticeOfAllowanceDate, 6 * n)
        if (due >= today) return { date: due, type: "Statement of Use" }
      }
      return null // >36 months past allowance — pipeline exhausted
    }
    // Keyless fallback (no NOA date without the TSDR overlay).
    if (anchor && /notice of allowance|extension.*granted/i.test(st)) {
      return { date: addMonths(anchor, 6), type: "Statement of Use" }
    }
    return null
  }
  if (/published for opposition/i.test(st)) {
    const base = c.publishedDate ?? anchor
    if (!base) return null
    const due = addDays(base, 30)
    return due >= today ? { date: due, type: "Opposition Window" } : null
  }
  return null
}

// ── Counsel-docket derivations ─────────────────────────────────────────

const normalizedIdentifier = (s: string) =>
  s.toUpperCase().replace(/[^A-Z0-9]/g, "")
const canonicalLegalIdentifier = (s: string) => {
  const normalized = normalizedIdentifier(s)
  return /^\d+$/.test(normalized)
    ? normalized.replace(/^0+(?=\d)/, "")
    : normalized
}

type DocketCtx = {
  entries: DocketEntry[]
  actions: DocketAction[] // dueDate always non-null
  lapseKeys: ReadonlySet<string>
}

const EMPTY_DOCKET: DocketCtx = {
  entries: [],
  actions: [],
  lapseKeys: new Set(),
}

function makeDocketCtx(d: CounselDocketData): DocketCtx {
  const entries = d.properties?.entries ?? []
  const actions = (d.docket?.actions ?? []).filter((a) => Boolean(a.dueDate))
  // Office-scoped identifier keys for every lapse-instructed entry. A national
  // designation instruction must never flag a same-number WO registration;
  // only an explicit WO docket entry may set the WO row's single boolean.
  const lapseKeys = new Set(
    entries
      .filter((e) => e.lapseInstructed)
      .flatMap((e) =>
        [e.applicationNumber, e.registrationNumber]
          .map(canonicalLegalIdentifier)
          .filter(Boolean)
          .map((n) => `${e.office}-${n}`)
      )
  )
  return { entries, actions, lapseKeys }
}

// Counsel's docketed action names → the schema's Deadline Type vocabulary.
function docketActionType(action: string, office: Office): string {
  if (/STATEMENT OF USE|ITU EXTENSION/i.test(action)) return "Statement of Use"
  if (/OA|OFFICE ACTION|RESPONSE/i.test(action)) return "OA Response"
  if (/RENEWAL/i.test(action))
    return office === "US" ? "§8/§9 Renewal" : "Renewal"
  if (/OPPOSITION/i.test(action)) return "Opposition Window"
  return "Docketed Action"
}

// Counsel-docketed deadline override for a row: when the firm has a
// statutory action docketed for this mark, their exact date beats our
// estimate. Matched by the firm reference (globally unique) or by
// office + canonical serial/registration identifier; earliest due date wins
// when several actions are docketed (e.g. an SOU plus its backup extension).
// The identifier path REQUIRES the action to carry an office: identifiers
// collide across registers even after alphanumeric normalization.
function docketDeadlineFor(
  docket: DocketCtx,
  office: Office,
  numbers: Array<string | null>,
  docketRef?: string | null
): Deadline | null {
  const identifiers = numbers
    .map((n) => (n ? canonicalLegalIdentifier(n) : ""))
    .filter(Boolean)
  const hits = docket.actions
    .filter((a) => {
      if (docketRef && a.reference && a.reference === docketRef) return true
      if (!a.office || a.office !== office) return false
      return identifiers.includes(canonicalLegalIdentifier(a.number))
    })
    .sort((x, y) => (x.dueDate! < y.dueDate! ? -1 : 1))
  const hit = hits[0]
  return hit
    ? { date: hit.dueDate!, type: docketActionType(hit.action, office) }
    : null
}

function lapseInstructedFor(
  docket: DocketCtx,
  office: Office,
  numbers: Array<string | null>
): boolean {
  return numbers.some((n) => {
    const d = n ? canonicalLegalIdentifier(n) : ""
    return d !== "" && docket.lapseKeys.has(`${office}-${d}`)
  })
}

// ── Row builders ───────────────────────────────────────────────────────

const TSDR_PAGE_URL = (serial: string) =>
  `https://tsdr.uspto.gov/#caseNumber=${serial}&caseType=SERIAL_NO&searchType=statusSearch`

// First sentence of an office status descriptor (some embed boilerplate
// tails and HTML anchors).
function firstSentence(text: string): string {
  const plain = text
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
  const m = /\.\s+[A-Z]/.exec(plain)
  return m ? plain.slice(0, m.index + 1) : plain
}

// Kind from the Nice classification: classes 1-34 are goods (Trademark),
// 35-45 are services (Service Mark).
function kindsFromClasses(niceClasses: string[]): string[] {
  return [
    ...(niceClasses.some((n) => Number(n) <= 34) ? ["Trademark"] : []),
    ...(niceClasses.some((n) => Number(n) >= 35) ? ["Service Mark"] : []),
  ]
}

function buildUsRow(
  docket: DocketCtx,
  c: UsCase,
  spend: SpendInfo | null,
  today: string
): PortfolioRow {
  const bucket = statusBucket(c)
  const title =
    c.wordmark ??
    (c.markDescription
      ? `Design — ${truncate(c.markDescription.replace(/^the mark consists of\s*/i, ""), 60)}`
      : `Design mark ${c.serial}`)
  const type = c.wordmark
    ? c.hasDesignElement
      ? "Word + Design"
      : "Word"
    : "Design"
  const deadline =
    docketDeadlineFor(
      docket,
      "US",
      [c.serial, c.registrationNumber],
      c.attorneyDocket
    ) ?? computeNextDeadline(c, today)
  const basisName =
    c.basis === "1a"
      ? "1(a) Use"
      : c.basis === "1b"
        ? "1(b) Intent to Use"
        : c.basis === "44"
          ? "44(d)/44(e) Foreign"
          : c.basis === "66a"
            ? "66(a) Madrid"
            : null

  const properties: Record<string, unknown> = {
    Mark: Builder.title(title),
    Office: Builder.select("US"),
    Jurisdiction: Builder.multiSelect("US"),
    "Serial #": Builder.richText(c.serial),
    "Reg. #": Builder.richText(c.registrationNumber ?? ""),
    "IR #": Builder.richText(c.irNumber ?? ""),
    Status: Builder.select(bucket),
    "Office Status": Builder.richText(firstSentence(c.statusText ?? "")),
    "Status Date": c.statusDate
      ? Builder.date(c.statusDate)
      : Builder.richText(""),
    Type: Builder.select(type),
    Kind: Builder.multiSelect(...kindsFromClasses(c.niceClasses)),
    Classes: Builder.multiSelect(...c.niceClasses.map((n) => `IC ${n}`)),
    "Goods & Services": Builder.richText(
      truncate(c.goodsAndServices ?? "", 1900)
    ),
    Disclaimer: Builder.richText(truncate(c.disclaimer ?? "", 1900)),
    "Docket #": Builder.richText(c.attorneyDocket ?? ""),
    "Registry URL": Builder.url(TSDR_PAGE_URL(c.serial)),
    ID: Builder.richText(c.serial),
    Filed: c.filingDate ? Builder.date(c.filingDate) : Builder.richText(""),
    Published: c.publishedDate
      ? Builder.date(c.publishedDate)
      : Builder.richText(""),
    Registered: c.registrationDate
      ? Builder.date(c.registrationDate)
      : Builder.richText(""),
    Register:
      c.registrationNumber && c.register
        ? Builder.select(c.register)
        : Builder.richText(""),
    Basis: basisName ? Builder.select(basisName) : Builder.richText(""),
    // Blank explicitly when absent so incremental upserts clear stale
    // values (e.g. a deadline that was met). Dates blank via richText("")
    // — the platform accepts it as "clear this property".
    "Next Deadline": deadline
      ? Builder.date(deadline.date)
      : Builder.richText(""),
    "Deadline Type": deadline
      ? Builder.select(deadline.type)
      : Builder.richText(""),
  }
  if (config.sources.counselDocket) {
    properties["Lapse Instructed"] = Builder.checkbox(
      lapseInstructedFor(docket, "US", [c.serial, c.registrationNumber])
    )
  }
  if (config.sources.spend) {
    properties["Total Spend"] =
      spend?.realized != null
        ? Builder.number(spend.realized)
        : Builder.richText("")
    properties["Total Pending"] =
      spend?.pending != null
        ? Builder.number(spend.pending)
        : Builder.richText("")
  }
  return { key: c.serial, properties, fingerprintBasis: properties }
}

function buildForeignRow(
  docket: DocketCtx,
  m: ForeignMark,
  today: string
): PortfolioRow {
  const st = m.status ?? ""
  const bucket = foreignStatusBucket(st)
  const type = /figurative|design/i.test(m.tmType ?? "")
    ? /word|combined/i.test(m.tmType ?? "")
      ? "Word + Design"
      : "Design"
    : /combined/i.test(m.tmType ?? "")
      ? "Word + Design"
      : "Word"
  // Deadline: counsel's docketed date wins; else registered marks carry
  // the office's expiration date, pending marks a still-open opposition
  // window (TMview mirrors no office actions).
  let deadline = docketDeadlineFor(docket, m.office, [
    m.applicationNumber,
    m.registrationNumber,
  ])
  if (!deadline && bucket === "Registered" && m.expirationDate) {
    deadline = { date: m.expirationDate, type: "Renewal" }
  } else if (
    !deadline &&
    bucket === "Pending" &&
    m.oppositionDeadline &&
    m.oppositionDeadline >= today
  ) {
    deadline = { date: m.oppositionDeadline, type: "Opposition Window" }
  }

  const properties: Record<string, unknown> = {
    Mark: Builder.title(
      m.name ?? `${m.office} mark ${m.applicationNumber ?? m.st13}`
    ),
    Office: Builder.select(m.office),
    Jurisdiction: Builder.multiSelect(
      ...(m.designations.length ? m.designations : [m.office])
    ),
    "Serial #": Builder.richText(m.applicationNumber ?? ""),
    "Reg. #": Builder.richText(m.registrationNumber ?? ""),
    // WO rows ARE the international registrations.
    "IR #": Builder.richText(
      m.office === "WO" ? (m.registrationNumber ?? "") : ""
    ),
    Status: Builder.select(bucket),
    "Office Status": Builder.richText(st),
    "Status Date": m.statusDate
      ? Builder.date(m.statusDate)
      : Builder.richText(""),
    Type: Builder.select(type),
    Kind: Builder.multiSelect(...kindsFromClasses(m.niceClasses)),
    Classes: Builder.multiSelect(...m.niceClasses.map((n) => `IC ${n}`)),
    "Registry URL": Builder.url(TMVIEW_PAGE_URL(m.st13)),
    ID: Builder.richText(m.st13),
    Filed: m.applicationDate
      ? Builder.date(m.applicationDate)
      : Builder.richText(""),
    Registered: m.registrationDate
      ? Builder.date(m.registrationDate)
      : Builder.richText(""),
    "Next Deadline": deadline
      ? Builder.date(deadline.date)
      : Builder.richText(""),
    "Deadline Type": deadline
      ? Builder.select(deadline.type)
      : Builder.richText(""),
  }
  if (config.sources.counselDocket) {
    properties["Lapse Instructed"] = Builder.checkbox(
      lapseInstructedFor(docket, m.office, [
        m.applicationNumber,
        m.registrationNumber,
      ])
    )
  }
  return { key: m.st13, properties, fingerprintBasis: properties }
}

// Rows for counsel-docket entries with no registry counterpart — direct
// national filings in offices the registry aggregators can't enumerate.
// Keyed DKT-{office}-{A|R}-{full normalized identifier}; status is counsel's,
// mapped to the buckets, with the raw text kept in Office Status with a
// provenance suffix. The A/R namespace and preserved letters prevent
// application/registration and AB123/123 collisions.
function buildDocketOnlyRow(
  docket: DocketCtx,
  e: DocketEntry,
  today: string
): PortfolioRow {
  const st = e.status
  const bucket: StatusBucket =
    st === "REGISTERED"
      ? "Registered"
      : /PENDING|PUBLISHED|ALLOWED/.test(st)
        ? "Pending"
        : st === "RENUNCIATION"
          ? "Cancelled"
          : /ALLOW TO LAPSE/.test(st)
            ? "Registered" // still on the register; the flag carries intent
            : "Abandoned" // ABANDONED / CLOSED / TOTAL REFUSAL …
  // Renewal forecast: 10-year cycles, filing-anniversary-based in some
  // systems (EU-style), registration-based in most others. An
  // approximation with the usual caveat; official overlays win where
  // connected. Lapse-instructed marks get none.
  const FILING_BASED = new Set([
    "EU",
    "GB",
    "AU",
    "FR",
    "DE",
    "IT",
    "ES",
    "PL",
    "PT",
    "IE",
    "IN",
  ])
  const number = e.applicationNumber || e.registrationNumber
  let deadline = docketDeadlineFor(docket, e.office, [
    e.applicationNumber,
    e.registrationNumber,
  ])
  if (!deadline && bucket === "Registered" && !e.lapseInstructed) {
    const base = FILING_BASED.has(e.office)
      ? (e.filedDate ?? e.registrationDate)
      : (e.registrationDate ?? e.filedDate)
    if (base) {
      for (let k = 1; k <= 20; k++) {
        const due = addYears(base, 10 * k)
        if (due >= today) {
          deadline = { date: due, type: "Renewal" }
          break
        }
      }
    }
  }

  const applicationId = normalizedIdentifier(e.applicationNumber)
  const registrationId = normalizedIdentifier(e.registrationNumber)
  const key = applicationId
    ? `DKT-${e.office}-A-${applicationId}`
    : `DKT-${e.office}-R-${registrationId}`
  const properties: Record<string, unknown> = {
    Mark: Builder.title(e.mark || `${e.office} filing ${number}`),
    Office: Builder.select(e.office),
    Jurisdiction: Builder.multiSelect(e.office),
    "Serial #": Builder.richText(e.applicationNumber),
    "Reg. #": Builder.richText(e.registrationNumber),
    "IR #": Builder.richText(""),
    Status: Builder.select(bucket),
    "Office Status": Builder.richText(`${st} (counsel docket)`),
    Type: Builder.select("Word"),
    Kind: Builder.multiSelect(...kindsFromClasses(e.classes)),
    Classes: Builder.multiSelect(...e.classes.map((n) => `IC ${n}`)),
    ID: Builder.richText(key),
    Filed: e.filedDate ? Builder.date(e.filedDate) : Builder.richText(""),
    Registered: e.registrationDate
      ? Builder.date(e.registrationDate)
      : Builder.richText(""),
    "Next Deadline": deadline
      ? Builder.date(deadline.date)
      : Builder.richText(""),
    "Deadline Type": deadline
      ? Builder.select(deadline.type)
      : Builder.richText(""),
  }
  if (config.sources.counselDocket)
    properties["Lapse Instructed"] = Builder.checkbox(e.lapseInstructed)
  return { key, properties, fingerprintBasis: properties }
}

// ── The assembly ───────────────────────────────────────────────────────

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function snapshotRecord<T extends JsonObject>(
  snapshots: SourceSnapshots,
  key: string,
  required: boolean
): T {
  const snapshot = snapshots[key]
  if (!snapshot) {
    if (required)
      throw new Error(`[join] enabled source "${key}" has no frozen snapshot`)
    return {} as T
  }
  if (!isObject(snapshot.data))
    throw new Error(`[join] frozen source "${key}" is not an object`)
  return snapshot.data as T
}

function validateUsCases(
  value: Record<string, UsCase>
): Record<string, UsCase> {
  for (const [key, candidate] of Object.entries(value)) {
    if (!isObject(candidate) || candidate.serial !== key) {
      throw new Error(`[join] frozen USPTO case "${key}" is malformed`)
    }
  }
  return value
}

function validateForeignMarks(
  value: Record<string, ForeignMark>
): Record<string, ForeignMark> {
  const cloned: Record<string, ForeignMark> = {}
  for (const [key, candidate] of Object.entries(value)) {
    if (
      !isObject(candidate) ||
      candidate.st13 !== key ||
      typeof candidate.office !== "string" ||
      !Array.isArray(candidate.niceClasses) ||
      !Array.isArray(candidate.designations)
    ) {
      throw new Error(`[join] frozen TMview mark "${key}" is malformed`)
    }
    cloned[key] = {
      ...(candidate as ForeignMark),
      niceClasses: [...candidate.niceClasses] as string[],
      designations: [...candidate.designations] as string[],
    }
  }
  return cloned
}

function validateOverlays(
  value: Record<string, OfficialOverlay>,
  key: string
): Record<string, OfficialOverlay> {
  for (const [number, candidate] of Object.entries(value)) {
    if (!isObject(candidate))
      throw new Error(`[join] frozen ${key} overlay "${number}" is malformed`)
  }
  return value
}

function validateSpend(
  value: Record<string, SpendInfo>
): Record<string, SpendInfo> {
  for (const [serial, candidate] of Object.entries(value)) {
    if (
      !isObject(candidate) ||
      typeof candidate.realized !== "number" ||
      !Number.isFinite(candidate.realized) ||
      typeof candidate.pending !== "number" ||
      !Number.isFinite(candidate.pending)
    ) {
      throw new Error(`[join] frozen spend value "${serial}" is malformed`)
    }
  }
  return value
}

function rowsFromSourceData(opts: {
  docket: DocketCtx
  usCases: Record<string, UsCase>
  foreign: Record<string, ForeignMark>
  spendBySerial: Record<string, SpendInfo>
  today: string
}): PortfolioRow[] {
  const { docket, usCases, foreign, spendBySerial, today } = opts
  const rows: PortfolioRow[] = []
  for (const c of Object.values(usCases).sort((a, b) =>
    a.serial.localeCompare(b.serial)
  )) {
    rows.push(buildUsRow(docket, c, spendBySerial[c.serial] ?? null, today))
  }
  for (const m of Object.values(foreign).sort((a, b) =>
    a.st13.localeCompare(b.st13)
  )) {
    rows.push(buildForeignRow(docket, m, today))
  }

  // Counsel-only rows: entries whose numbers match no registry row in the
  // same office. A known Madrid designation is folded into its WO row only
  // when that WO record explicitly designates the docket entry's office.
  // Lapse instructions remain office-scoped and therefore keep their own
  // docket row instead of incorrectly flagging the whole IR.
  const known = new Set<string>()
  const irDesignations = new Map<string, ReadonlySet<string>>()
  for (const c of Object.values(usCases)) {
    for (const n of [c.serial, c.registrationNumber]) {
      if (n) known.add(`US-${canonicalLegalIdentifier(n)}`)
    }
  }
  for (const m of Object.values(foreign)) {
    for (const n of [m.applicationNumber, m.registrationNumber]) {
      if (n) known.add(`${m.office}-${canonicalLegalIdentifier(n)}`)
    }
    if (m.office === "WO" && m.registrationNumber) {
      const identifier = canonicalLegalIdentifier(m.registrationNumber)
      if (identifier) irDesignations.set(identifier, new Set(m.designations))
    }
  }
  let docketOnly = 0
  for (const e of docket.entries) {
    const nums = [e.applicationNumber, e.registrationNumber]
      .map(canonicalLegalIdentifier)
      .filter(Boolean)
    if (nums.length === 0) continue
    if (nums.some((n) => known.has(`${e.office}-${n}`))) continue
    const isKnownDesignation = nums.some((n) =>
      irDesignations.get(n)?.has(e.office)
    )
    if (isKnownDesignation && !e.lapseInstructed) continue
    rows.push(buildDocketOnlyRow(docket, e, today))
    docketOnly++
  }
  if (docket.entries.length > 0) {
    console.warn(
      `[join] ${docketOnly} counsel-only rows (of ${docket.entries.length} docket entries)`
    )
  }

  const seen = new Set<string>()
  for (const row of rows) {
    if (!row.key || seen.has(row.key)) {
      throw new Error(
        `[join] duplicate or empty portfolio row key "${row.key}"`
      )
    }
    seen.add(row.key)
    // Last Sync is deliberately excluded from the fingerprint: it advances
    // only when another real property change causes the row to re-emit.
    row.fingerprintBasis = { ...row.properties }
    row.properties["Last Sync"] = Builder.date(today)
  }
  rows.sort((a, b) => a.key.localeCompare(b.key))
  return rows
}

// Pure/network-free reconstruction used after acquisition and for every
// continuation page. It clones TMview rows before applying official overlays,
// so neither a current snapshot nor a last-known-good snapshot is mutated.
export function assemblePortfolioRows(opts: {
  snapshots: SourceSnapshots
  nowIso: string
}): PortfolioRow[] {
  const usCases = config.sources.uspto
    ? validateUsCases(
        snapshotRecord<Record<string, UsCase>>(opts.snapshots, "uspto", true)
      )
    : {}
  const foreign = config.sources.tmview
    ? validateForeignMarks(
        snapshotRecord<Record<string, ForeignMark>>(
          opts.snapshots,
          "tmview",
          true
        )
      )
    : {}
  const docketRaw = snapshotRecord<JsonObject>(
    opts.snapshots,
    "counselDocket",
    config.sources.counselDocket
  ) as CounselDocketData
  const docket = config.sources.counselDocket
    ? makeDocketCtx(docketRaw)
    : EMPTY_DOCKET

  const applyOverlays = (sourceKey: string, office: Office) => {
    const overlays = validateOverlays(
      snapshotRecord<Record<string, OfficialOverlay>>(
        opts.snapshots,
        sourceKey,
        false
      ),
      sourceKey
    )
    for (const mark of Object.values(foreign)) {
      if (mark.office !== office || !mark.applicationNumber) continue
      const overlay = overlays[mark.applicationNumber]
      if (!overlay) continue
      mark.status = overlay.status ?? mark.status
      mark.statusDate = overlay.statusDate ?? mark.statusDate
      mark.applicationDate = overlay.applicationDate ?? mark.applicationDate
      mark.registrationDate = overlay.registrationDate ?? mark.registrationDate
      mark.expirationDate = overlay.renewalDue ?? mark.expirationDate
    }
  }
  if (config.sources.ipAustralia) applyOverlays("ipAustralia", "AU")
  if (config.sources.euipo) applyOverlays("euipo", "EU")

  const spendBySerial = config.sources.spend
    ? validateSpend(
        snapshotRecord<Record<string, SpendInfo>>(
          opts.snapshots,
          "spend",
          false
        )
      )
    : {}
  return rowsFromSourceData({
    docket,
    usCases,
    foreign,
    spendBySerial,
    today: opts.nowIso.slice(0, 10),
  })
}

export async function buildPortfolioRows(opts: {
  mode: SyncMode
  nowIso: string
  prevSnapshots?: SourceSnapshots
  prevHealth?: SourceHealth
  pacers: Pacers
}): Promise<{
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
  const prev = opts.prevSnapshots ?? {}

  // 0. Counsel docket reports. No staleness cap: a docket report stays the
  // truth until the next one arrives.
  const inboxPage = config.sources.counselDocket ? docketInboxPageId() : null
  if (config.sources.counselDocket) {
    await runner.run<CounselDocketData>(
      "counselDocket",
      () => {
        if (!inboxPage)
          throw new Error(
            "sources.counselDocket is enabled but DOCKET_INBOX_PAGE_ID is not set or invalid"
          )
        return fetchCounselDocket(
          inboxPage,
          (prev.counselDocket?.data ?? {}) as CounselDocketData,
          {
            ownerNames: config.ownerNames,
            clientNumber: config.docketClientNumber,
            parserVersion: DERIVATION_VERSION,
          }
        )
      },
      { capMs: Number.POSITIVE_INFINITY }
    )
  }

  // 1. USPTO: US enumeration + case data (keyless; TSDR overlay when keyed).
  let usCases: Record<string, UsCase> = {}
  if (config.sources.uspto) {
    usCases = await runner.run<Record<string, UsCase>>(
      "uspto",
      () =>
        fetchUsCases(config.ownerNames, {
          search: opts.pacers.tmsearch,
          tsdr: opts.pacers.tsdr,
        }),
      { capMs: WAF_STALENESS_CAP_MS }
    )
  }

  // 2. TMview: everything else. The wordmark list doubles as the fallback
  // query set when applicant search returns nothing.
  let foreign: Record<string, ForeignMark> = {}
  if (config.sources.tmview) {
    const wordmarks = Array.from(
      new Set(
        Object.values(usCases)
          .map((c) => c.wordmark)
          .filter((w): w is string => Boolean(w) && w!.length >= 4)
      )
    ).sort()
    const prevForeign = (prev.tmview?.data ?? {}) as Record<string, ForeignMark>
    foreign = await runner.run<Record<string, ForeignMark>>(
      "tmview",
      () =>
        fetchForeignMarks(
          config.ownerNames,
          wordmarks,
          prevForeign,
          opts.pacers.tmview
        ),
      { capMs: WAF_STALENESS_CAP_MS }
    )
  }

  // 3. Official overlays — enrichment only, never cycle-fatal (a strict
  // backfill must be runnable while an office API is down; the affected
  // rows simply carry TMview's values until it recovers).
  if (config.sources.ipAustralia) {
    try {
      const nums = Object.values(foreign)
        .filter((m) => m.office === "AU" && m.applicationNumber)
        .map((m) => m.applicationNumber as string)
        .sort()
      await runner.run<Record<string, OfficialOverlay>>("ipAustralia", () =>
        fetchIpaOverlays(nums, opts.pacers.official)
      )
    } catch (err) {
      console.warn(
        `[join] IP Australia overlay unavailable this cycle: ${err instanceof Error ? err.message : err}`
      )
    }
  }
  if (config.sources.euipo) {
    try {
      const nums = Object.values(foreign)
        .filter((m) => m.office === "EU" && m.applicationNumber)
        .map((m) => m.applicationNumber as string)
        .sort()
      await runner.run<Record<string, OfficialOverlay>>("euipo", () =>
        fetchEuipoOverlays(nums, opts.pacers.official)
      )
    } catch (err) {
      console.warn(
        `[join] EUIPO overlay unavailable this cycle: ${err instanceof Error ? err.message : err}`
      )
    }
  }

  // 4. Spend — enrichment via your adapter; never cycle-fatal.
  if (config.sources.spend) {
    try {
      await runner.run<Record<string, SpendInfo>>("spend", () =>
        spendAdapter.lookup(
          Object.values(usCases).map((c) => ({
            serial: c.serial,
            wordmark: c.wordmark,
          }))
        )
      )
    } catch (err) {
      console.warn(
        `[join] spend adapter unavailable this cycle: ${err instanceof Error ? err.message : err}`
      )
    }
  }

  return {
    rows: assemblePortfolioRows({
      snapshots: runner.snapshots,
      nowIso: opts.nowIso,
    }),
    snapshots: runner.snapshots,
    sourceHealth: runner.sourceHealth,
  }
}
