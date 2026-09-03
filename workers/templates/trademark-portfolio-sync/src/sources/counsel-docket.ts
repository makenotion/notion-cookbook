// ──────────────────────────────────────────────────────────────────────
// Counsel docket adapter (live, config-gated) — the drag-and-drop source
// ──────────────────────────────────────────────────────────────────────
//
// Outside counsel emails two .xlsx reports; nobody wants to babysit an
// ingest script. So: someone drags the attachments onto a Notion "Docket
// Inbox" page, and this adapter ingests the newest of each kind every
// cycle — no redeploy, no cron, no CLI. The two kinds:
//
//   • "Properties Report" — every right in the portfolio, one row per
//     filing, all countries → DocketEntry[]. Feeds counsel-only rows
//     (direct national filings no registry API enumerates) and the
//     Lapse Instructed flag.
//   • "Docket Report" — upcoming statutory actions with counsel's exact
//     due dates → DocketAction[]. Feeds Next Deadline overrides —
//     counsel's docketed date beats any computed estimate.
//
// Both parsers validate hard enough that a wrong or truncated file FAILS
// the source — the resilience layer then keeps serving the previous good
// parse — instead of quietly rewriting the portfolio. That design has a
// corollary: a bad report is absorbed silently, so probeCounselDocket
// (bottom of this file) dry-runs the whole path to make bad reports
// visible in sync health.
//
// CUSTOMIZE: the column names, filename patterns, and reference scheme
// below match a real docketing-system export; your firm's will differ in
// the details. Each customization point is marked.

import { fetchWithTimeout } from "../engine/http.js"
import { parseIsoDay } from "../engine/date.js"
import { parseXlsxSheet } from "../engine/xlsx.js"
import type { CounselDocketData, DocketAction, DocketEntry } from "./types.js"

const NOTION_VERSION = "2022-06-28"

// ── Inbox location ─────────────────────────────────────────────────────

// DOCKET_INBOX_PAGE_ID (env, read at call time so pushing it needs no
// redeploy) points at the Notion page counsel reports get dropped on.
// Accepts a bare ID, dashed ID, or the full page URL. The integration
// behind NOTION_API_TOKEN must have access to that page (page ›
// Connections) — a page move can silently drop that access, which the
// health probe surfaces.
export function docketInboxPageId(): string | null {
  const m = /[0-9a-f]{32}/i.exec(
    (process.env.DOCKET_INBOX_PAGE_ID ?? "").replace(/-/g, "")
  )
  return m ? m[0] : null
}

// ── Inbox listing ──────────────────────────────────────────────────────

type InboxFile = {
  blockId: string
  name: string
  url: string
  lastEdited: string
}

async function fetchInboxFiles(pageId: string): Promise<InboxFile[]> {
  const token = process.env.NOTION_API_TOKEN
  if (!token) throw new Error("NOTION_API_TOKEN env var is not set")
  const files: InboxFile[] = []
  let cursor: string | null = null
  const seenCursors = new Set<string>()
  // Ten pages protects the execute budget. Reaching that ceiling is an
  // explicit failure, never a partial "success" that can elect an old report
  // and poison the LKG snapshot.
  const MAX_INBOX_PAGES = 10
  for (let page = 0; page < MAX_INBOX_PAGES; page++) {
    const url =
      `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100` +
      (cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : "")
    const res = await fetchWithTimeout(url, {
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
      },
    })
    if (!res.ok) {
      throw new Error(
        `inbox children list HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`
      )
    }
    const body = (await res.json()) as {
      object?: string
      code?: string
      message?: string
      results?: Array<{
        id: string
        type?: string
        last_edited_time?: string
        file?: {
          name?: string
          file?: { url?: string }
          external?: { url?: string }
        }
      }>
      has_more?: boolean
      next_cursor?: string | null
    }
    // Some environments answer HTTP 200 with an {"object":"error"} body.
    // Treating that as an empty inbox would misdiagnose an auth/permission
    // failure as "no reports attached" (and could silently truncate a
    // paginated listing).
    if (body.object === "error") {
      throw new Error(
        `inbox children list API error: ${body.code ?? "unknown"}: ${body.message ?? ""}`
      )
    }
    if (!Array.isArray(body.results)) {
      throw new Error("inbox children list returned no results array")
    }
    for (const b of body.results) {
      if (b.type !== "file") continue
      const fileUrl = b.file?.file?.url ?? b.file?.external?.url
      const name = b.file?.name ?? ""
      if (!fileUrl || !name) continue
      files.push({
        blockId: b.id,
        name,
        url: fileUrl,
        lastEdited: b.last_edited_time ?? "",
      })
    }
    if (!body.has_more) return files
    if (!body.next_cursor) {
      throw new Error("inbox children list has_more=true without a next_cursor")
    }
    if (seenCursors.has(body.next_cursor)) {
      throw new Error("inbox children list repeated a pagination cursor")
    }
    seenCursors.add(body.next_cursor)
    cursor = body.next_cursor
  }
  throw new Error(
    `inbox children list exceeded ${MAX_INBOX_PAGES} pages; refusing a partial listing`
  )
}

