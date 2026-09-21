// ──────────────────────────────────────────────────────────────────────
// USPTO Open Data Portal adapter (live)
// ──────────────────────────────────────────────────────────────────────
//
// Discovers US applications by applicant name and normalizes them. The
// search payload carries everything mapped here, so no per-application
// requests are required.

import { fetchWithTimeout } from "../engine/http.js"
import type { PatentRecord } from "./types.js"

const ODP_URL = "https://api.uspto.gov/api/v1/patent/applications/search"
const PAGE_SIZE = 100
// Shared across every applicant alias in one acquisition. At the configured
// 60/min pacer this leaves ample time for EPO and row assembly before the
// worker execution budget. A budget failure is source-fatal and therefore
// falls back to the last-known-good snapshot in resilient mode.
const MAX_REQUESTS_PER_ACQUISITION = 120
const REQUEST_TIMEOUT_RESERVE_MS = 31_000

type AppMeta = {
  inventionTitle?: unknown
  filingDate?: unknown
  applicationTypeLabelName?: unknown
  applicationStatusDescriptionText?: unknown
  applicationStatusDate?: unknown
  nationalStageIndicator?: unknown
  patentNumber?: unknown
  grantDate?: unknown
  earliestPublicationNumber?: unknown
  publicationNumber?: unknown
  publicationNumberText?: unknown
  pgPublicationNumber?: unknown
}
type ContinuityEntry = {
  claimParentageTypeCode?: unknown
  childApplicationNumberText?: unknown
  parentApplicationFilingDate?: unknown
  parentApplicationNumberText?: unknown
}
type PgpubMeta = {
  publicationNumber?: unknown
  publicationNumberText?: unknown
  pgPublicationNumber?: unknown
}
type OdpRecord = {
  applicationNumberText?: unknown
  applicationMetaData?: unknown
  parentContinuityBag?: unknown
  pgpubDocumentMetaData?: unknown
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function isValidDateParts(year: number, month: number, day: number): boolean {
  const days = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ]
  return (
    year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
  )
}

function normalizedDate(value: unknown, field: string): string | null {
  if (value == null || value === "") return null
  if (typeof value !== "string")
    throw new Error(`USPTO ODP ${field}: expected a date string`)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match)
    throw new Error(`USPTO ODP ${field}: invalid date ${JSON.stringify(value)}`)
  const [, yearText, monthText, dayText] = match
  if (!isValidDateParts(Number(yearText), Number(monthText), Number(dayText)))
    throw new Error(`USPTO ODP ${field}: invalid calendar date ${value}`)
  return `${yearText}-${monthText}-${dayText}`
}

function optionalString(value: unknown, field: string): string | null {
  if (value == null || value === "") return null
  if (typeof value !== "string")
    throw new Error(`USPTO ODP ${field}: expected a string`)
  const normalized = value.trim()
  return normalized || null
}

function optionalIndicator(value: unknown, field: string): boolean | null {
  if (value == null || value === "") return null
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    const normalized = value.trim().toLocaleLowerCase("en-US")
    if (normalized === "true" || normalized === "y") return true
    if (normalized === "false" || normalized === "n") return false
  }
  throw new Error(`USPTO ODP ${field}: expected a boolean indicator`)
}

function canonicalApplicationNumber(value: unknown, field: string): string {
  if (typeof value !== "string")
    throw new Error(`USPTO ODP ${field}: expected a string`)
  const trimmed = value.trim().toUpperCase()
  const pct =
    /^PCT[\/\s-]?([A-Z]{2})[\/\s-]?(\d{2}|\d{4})[\/\s-]?(\d{1,6})$/.exec(
      trimmed
    )
  if (pct) {
    const rawYear = pct[2]
    let year: string
    if (rawYear.length === 4) {
      year = rawYear
    } else {
      const shortYear = Number(rawYear)
      if (shortYear >= 78) year = `19${rawYear}`
      else if (shortYear <= 3) year = `20${rawYear}`
      else {
        throw new Error(
          `USPTO ODP ${field}: ambiguous abbreviated PCT year ${JSON.stringify(rawYear)}`
        )
      }
    }
    if (Number(year) < 1978)
      throw new Error(
        `USPTO ODP ${field}: invalid PCT year ${JSON.stringify(year)}`
      )
    const serial = pct[3].padStart(6, "0")
    if (Number(serial) === 0)
      throw new Error(`USPTO ODP ${field}: invalid zero PCT serial`)
    return `PCT/${pct[1]}${year}/${serial}`
  }
  const withoutCountry = trimmed.replace(/^US\s*/i, "")
  const compact = withoutCountry.replace(/[\s,/\-]/g, "")
  if (!/^\d{8}$/.test(compact))
    throw new Error(
      `USPTO ODP ${field}: invalid US application number ${JSON.stringify(value)}`
    )
  return compact
}

