// ──────────────────────────────────────────────────────────────────────
// TMview adapter (live, keyless) — every non-US mark
// ──────────────────────────────────────────────────────────────────────
//
// tmdn.org/tmview is EUIPN's cross-office aggregator: one index over ~75
// registers (WIPO IRs, EUIPO, UK, CA, AU, BR, IN, TH, …) and the only
// single source for offices with no public API. It is a mirror, not the
// register of record — freshness varies by contributing office — and the
// endpoint is the TMview SPA's own backend: keyless, undocumented, no
// stability promise. Hard-won wire facts, recorded so they survive a
// rewrite:
//
//   • The applicant filter is `appName: ["Acme Corporation"]` — an ARRAY
//     OF STRINGS. A bare string is SILENTLY IGNORED (the response looks
//     fine, just unfiltered) and an array of objects 400s. The backend
//     silently ignores unknown fields generally — it never rejects a
//     misshapen body, it just drops the parameter — so verify any body
//     change against real result counts, not the absence of an error.
//   • The WAF holds connections open rather than failing fast (hence the
//     15s timeout below) and blocks some datacenter egress ranges
//     outright, so treat this source as best-effort by construction.
//   • Browser-ish User-Agent + Referer headers keep it answering.
//
// EXTEND: the detail endpoint used for statusDate also carries goods &
// services text, owner addresses, and prosecution events — add fields to
// ForeignMark and map them where the detail response is read.

import { fetchWithTimeout } from "../engine/http.js"
import type { ForeignMark } from "./types.js"

const TMVIEW_SEARCH_URL = "https://www.tmdn.org/tmview/api/search/results"
const TMVIEW_DETAIL_URL = (st13: string) =>
  `https://www.tmdn.org/tmview/api/trademark/detail/${st13}`

// Human-facing detail page for a mark — what the Registry URL column
// links to (the SPA route, not the API detail endpoint above).
export const TMVIEW_PAGE_URL = (st13: string) =>
  `https://www.tmdn.org/tmview/#/tmview/detail/${st13}`

// Mark thumbnail (renders the word element for pure word marks). Two
// production lessons: this endpoint often blocks datacenter egress even
// while search answers, and tmdn image URLs are hotlink-blocked inside
// Notion — so the mark-images tool downloads the bytes and uploads them
// to Notion instead of pasting this URL into a files property.
export const TMVIEW_THUMBNAIL_URL = (st13: string) =>
  `https://www.tmdn.org/tmview/api/trademark/thumbnail/${st13}`

// The WAF stalls rather than refuses; 15s (vs the engine's default 30s)
// keeps a blocked cycle inside the execute budget.
const TMVIEW_TIMEOUT_MS = 15_000
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  Referer: "https://www.tmdn.org/tmview/",
}

// ── Defensive accessors ────────────────────────────────────────────────
//
// The payload is undocumented: nearly every field can be missing, null,
// or a scalar where an array is expected.

type AnyRec = Record<string, unknown>
const rec = (v: unknown): AnyRec =>
  v && typeof v === "object" ? (v as AnyRec) : {}
const arr = (v: unknown): unknown[] =>
  Array.isArray(v) ? v : v == null ? [] : [v]
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== ""
    ? v.trim()
    : typeof v === "number"
      ? String(v)
      : null
const day = (v: unknown): string | null => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(str(v) ?? "")
  return m ? m[1] : null
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// ── Projection ─────────────────────────────────────────────────────────

// Search hit → ForeignMark. statusDate is NOT in the search payload — it
// comes from the budgeted per-mark detail fetch below.
function projectMark(t: AnyRec): ForeignMark | null {
  const st13 = str(t.ST13)
  const office = str(t.tmOffice)
  if (!st13 || !office) return null
  return {
    st13,
    office: office === "EM" ? "EU" : office, // EUIPO's ST.3 code is EM
    name: str(t.tmName),
    applicationNumber: str(t.applicationNumber),
    registrationNumber: str(t.registrationNumber),
    applicationDate: day(t.applicationDate),
    registrationDate: day(t.registrationDate),
    expirationDate: day(t.expirationDate),
    oppositionDeadline: day(t.oppositionDeadLine), // sic — capital L
    status: str(t.tradeMarkStatus),
    statusDate: null,
    tmType: str(t.tradeMarkType),
    niceClasses: arr(t.niceClass)
      .map((c) => str(c))
      .filter((c): c is string => Boolean(c))
      .map((c) => c.padStart(3, "0"))
      .sort(),
    // tProtection lists where the right has effect: for Madrid IRs the
    // designated offices; an EU-wide right lists every member state,
    // which collapses to just "EU".
    designations: (() => {
      const raw = arr(t.tProtection)
        .map((c) => str(c))
        .filter((c): c is string => Boolean(c))
      if (raw.includes("EM")) return ["EU"]
      return Array.from(new Set(raw)).sort()
    })(),
  }
}

// The projection minus statusDate, as a comparable string — decides
// whether prev's cached statusDate can carry forward without a detail
// fetch. A false mismatch merely spends one budgeted fetch, never
// corrupts data.
const searchBasis = (m: ForeignMark): string =>
  JSON.stringify({ ...m, statusDate: null })

// Best-effort detail fetch for the official status-change date
// (.tradeMark.markCurrentStatusDate); null on any failure — a blocked
// detail endpoint must not fail the source while search itself answers.
async function fetchStatusDate(
  st13: string,
  pace: () => Promise<void>
): Promise<string | null> {
  try {
    await pace()
    const res = await fetchWithTimeout(
      TMVIEW_DETAIL_URL(st13),
      { headers: BROWSER_HEADERS },
      TMVIEW_TIMEOUT_MS
    )
    if (!res.ok) return null
    const detail = rec(await res.json())
    return day(rec(detail.tradeMark).markCurrentStatusDate)
  } catch {
    return null
  }
}