// Notion-hosted file URLs are short-lived S3 signatures, minted fresh by
// every children listing — download promptly, with a PLAIN fetch (no auth
// header; S3 rejects requests that carry one alongside the signature).
async function downloadInboxFile(f: InboxFile): Promise<ArrayBuffer> {
  const res = await fetchWithTimeout(f.url)
  if (!res.ok) {
    throw new Error(`download of "${f.name}" failed: HTTP ${res.status}`)
  }
  return res.arrayBuffer()
}

// ── Report classification ──────────────────────────────────────────────

// Classify an inbox attachment by filename, e.g.
// "ACME CORP - Docket Report 07172026.xlsx" / "… Properties Report ….xlsx".
// CUSTOMIZE: widen these patterns to your firm's naming (keep them
// mutually exclusive; unclassifiable .xlsx files warn every cycle and
// fail the health probe).
export function classifyReportName(
  name: string
): "properties" | "docket" | null {
  if (!/\.xlsx$/i.test(name)) return null
  // Firms' export naming drifts between runs ("Docket Report 07172026",
  // "Docket_Report_-_07272026", "DOCKETREPORT", bare "DOCKET"…), so
  // matching ignores case and separators entirely: strip to letters+digits
  // and keyword-search. "propert" wins over "docket" — a combined title
  // like "Docket - Properties Report" is the full-rights listing, not the
  // deadline report.
  const bare = name.toLowerCase().replace(/[^a-z0-9]/g, "")
  if (bare.includes("propert")) return "properties"
  if (bare.includes("docket")) return "docket"
  return null
}

// Counsel filenames embed the report date as MMDDYYYY ("… 07172026.xlsx").
// That token — not the block's last_edited_time — is the primary "newest"
// signal: Notion bumps last_edited_time on ANY touch of the block (a
// caption edit, dragging it to a new position) and truncates it to the
// minute, so edit times can quietly re-elect an OLD report as latest.
// Files without the token fall back to edit time alone.
export function reportDateFromName(name: string): string | null {
  const tail = name.replace(/\.xlsx$/i, "").trim()
  // MMDDYYYY, optionally separated: "07272026", "07-27-2026", "07.27.2026"
  let m = /(\d{2})[-._ ]?(\d{2})[-._ ]?((?:19|20)\d{2})$/.exec(tail)
  if (
    m &&
    Number(m[1]) >= 1 &&
    Number(m[1]) <= 12 &&
    Number(m[2]) >= 1 &&
    Number(m[2]) <= 31
  ) {
    return parseIsoDay(`${m[3]}-${m[1]}-${m[2]}`)
  }
  // YYYYMMDD, optionally separated: "20260727", "2026-07-27"
  m = /((?:19|20)\d{2})[-._ ]?(\d{2})[-._ ]?(\d{2})$/.exec(tail)
  if (
    m &&
    Number(m[2]) >= 1 &&
    Number(m[2]) <= 12 &&
    Number(m[3]) >= 1 &&
    Number(m[3]) <= 31
  ) {
    return parseIsoDay(`${m[1]}-${m[2]}-${m[3]}`)
  }
  return null
}

// ── Parser helpers ─────────────────────────────────────────────────────