function applicationMeta(record: OdpRecord): AppMeta {
  if (record.applicationMetaData == null) return {}
  if (!isObject(record.applicationMetaData))
    throw new Error("USPTO ODP applicationMetaData: expected an object")
  return record.applicationMetaData as AppMeta
}

function continuityEntries(record: OdpRecord): ContinuityEntry[] {
  if (record.parentContinuityBag == null) return []
  if (!Array.isArray(record.parentContinuityBag))
    throw new Error("USPTO ODP parentContinuityBag: expected an array")
  if (!record.parentContinuityBag.every(isObject))
    throw new Error("USPTO ODP parentContinuityBag: malformed entry")
  return record.parentContinuityBag as ContinuityEntry[]
}

function normalizedParentCode(entry: ContinuityEntry): string | null {
  const code = optionalString(
    entry.claimParentageTypeCode,
    "claimParentageTypeCode"
  )
  return code?.toUpperCase() ?? null
}

async function responseExcerpt(response: Response): Promise<string> {
  return (await response.text().catch(() => ""))
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 200)
}

type OdpSearchResult = { records: OdpRecord[]; total: number }

function responseTotal(value: unknown, field: string): number | null {
  if (value === undefined) return null
  const total =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN
  if (!Number.isSafeInteger(total) || total < 0)
    throw new Error(`USPTO ODP malformed ${field}`)
  return total
}

async function odpSearch(
  body: Record<string, unknown>
): Promise<OdpSearchResult> {
  const apiKey = process.env.USPTO_API_KEY
  if (!apiKey) throw new Error("USPTO_API_KEY env var is not set")
  const response = await fetchWithTimeout(ODP_URL, {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!response.ok)
    throw new Error(
      `USPTO ODP ${response.status}: ${await responseExcerpt(response)}`
    )
  const text = await response.text().catch(() => "")
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const detail = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, 200)
    throw new Error(
      `USPTO ODP malformed JSON (${detail}); response=${text
        .replace(/[\r\n\t]+/g, " ")
        .slice(0, 200)}`
    )
  }
  if (!isObject(parsed) || !Array.isArray(parsed.patentFileWrapperDataBag))
    throw new Error("USPTO ODP malformed response envelope")
  if (!parsed.patentFileWrapperDataBag.every(isObject))
    throw new Error("USPTO ODP malformed patentFileWrapperDataBag entry")
  // Official ODP search responses use `count`; `totalNumFound` is accepted
  // for compatibility with alternate/current client models.
  const compatibleTotal = responseTotal(parsed.totalNumFound, "totalNumFound")
  const officialTotal = responseTotal(parsed.count, "count")
  if (compatibleTotal == null && officialTotal == null)
    throw new Error("USPTO ODP malformed or missing total result count")
  if (
    compatibleTotal != null &&
    officialTotal != null &&
    compatibleTotal !== officialTotal
  )
    throw new Error(
      `USPTO ODP conflicting result totals (${compatibleTotal} vs ${officialTotal})`
    )
  return {
    records: parsed.patentFileWrapperDataBag as OdpRecord[],
    total: officialTotal ?? compatibleTotal!,
  }
}

const TYPE_BY_PARENT_CODE: Readonly<Record<string, string>> = {
  REI: "Reissue",
  REX: "Reexamination",
  SER: "Supplemental Examination",
  NST: "National Stage Entry",
  DIV: "Divisional",
  CIP: "Continuation-in-Part",
  CON: "Continuation",
  SUB: "Substitute",
}