// ── Search ─────────────────────────────────────────────────────────────

// Fetch all non-US marks for the given owners, keyed by ST13 (WIPO's
// global mark identifier). `wordmarks` — the US portfolio's word elements
// — only drives the fallback sweep; `prev` is the previous cycle's result
// (statusDate carry-forward); `pace` is the pacer's wait(), called before
// EVERY request; `opts.detailBudget` caps per-mark detail fetches (0
// skips them entirely).
export async function fetchForeignMarks(
  ownerNames: string[],
  wordmarks: string[],
  prev: Record<string, ForeignMark>,
  pace: () => Promise<void>,
  opts?: { detailBudget?: number }
): Promise<Record<string, ForeignMark>> {
  const ownerRes = ownerNames.map((o) => new RegExp(escapeRe(o), "i"))
  const out: Record<string, ForeignMark> = {}
  let rawHits = 0

  const runSearch = async (body: Record<string, unknown>): Promise<number> => {
    await pace()
    const res = await fetchWithTimeout(
      TMVIEW_SEARCH_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...BROWSER_HEADERS },
        body: JSON.stringify({
          page: "1",
          pageSize: "100",
          criteria: "C",
          ...body,
        }),
      },
      TMVIEW_TIMEOUT_MS
    )
    if (!res.ok) {
      throw new Error(
        `TMview search ${res.status}: ${await res.text().catch(() => "")}`
      )
    }
    const hits = arr(rec(await res.json()).tradeMarks)
    for (const h of hits) {
      const hr = rec(h)
      // Keep only hits actually owned by one of ownerNames — both search
      // paths can return strangers (basicSearch especially).
      const applicants = arr(hr.applicantName).map((a) => str(a) ?? "")
      if (!applicants.some((a) => ownerRes.some((re) => re.test(a)))) continue
      const m = projectMark(hr)
      // US rows come from the USPTO adapter — richer and fresher.
      if (m && m.office !== "US" && !out[m.st13]) out[m.st13] = m
    }
    return hits.length
  }

  // PRIMARY: applicant search, one query per owner name. This finds
  // everything — design-only marks and non-Latin-script filings included —
  // that a wordmark text sweep would miss. Paginated defensively (a real
  // portfolio fits one page today).
  for (const owner of ownerNames) {
    for (let page = 1; page <= 5; page++) {
      const got = await runSearch({ page: String(page), appName: [owner] })
      rawHits += got
      if (got < 100) break
    }
  }

  // FALLBACK: wordmark text sweep — keeps foreign coverage alive if the
  // unofficial appName param shape changes underneath us. Capped: each
  // query is a paced request, and past 20 the portfolio signal is gone.
  if (rawHits === 0 && wordmarks.length > 0) {
    console.warn(
      "[tmview] appName search returned zero hits — falling back to wordmark sweep"
    )
    for (const q of wordmarks.slice(0, 20)) {
      rawHits += await runSearch({ basicSearch: q })
    }
  }

  // Every query returning zero RAW hits (not merely zero owner matches)
  // means a blocked or changed endpoint, not an empty portfolio — an
  // owner with zero marks worldwide is not a reachable state once the
  // sync exists. Throw into the resilience layer instead of returning {}
  // and letting a replace cycle sweep every foreign row.
  if (rawHits === 0 && (ownerNames.length > 0 || wordmarks.length > 0)) {
    throw new Error(
      "TMview returned zero hits for every query — likely block/endpoint change"
    )
  }

  // Status dates come from the per-mark detail endpoint, budgeted:
  // each detail fetch is a paced request, so at a polite pacer 20 of
  // them can eat minutes of the execute budget — a cold portfolio
  // converges over 2-3 cycles instead of blowing the handler limit.
  // Carry-forward: an unchanged search projection reuses prev's cached
  // date for free; when the budget runs out, stale beats blank.
  let detailBudget = opts?.detailBudget ?? 20
  for (const [st13, m] of Object.entries(out)) {
    const p = prev[st13]
    const unchanged = p && searchBasis(p) === searchBasis(m)
    if (unchanged && p.statusDate) {
      m.statusDate = p.statusDate
    } else if (detailBudget > 0) {
      detailBudget--
      m.statusDate = await fetchStatusDate(st13, pace)
    } else if (p?.statusDate) {
      m.statusDate = p.statusDate // stale beats blank until budget allows
    }
  }
  return out
}

// ── Health probe ───────────────────────────────────────────────────────

// One basicSearch query proves the unofficial backend still answers with
// a well-formed result set. ONE request, deliberately: probed through
// fetchForeignMarks at the default detail budget, a health check is ~21
// paced requests — every 15 minutes that is ~2,000/day, enough to starve
// concurrent syncs at a shared pacer AND look like scraping to the WAF
// that already blocks datacenter ranges. Probes must stay single-request.
export async function probeTmview(pace: () => Promise<void>): Promise<void> {
  await pace()
  const res = await fetchWithTimeout(
    TMVIEW_SEARCH_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...BROWSER_HEADERS },
      body: JSON.stringify({
        page: "1",
        pageSize: "10",
        criteria: "C",
        // Any common word works: zero hits for it means a block or an
        // endpoint change, never a genuinely empty result.
        basicSearch: "aurora",
      }),
    },
    TMVIEW_TIMEOUT_MS
  )
  if (!res.ok) throw new Error(`TMview probe ${res.status}`)
  const hits = arr(rec(await res.json()).tradeMarks)
  if (hits.length === 0) {
    throw new Error(
      "TMview probe returned zero hits for a common word — block or endpoint change"
    )
  }
}