// yyyy-mm-dd prefix or null — parseXlsxSheet already renders date-styled
// cells as ISO strings, so anything else is a format surprise.
function day(v: string | undefined): string | null {
  return parseIsoDay(v)
}

// Filing identifiers are not universally numeric (for example, AB-123).
// Preserve their identity while removing only display punctuation/spacing.
const identifier = (s: string | undefined) =>
  (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

function zipHeader(hdr: string[], row: string[]): Record<string, string> {
  const d: Record<string, string> = {}
  hdr.forEach((h, i) => {
    if (h) d[h] = row[i] ?? ""
  })
  return d
}

// Counsel's country names → registry office codes (WIPO ST.3-style), the
// same vocabulary the registry adapters emit — this is what lets a
// docket row join onto a TMview row. EXTEND: add countries as your
// portfolio grows; unmapped countries warn by name and their rows skip.
const COUNTRY_TO_OFFICE: Record<string, string> = {
  "UNITED STATES": "US",
  WIPO: "WO",
  "EUROPEAN UNION (EUTM & RCD)": "EU",
  "EUROPEAN UNION": "EU",
  "UNITED KINGDOM": "GB",
  CANADA: "CA",
  AUSTRALIA: "AU",
  BRAZIL: "BR",
  INDIA: "IN",
  THAILAND: "TH",
  CHINA: "CN",
  JAPAN: "JP",
  "SOUTH KOREA": "KR",
  "SOUTH AFRICA": "ZA",
  "HONG KONG": "HK",
  TAIWAN: "TW",
  JAMAICA: "JM",
  "RUSSIAN FEDERATION": "RU",
  MEXICO: "MX",
  SINGAPORE: "SG",
  "NEW ZEALAND": "NZ",
  SWITZERLAND: "CH",
  ISRAEL: "IL",
  "UNITED ARAB EMIRATES": "AE",
  FRANCE: "FR",
  GERMANY: "DE",
  ITALY: "IT",
  SPAIN: "ES",
  POLAND: "PL",
  PORTUGAL: "PT",
  IRELAND: "IE",
}

// Statuses that mean "instructed to abandon" — the Lapse Instructed flag.
const LAPSE_STATUSES = new Set(["ALLOW TO LAPSE", "RENUNCIATION"])

// CUSTOMIZE: a full-portfolio Properties Report should dwarf this; the
// floor exists to reject partial exports and wrong documents. Lower it if
// your portfolio is genuinely small.
const MIN_PORTFOLIO_ROWS = 50

// ── Properties Report ──────────────────────────────────────────────────

export function parsePropertiesReport(
  grid: string[][],
  opts: { ownerNames: string[] }
): { entries: DocketEntry[]; warnings: string[] } {
  const warnings: string[] = []
  const hdr = (grid[0] ?? []).map((c) => c.trim())
  // Every consumed column is required: a renamed column would otherwise
  // silently blank its field portfolio-wide (and a renamed "Owner Name"
  // would silently disable the wrong-client guard below).
  // CUSTOMIZE: rename to your firm's column headings.
  for (const required of [
    "Mark Name",
    "Country",
    "Application #",
    "Registration #",
    "File Date",
    "Registration Date",
    "Status",
    "Owner Name",
    "Classes Combined",
  ]) {
    if (!hdr.includes(required)) {
      throw new Error(
        `properties report: header row is missing "${required}" — wrong or reformatted file`
      )
    }
  }

  // Owner sanity is derived from ownerNames — the same strings that drive
  // registry discovery (config.ownerNames), matched case-insensitively as
  // substrings of the sheet's Owner Name cells.
  const ownerRes = opts.ownerNames.map((o) => new RegExp(escapeRe(o), "i"))

  const entries: DocketEntry[] = []
  const unmapped = new Set<string>()
  let ownerRows = 0
  let ownerMatches = 0
  let badDates = 0
  for (const row of grid.slice(1)) {
    const d = zipHeader(hdr, row)
    const owner = d["Owner Name"] ?? ""
    if (owner) {
      ownerRows++
      if (ownerRes.some((re) => re.test(owner))) ownerMatches++
    }
    for (const col of ["File Date", "Registration Date"]) {
      if ((d[col] ?? "") !== "" && day(d[col]) === null) badDates++
    }
    const country = d["Country"] ?? ""
    const office = COUNTRY_TO_OFFICE[country]
    const app = identifier(d["Application #"])
    if (!office || !(app || d["Mark Name"])) {
      if (country && !office) unmapped.add(country)
      continue
    }
    entries.push({
      mark: d["Mark Name"] ?? "",
      office,
      applicationNumber: app,
      registrationNumber: identifier(d["Registration #"]),
      filedDate: day(d["File Date"]),
      registrationDate: day(d["Registration Date"]),
      status: d["Status"] ?? "",
      classes: (d["Classes Combined"] ?? "")
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => c.padStart(3, "0")),
      lapseInstructed: LAPSE_STATUSES.has(d["Status"] ?? ""),
    })
  }
  for (const c of unmapped) {
    warnings.push(
      `unmapped country ${JSON.stringify(c)} — add to COUNTRY_TO_OFFICE (rows skipped)`
    )
  }

  // Wrong-file guards. A trademark portfolio essentially only grows; a
  // tiny or foreign-owned sheet is some other document.
  if (entries.length < MIN_PORTFOLIO_ROWS) {
    throw new Error(
      `properties report: only ${entries.length} parseable rows — not a full portfolio export`
    )
  }
  // Zero owner values across a full sheet means the column moved/renamed
  // in a way the header check missed — and the wrong-client guard below
  // would be silently skipped. Refuse rather than trust.
  if (ownerRows === 0) {
    throw new Error(
      "properties report: no row has an Owner Name value — column format change?"
    )
  }
  // 80%, not 100%: licensees, prior owners, and pre-assignment records
  // legitimately appear on some rows. Below that, this is almost
  // certainly another client's report.
  if (ownerMatches / ownerRows < 0.8) {
    throw new Error(
      `properties report: only ${ownerMatches}/${ownerRows} owner-bearing rows match ownerNames — this looks like another client's report`
    )
  }
  if (badDates > 0) {
    warnings.push(
      `${badDates} non-empty File/Registration Date cells did not parse as dates — date format change? (values kept blank)`
    )
  }
  return { entries, warnings }
}