function directContinuityType(
  record: OdpRecord,
  applicationNumber: string
): string | null {
  const entries = continuityEntries(record)
  const hasAnyChildIdentifier = entries.some(
    (entry) => entry.childApplicationNumberText != null
  )
  const codes = new Set<string>()
  for (const entry of entries) {
    const code = normalizedParentCode(entry)
    if (!code || !TYPE_BY_PARENT_CODE[code]) continue
    if (hasAnyChildIdentifier) {
      if (entry.childApplicationNumberText == null) continue
      const child = canonicalApplicationNumber(
        entry.childApplicationNumberText,
        "childApplicationNumberText"
      )
      if (child !== applicationNumber) continue
    }
    codes.add(code)
  }
  if (codes.size > 1) {
    throw new Error(
      `USPTO ODP ${applicationNumber}: conflicting direct continuity types ${[...codes].sort().join(", ")}`
    )
  }
  const code = [...codes][0]
  return code ? TYPE_BY_PARENT_CODE[code] : null
}

function usType(record: OdpRecord, applicationNumber: string): string {
  const metadata = applicationMeta(record)
  const continuityType = directContinuityType(record, applicationNumber)
  const label = optionalString(
    metadata.applicationTypeLabelName,
    "applicationTypeLabelName"
  )?.toLocaleLowerCase("en-US")
  // Reissue and post-grant proceedings must win over a Design/Plant label;
  // otherwise they would incorrectly receive a fresh statutory term.
  if (
    continuityType === "Reissue" ||
    continuityType === "Reexamination" ||
    continuityType === "Supplemental Examination"
  )
    return continuityType
  if (label === "reissue") return "Reissue"
  if (label === "reexamination") return "Reexamination"
  if (label === "supplemental examination") return "Supplemental Examination"
  if (label === "provisional") return "Provisional"
  if (label === "pct") return "PCT"
  if (label === "design") return "Design"
  if (label === "plant") return "Plant"
  if (applicationNumber.startsWith("PCT/")) return "PCT"
  // A direct child relationship is more specific than the broad metadata
  // indicator. For example, a continuation of a national-stage case is a
  // continuation even when the surrounding chain carries national-stage data.
  if (continuityType) return continuityType
  if (
    optionalIndicator(
      metadata.nationalStageIndicator,
      "nationalStageIndicator"
    ) === true
  )
    return "National Stage Entry"
  return "Original"
}

const TERM_PARENT_CODES = new Set(["CON", "CIP", "DIV", "NST"])

function usEstExpiry(
  record: OdpRecord,
  type: string,
  filingDate: string | null,
  grantDate: string | null
): string | null {
  if (
    !grantDate ||
    type === "Provisional" ||
    type === "PCT" ||
    type === "Reissue" ||
    type === "Reexamination" ||
    type === "Supplemental Examination"
  )
    return null
  if (type === "Design") {
    if (!filingDate) return null
    return addYears(grantDate, filingDate >= "2015-05-13" ? 15 : 14)
  }

  let base = filingDate
  for (const parent of continuityEntries(record)) {
    const code = normalizedParentCode(parent)
    if (!code || !TERM_PARENT_CODES.has(code)) continue
    const parentDate = normalizedDate(
      parent.parentApplicationFilingDate,
      "parentApplicationFilingDate"
    )
    // A CON/CIP/DIV/NST parent can control the statutory baseline. Falling
    // back to the child's filing date when that parent date is absent would
    // overstate the estimate, so an incomplete term chain has no estimate.
    if (!parentDate) return null
    if (!base || parentDate < base) base = parentDate
  }
  if (!base) return null

  const twentyYearsFromEffectiveFiling = addYears(base, 20)
  if (!twentyYearsFromEffectiveFiling) return null
  if (filingDate && filingDate < "1995-06-08") {
    const seventeenYearsFromGrant = addYears(grantDate, 17)
    if (!seventeenYearsFromGrant) return null
    return twentyYearsFromEffectiveFiling > seventeenYearsFromGrant
      ? twentyYearsFromEffectiveFiling
      : seventeenYearsFromGrant
  }
  return twentyYearsFromEffectiveFiling
}

