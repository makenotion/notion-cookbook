// ──────────────────────────────────────────────────────────────────────
// USPTO Open Data Portal adapter (live)
// ──────────────────────────────────────────────────────────────────────
//
// Discovers US applications by applicant name and normalizes them. The
// search payload carries everything we map here — no per-application calls.
// EXTEND: the same payload also exposes PTA, terminal disclaimers, Track
// One events, group art unit, and pre-grant publication numbers; add fields
// to PatentRecord and map them in toRecord() as you need them.

import { fetchWithTimeout } from "../engine/http.js"
import type { PatentRecord } from "./types.js"

const ODP_URL = "https://api.uspto.gov/api/v1/patent/applications/search"
const PAGE_SIZE = 25

type AppMeta = {
  inventionTitle?: string
  filingDate?: string
  applicationTypeLabelName?: string
  applicationStatusDescriptionText?: string
  applicationStatusDate?: string
  patentNumber?: string
  grantDate?: string
}
type ContinuityEntry = {
  claimParentageTypeCode?: string
  parentApplicationFilingDate?: string
  parentApplicationNumberText?: string
}
type OdpRecord = {
  applicationNumberText?: string
  applicationMetaData?: AppMeta
  parentContinuityBag?: ContinuityEntry[]
}
type OdpResponse = { patentFileWrapperDataBag?: OdpRecord[] }

async function odpSearch(body: Record<string, unknown>): Promise<OdpRecord[]> {
  const apiKey = process.env.USPTO_API_KEY
  if (!apiKey) throw new Error("USPTO_API_KEY env var is not set")
  const res = await fetchWithTimeout(ODP_URL, {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (res.status === 404) return []
  if (!res.ok) {
    throw new Error(
      `USPTO ODP ${res.status}: ${await res.text().catch(() => "")}`
    )
  }
  return ((await res.json()) as OdpResponse).patentFileWrapperDataBag ?? []
}

// US patent term: 20 years from the earliest non-provisional effective US
// filing date — only meaningful once GRANTED (a pending case may never
// grant). Provisional/PCT internationals never mature. PTA (not mapped in
// this starter) would extend it.
const TERM_PARENT_CODES = new Set(["CON", "CIP", "DIV", "NST", "REI"])
function usEstExpiry(rec: OdpRecord, type: string): string | null {
  const md = rec.applicationMetaData ?? {}
  if (!md.grantDate) return null
  if (type === "Provisional" || type === "PCT") return null
  let base = md.filingDate ?? null
  for (const p of rec.parentContinuityBag ?? []) {
    if (!p.parentApplicationFilingDate) continue
    if (!TERM_PARENT_CODES.has(p.claimParentageTypeCode ?? "")) continue
    if (!base || p.parentApplicationFilingDate < base)
      base = p.parentApplicationFilingDate
  }
  return base ? addYears(base, 20) : null
}

function usType(rec: OdpRecord): string {
  const label = rec.applicationMetaData?.applicationTypeLabelName
  if (label === "Provisional") return "Provisional"
  if (label === "PCT") return "PCT"
  if (label === "Design") return "Design"
  for (const p of rec.parentContinuityBag ?? []) {
    switch (p.claimParentageTypeCode) {
      case "CON":
        return "Continuation"
      case "CIP":
        return "Continuation-in-Part"
      case "DIV":
        return "Divisional"
      case "NST":
        return "National Stage Entry"
      case "REI":
        return "Reissue"
    }
  }
  return "Original"
}

function toRecord(rec: OdpRecord): PatentRecord | null {
  const md = rec.applicationMetaData ?? {}
  const appNo = rec.applicationNumberText
  if (!appNo) return null
  const type = usType(rec)
  return {
    source: "USPTO",
    jurisdiction: "US",
    applicationNumber: appNo,
    title: md.inventionTitle ?? appNo,
    type,
    filingDate: md.filingDate ?? null,
    status: md.applicationStatusDescriptionText ?? null,
    statusDate: md.applicationStatusDate ?? null,
    grantDate: md.grantDate ?? null,
    patentNumber: md.patentNumber ?? null,
    publicationNumber: null, // EXTEND: from pgpubDocumentMetaData
    estExpiry: usEstExpiry(rec, type),
    parents: (rec.parentContinuityBag ?? [])
      .map((p) => p.parentApplicationNumberText)
      .filter((n): n is string => Boolean(n)),
  }
}

// Fetch all US applications for the given applicant name(s). `pace` is the
// pacer's wait() — called before every request.
export async function fetchUsptoRecords(
  applicants: string[],
  pace: () => Promise<void>
): Promise<PatentRecord[]> {
  const out: PatentRecord[] = []
  for (const applicant of applicants) {
    let offset = 0
    while (true) {
      await pace()
      const page = await odpSearch({
        q: `applicationMetaData.firstApplicantName:"${applicant}"`,
        pagination: { offset, limit: PAGE_SIZE },
        sort: [{ field: "applicationNumberText", order: "Asc" }],
      })
      for (const r of page) {
        const rec = toRecord(r)
        if (rec) out.push(rec)
      }
      if (page.length < PAGE_SIZE) break
      offset += page.length
    }
  }
  return out
}

// Cheapest call that proves reachability + auth (a no-match returns [],
// not an error). Used by healthSync.
export async function probeUspto(pace: () => Promise<void>): Promise<void> {
  await pace()
  await odpSearch({
    q: 'applicationMetaData.firstApplicantName:"healthprobe"',
    pagination: { offset: 0, limit: 1 },
  })
}

// YYYY-MM-DD + n years (Feb 29 clamps to Feb 28).
function addYears(date: string, years: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date)
  if (!m) return null
  const y = Number(m[1]) + years
  if (m[2] === "02" && m[3] === "29") return `${y}-02-28`
  return `${y}-${m[2]}-${m[3]}`
}