// ── Docket Report ──────────────────────────────────────────────────────

// CUSTOMIZE: some firms prefix non-trademark matters (industrial designs,
// copyright registrations) in their reference scheme — the export this
// parser was built against used "Y…" for those. Adjust the prefix to your
// firm's scheme, or set to null to ingest every reference.
const NON_TRADEMARK_REF: RegExp | null = /^Y/

export function parseDocketReport(
  grid: string[][],
  opts: { clientNumber: string | null; allowEmpty: boolean }
): { actions: DocketAction[]; warnings: string[] } {
  const warnings: string[] = []

  // The header sits below ~10 report-criteria rows; locate it by content.
  const hdrIdx = grid.findIndex((r) => r.includes("Current Due Date"))
  if (hdrIdx < 0) {
    throw new Error(
      'docket report: no "Current Due Date" header row — wrong or reformatted file'
    )
  }
  const hdr = grid[hdrIdx].map((c) => c.trim())

  // The criteria preamble names the client ("Client: 123456"); a report
  // exported for any other client is someone else's docket and must never
  // be ingested. A missing line only warns — firms reformat preambles,
  // and the header/shape checks still hold. clientNumber null (the
  // config default) skips the check.
  const clientCell = grid
    .slice(0, hdrIdx)
    .flat()
    .map((c) => /Client:\s*(\d+)/.exec(c))
    .find(Boolean)
  if (clientCell && opts.clientNumber && clientCell[1] !== opts.clientNumber) {
    throw new Error(
      `docket report: exported for client ${clientCell[1]}, expected ${opts.clientNumber} — refusing to ingest`
    )
  }
  if (!clientCell) {
    warnings.push(
      'no "Client:" line found in the report preamble — verify this is your docket'
    )
  }

  const actions: DocketAction[] = []
  let dataRows = 0
  let badDueDates = 0
  for (const row of grid.slice(hdrIdx + 1)) {
    const d = zipHeader(hdr, row)
    const ref = d["Reference #"] ?? ""
    if (d["Current Due Date"] || ref) dataRows++
    if (!d["Current Due Date"]) continue
    if (NON_TRADEMARK_REF && NON_TRADEMARK_REF.test(ref)) continue
    const dueDate = day(d["Current Due Date"])
    if (dueDate === null) badDueDates++
    actions.push({
      dueDate,
      action: d["Action Name"] ?? "",
      reference: ref,
      office: d["Country ID"] || null,
      number: identifier(d["Reg/Serial"]),
      title: d["Title"] ?? "",
    })
  }
  // Counsel's exact due dates are the entire point of this feed — a
  // format change that nulls them, or an export that yields zero
  // trademark actions, must fail loudly so the previous good report
  // keeps serving, not silently wipe every deadline override.
  if (badDueDates > 0) {
    throw new Error(
      `docket report: ${badDueDates} Current Due Date cells did not parse as dates — date format change?`
    )
  }
  if (actions.length === 0 && dataRows > 0 && !opts.allowEmpty) {
    throw new Error(
      `docket report: header found but 0 trademark actions parsed from ${dataRows} rows — truncated or wrong-window export? (set DOCKET_ALLOW_SHRINK=1 if a genuinely empty docket is expected)`
    )
  }
  return { actions, warnings }
}