function publicationNumber(
  record: OdpRecord,
  metadata: AppMeta
): string | null {
  const candidates: unknown[] = [
    metadata.earliestPublicationNumber,
    metadata.publicationNumber,
    metadata.publicationNumberText,
    metadata.pgPublicationNumber,
  ]
  const pgpubEntries = Array.isArray(record.pgpubDocumentMetaData)
    ? record.pgpubDocumentMetaData
    : record.pgpubDocumentMetaData == null
      ? []
      : [record.pgpubDocumentMetaData]
  for (const entry of pgpubEntries) {
    if (!isObject(entry))
      throw new Error("USPTO ODP pgpubDocumentMetaData: malformed entry")
    const pgpub = entry as PgpubMeta
    candidates.push(
      pgpub.publicationNumber,
      pgpub.publicationNumberText,
      pgpub.pgPublicationNumber
    )
  }
  for (const candidate of candidates) {
    const value = optionalString(candidate, "publicationNumber")
    if (value) return value
  }
  return null
}

function normalizedParents(
  record: OdpRecord,
  applicationNumber: string
): string[] {
  const parents = new Set<string>()
  for (const entry of continuityEntries(record)) {
    if (entry.parentApplicationNumberText == null) continue
    const parent = canonicalApplicationNumber(
      entry.parentApplicationNumberText,
      "parentApplicationNumberText"
    )
    if (parent !== applicationNumber) parents.add(parent)
  }
  return [...parents].sort()
}

function toRecord(record: OdpRecord): PatentRecord {
  const applicationNumber = canonicalApplicationNumber(
    record.applicationNumberText,
    "applicationNumberText"
  )
  const metadata = applicationMeta(record)
  const filingDate = normalizedDate(metadata.filingDate, "filingDate")
  const statusDate = normalizedDate(
    metadata.applicationStatusDate,
    "applicationStatusDate"
  )
  const grantDate = normalizedDate(metadata.grantDate, "grantDate")
  const type = usType(record, applicationNumber)
  const title = optionalString(metadata.inventionTitle, "inventionTitle")

  return {
    source: "USPTO",
    jurisdiction: "US",
    applicationNumber,
    title: title ?? applicationNumber,
    type,
    filingDate,
    status: optionalString(
      metadata.applicationStatusDescriptionText,
      "applicationStatusDescriptionText"
    ),
    statusDate,
    grantDate,
    patentNumber: optionalString(metadata.patentNumber, "patentNumber"),
    publicationNumber: publicationNumber(record, metadata),
    // Baseline statutory term only; this does not imply enforceability.
    // PTA, PTE, terminal disclaimers, and other legal events are not in the
    // mapped payload and therefore are not represented in this estimate.
    // Reissue/reexamination/supplemental-examination rows intentionally have
    // no estimate because they do not receive a fresh patent term.
    estExpiry: usEstExpiry(record, type, filingDate, grantDate),
    parents: normalizedParents(record, applicationNumber),
  }
}

function normalizedApplicants(applicants: string[]): string[] {
  const aliases = new Map<string, string>()
  for (const applicant of applicants) {
    const normalized = applicant
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .replace(/\s+/g, " ")
    if (!normalized) continue
    const key = normalized.toLocaleLowerCase("en-US")
    if (!aliases.has(key)) aliases.set(key, normalized)
  }
  if (aliases.size === 0)
    throw new Error("USPTO discovery requires at least one non-empty applicant")
  return [...aliases.values()]
}

function escapedQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function sameRecord(left: PatentRecord, right: PatentRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

// Fetch all US applications for the given applicant name(s). `pace` is the
// pacer's wait() — called before every request.
export async function fetchUsptoRecords(
  applicants: string[],
  pace: () => Promise<void>,
  deadlineMs = Number.POSITIVE_INFINITY
): Promise<PatentRecord[]> {
  const byApplication = new Map<string, PatentRecord>()
  let requestCount = 0
  for (const applicant of normalizedApplicants(applicants)) {
    let offset = 0
    let expectedTotal: number | null = null
    const seenForApplicant = new Set<string>()
    const pageSignatures = new Set<string>()
    while (expectedTotal == null || seenForApplicant.size < expectedTotal) {
      if (++requestCount > MAX_REQUESTS_PER_ACQUISITION)
        throw new Error(
          `USPTO ODP acquisition exceeded the shared ${MAX_REQUESTS_PER_ACQUISITION}-request budget; narrow the applicant aliases`
        )
      if (Date.now() + REQUEST_TIMEOUT_RESERVE_MS >= deadlineMs)
        throw new Error(
          "USPTO ODP acquisition lacks enough shared execution time for another request; narrow the applicant aliases"
        )
      await pace()
      if (Date.now() + REQUEST_TIMEOUT_RESERVE_MS >= deadlineMs)
        throw new Error(
          "USPTO ODP acquisition lacks enough shared execution time after pacing; narrow the applicant aliases"
        )
      const result = await odpSearch({
        q: `applicationMetaData.firstApplicantName:"${escapedQueryValue(applicant)}"`,
        pagination: { offset, limit: PAGE_SIZE },
        sort: [{ field: "applicationNumberText", order: "Asc" }],
      })
      const page = result.records
      if (expectedTotal == null) expectedTotal = result.total
      else if (result.total !== expectedTotal)
        throw new Error(
          `USPTO ODP result count changed from ${expectedTotal} to ${result.total} while paging ${applicant}`
        )
      if (page.length > PAGE_SIZE)
        throw new Error("USPTO ODP response exceeded the requested page size")
      if (expectedTotal === 0) {
        if (page.length !== 0)
          throw new Error("USPTO ODP zero total accompanied by result records")
        break
      }
      if (page.length === 0)
        throw new Error(
          `USPTO ODP empty page at offset ${offset} before ${expectedTotal} results were exhausted for ${applicant}`
        )
      const records = page.map(toRecord)
      const applicationNumbers = records.map(
        (record) => record.applicationNumber
      )
      const signature = applicationNumbers.join("|")
      if (page.length > 0 && pageSignatures.has(signature))
        throw new Error(
          `USPTO ODP repeated page at offset ${offset}; pagination made no progress`
        )
      pageSignatures.add(signature)
      for (const record of records) {
        if (seenForApplicant.has(record.applicationNumber))
          throw new Error(
            `USPTO ODP duplicate application ${record.applicationNumber} across pages for ${applicant}`
          )
        seenForApplicant.add(record.applicationNumber)
        const previous = byApplication.get(record.applicationNumber)
        if (!previous) byApplication.set(record.applicationNumber, record)
        else if (!sameRecord(previous, record))
          throw new Error(
            `USPTO application ${record.applicationNumber} returned conflicting data across applicant aliases`
          )
      }
      offset += page.length
      if (seenForApplicant.size > expectedTotal)
        throw new Error(
          `USPTO ODP received more than the reported ${expectedTotal} results for ${applicant}`
        )
    }
    if (expectedTotal == null || seenForApplicant.size !== expectedTotal)
      throw new Error(
        `USPTO ODP received ${seenForApplicant.size} of ${expectedTotal ?? "unknown"} reported results for ${applicant}`
      )
  }
  return [...byApplication.values()]
}

// Cheapest call that proves reachability + auth (a no-match returns an
// explicit empty bag, not an error). Used by healthSync.
export async function probeUspto(pace: () => Promise<void>): Promise<void> {
  await pace()
  const result = await odpSearch({
    q: 'applicationMetaData.firstApplicantName:"healthprobe"',
    pagination: { offset: 0, limit: 1 },
  })
  if (result.records.length > 1)
    throw new Error("USPTO ODP health response exceeded requested page size")
}

// YYYY-MM-DD + n years (Feb 29 clamps to Feb 28).
function addYears(date: string, years: number): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return null
  const [, yearText, monthText, dayText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  if (!isValidDateParts(year, month, day)) return null
  const targetYear = year + years
  if (month === 2 && day === 29 && !isLeapYear(targetYear))
    return `${String(targetYear).padStart(4, "0")}-02-28`
  return `${String(targetYear).padStart(4, "0")}-${monthText}-${dayText}`
}