// ── Ingestion ──────────────────────────────────────────────────────────

// Ingest the newest report of each kind from the inbox page. `prev` is
// the previous cycle's parse (from sync state): an unchanged inbox costs
// exactly one children listing — no downloads, no re-parse. Pass the
// code's DERIVATION_VERSION as opts.parserVersion.
export async function fetchCounselDocket(
  pageId: string,
  prev: CounselDocketData,
  opts: {
    ownerNames: string[]
    clientNumber: string | null
    parserVersion: string
  }
): Promise<CounselDocketData> {
  const inbox = await fetchInboxFiles(pageId)

  // Newest attachment per report kind — by filename date first, edit time
  // as the tiebreaker (see reportDateFromName for why edit time alone
  // misleads).
  const latest: { properties?: InboxFile; docket?: InboxFile } = {}
  const newer = (a: InboxFile, b: InboxFile | undefined): boolean => {
    if (!b) return true
    const ad = reportDateFromName(a.name)
    const bd = reportDateFromName(b.name)
    // Filename dates decide only when BOTH files carry one — otherwise a
    // dated old file would permanently beat an undated new upload. Mixed
    // or undated pairs fall back to edit time.
    if (ad && bd && ad !== bd) return ad > bd
    return a.lastEdited > b.lastEdited
  }
  for (const f of inbox) {
    const kind = classifyReportName(f.name)
    if (!kind) {
      // A dropped file matching neither pattern would otherwise be
      // invisible forever — say so every cycle.
      if (/\.xlsx$/i.test(f.name)) {
        console.warn(
          `[counselDocket] ignoring "${f.name}" — filename matches neither "Docket Report" nor "Properties"`
        )
      }
      continue
    }
    if (newer(f, latest[kind])) latest[kind] = f
  }

  // Counsel may send one report or both — each kind ingests independently
  // under its own fingerprint, so a Docket-Report-only email works. The
  // parser version is part of the fingerprint on purpose: a fingerprint
  // that ignores the code version keeps serving a stale cached parse
  // straight through a parser fix.
  const printOf = (f: InboxFile) =>
    `${opts.parserVersion}:${f.blockId}:${f.lastEdited}`
  const regressCheck = (
    kind: string,
    chosen: InboxFile,
    prevFile: string | undefined
  ) => {
    const chosenDate = reportDateFromName(chosen.name)
    const prevDate = prevFile ? reportDateFromName(prevFile) : null
    if (chosenDate && prevDate && chosenDate < prevDate) {
      console.warn(
        `[counselDocket] ${kind}: ingesting "${chosen.name}" (${chosenDate}) over previously ingested "${prevFile}" (${prevDate}) — an older-dated report is replacing a newer one; delete stale attachments if unintended`
      )
    }
  }

  const next: CounselDocketData = {}
  if (latest.properties) {
    const f = latest.properties
    const fingerprint = printOf(f)
    if (prev.properties?.fingerprint === fingerprint) {
      next.properties = prev.properties
    } else {
      regressCheck("properties", f, prev.properties?.file)
      const { entries, warnings } = parsePropertiesReport(
        parseXlsxSheet(await downloadInboxFile(f)),
        { ownerNames: opts.ownerNames }
      )
      for (const w of warnings) console.warn(`[counselDocket] ${f.name}: ${w}`)
      // Shrink guard: the portfolio essentially only grows — a much
      // smaller sheet is a partial export or the wrong document, and
      // ingesting it would strip lapse flags and (after a backfill)
      // sweep counsel-only rows. The guard needs a baseline, so it only
      // arms from the second ingest onward.
      const baseline = prev.properties?.entries.length
      if (
        baseline !== undefined &&
        entries.length < baseline * 0.6 &&
        process.env.DOCKET_ALLOW_SHRINK !== "1"
      ) {
        throw new Error(
          `properties report "${f.name}" parsed ${entries.length} rows vs ${baseline} previously — suspicious shrink, refusing (set DOCKET_ALLOW_SHRINK=1 if intended)`
        )
      }
      console.warn(
        `[counselDocket] ingested ${entries.length} entries from "${f.name}"`
      )
      next.properties = { fingerprint, file: f.name, entries }
    }
  }
  if (latest.docket) {
    const f = latest.docket
    const fingerprint = printOf(f)
    if (prev.docket?.fingerprint === fingerprint) {
      next.docket = prev.docket
    } else {
      regressCheck("docket", f, prev.docket?.file)
      const { actions, warnings } = parseDocketReport(
        parseXlsxSheet(await downloadInboxFile(f)),
        {
          clientNumber: opts.clientNumber,
          allowEmpty: process.env.DOCKET_ALLOW_SHRINK === "1",
        }
      )
      for (const w of warnings) console.warn(`[counselDocket] ${f.name}: ${w}`)
      console.warn(
        `[counselDocket] ingested ${actions.length} docketed actions from "${f.name}"`
      )
      next.docket = { fingerprint, file: f.name, actions }
    }
  }
  if (!next.properties && !next.docket) {
    // An empty (or all-unrecognizable) inbox is a misconfiguration, not
    // an empty docket — the throw keeps the previous parsed snapshot
    // serving. To deliberately turn this source off instead: remove
    // DOCKET_INBOX_PAGE_ID (emptying the page alone just freezes the
    // last parse), or reset delta state to drop the cached snapshot too.
    throw new Error(
      "no docket/properties .xlsx attached to the Docket Inbox page (previous parse keeps serving; to deliberately revert, remove DOCKET_INBOX_PAGE_ID or reset delta state)"
    )
  }
  return next
}

// ── Health probe ───────────────────────────────────────────────────────

// A FULL dry-run of the ingestion path: list, classify, download, parse,
// validate. Deliberately heavyweight for a probe, because the sync's
// failure mode is SILENT by design — when the newest report is bad,
// fetchCounselDocket throws and the resilience layer keeps serving the
// previous snapshot, so nothing in the portfolio looks wrong. This red
// health row is how a bad or misnamed report actually gets noticed.
// Cost: one listing + two small downloads per probe, all against the
// Notion API — no WAF or pacer concerns.
export async function probeCounselDocket(
  pageId: string,
  opts: {
    ownerNames: string[]
    clientNumber: string | null
    parserVersion: string
  }
): Promise<void> {
  const files = await fetchInboxFiles(pageId)
  // Stray spreadsheets only warn in the sync (it must keep running); the
  // probe hard-fails on them so the misnamed file gets fixed.
  const strays = files.filter(
    (f) => /\.xlsx$/i.test(f.name) && !classifyReportName(f.name)
  )
  if (strays.length > 0) {
    throw new Error(
      `unclassifiable xlsx on the Docket Inbox: ${strays
        .map((f) => `"${f.name}"`)
        .join(", ")} — rename to include "Docket Report" or "Properties"`
    )
  }
  // Empty prev: the probe re-downloads and re-parses every time, by
  // design — a cached fingerprint would hide a parse that no longer
  // passes.
  await fetchCounselDocket(pageId, {}, opts)
}
