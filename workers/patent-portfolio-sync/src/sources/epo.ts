// ──────────────────────────────────────────────────────────────────────
// EPO Open Patent Services (OPS) — European Patent Register adapter (live)
// ──────────────────────────────────────────────────────────────────────
//
// Discovers EP applications by applicant via the Register search (no
// docketing dependency), then fetches each one's register data: status,
// publications/grant, and publication numbers. OAuth2 client-credentials;
// tokens last ~20 min. Register detail (designated states, renewals,
// search-report citations) is advanced — see the advanced-enrichment skill.
//
// EXTEND: OPS also offers INPADOC family IDs + worldwide member data (JP/CN
// grant detection, legal events) and forward-citation counts — add adapters
// or enrich here once the basics are in place.

import { fetchWithTimeout } from "../engine/http.js"
import type { PatentRecord } from "./types.js"

const AUTH_URL = "https://ops.epo.org/3.2/auth/accesstoken"
// Exported so the optional document-retrieval tools (src/tools/documents.ts)
// reuse OPS auth + the XML-as-JSON helpers instead of duplicating them.
export const OPS_REST = "https://ops.epo.org/3.2/rest-services"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OpsNode = any
export const opsArr = <T>(x: T | T[] | null | undefined): T[] =>
  x == null ? [] : Array.isArray(x) ? x : [x]
export const opsText = (x: OpsNode): string | null => {
  const v = x?.["$"]
  return v == null ? null : String(v)
}
const opsDate = (s: string | null): string | null =>
  s && /^\d{8}$/.test(s)
    ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
    : (s ?? null)

let tokenCache: { token: string; expiresAtMs: number } | null = null
// OAuth client-credentials; ~20-min token, cached. Exported for reuse by the
// document-retrieval tools.
export async function epoToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAtMs - 60_000)
    return tokenCache.token
  const id = process.env.EPO_CONSUMER_KEY
  const secret = process.env.EPO_CONSUMER_SECRET
  if (!id || !secret)
    throw new Error(
      "EPO_CONSUMER_KEY / EPO_CONSUMER_SECRET env vars are not set"
    )
  const res = await fetchWithTimeout(AUTH_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  })
  if (!res.ok)
    throw new Error(
      `EPO OPS auth ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`
    )
  const json = (await res.json()) as {
    access_token?: string
    expires_in?: string | number
  }
  if (!json.access_token) throw new Error("EPO OPS auth: no access_token")
  tokenCache = {
    token: json.access_token,
    expiresAtMs: Date.now() + Number(json.expires_in ?? 1200) * 1000,
  }
  return tokenCache.token
}

async function get(
  path: string,
  tok: string,
  headers?: Record<string, string>
): Promise<OpsNode | null> {
  const res = await fetchWithTimeout(`${OPS_REST}${path}`, {
    headers: {
      Authorization: `Bearer ${tok}`,
      Accept: "application/json",
      ...headers,
    },
  })
  if (res.status === 404) return null
  if (!res.ok)
    throw new Error(
      `EPO OPS ${path} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`
    )
  return res.json()
}

// Register search returns 8-digit application numbers; epodoc wants
// EP + 4-digit year + 7-digit zero-padded serial.
const toEpodoc = (digits: string): string =>
  `EP20${digits.slice(0, 2)}${digits.slice(2).padStart(7, "0")}`

// OPS returns register-search results in pages; request successive Range
// windows (max 100 per request) until we've pulled the reported total.
// Without paging, only the first page (~25) comes back — silently truncating
// large European portfolios. OPS also hard-caps the total (~2000 results);
// beyond that the query itself must be narrowed, so we stop and warn there.
const OPS_SEARCH_PAGE = 100
const OPS_SEARCH_MAX = 2000

async function searchByApplicant(
  applicant: string,
  tok: string,
  pace: () => Promise<void>
): Promise<Array<{ digits: string; title: string | null }>> {
  const q = encodeURIComponent(`pa="${applicant}"`)
  const out: Array<{ digits: string; title: string | null }> = []
  for (let start = 1; start <= OPS_SEARCH_MAX; start += OPS_SEARCH_PAGE) {
    await pace()
    const raw = await get(`/register/search?q=${q}`, tok, {
      Range: `${start}-${start + OPS_SEARCH_PAGE - 1}`,
    })
    const search = raw?.["ops:world-patent-data"]?.["ops:register-search"]
    const docs = opsArr(
      search?.["reg:register-documents"]?.["reg:register-document"]
    )
    if (docs.length === 0) break // past the end (also guards a Range-ignored server)
    for (const d of docs) {
      const bib = d?.["reg:bibliographic-data"]
      const num = opsText(
        opsArr(bib?.["reg:application-reference"])[0]?.["reg:document-id"]?.[
          "reg:doc-number"
        ]
      )
      if (!num || !/^\d{8}$/.test(num)) continue
      const titles = opsArr(bib?.["reg:invention-title"])
      const en = titles.find((t: OpsNode) => t?.["@lang"] === "en") ?? titles[0]
      out.push({ digits: num, title: opsText(en) })
    }
    const total = Number(search?.["@total-result-count"] ?? 0)
    if (docs.length < OPS_SEARCH_PAGE) break // last (partial) page
    if (total && start + OPS_SEARCH_PAGE > total) break // pulled everything
    if (start + OPS_SEARCH_PAGE > OPS_SEARCH_MAX) {
      console.warn(
        `[epo] register search for "${applicant}" hit the OPS ${OPS_SEARCH_MAX}-result cap — narrow the query to capture the rest`
      )
    }
  }
  return out
}

async function fetchRegister(
  digits: string,
  tok: string
): Promise<PatentRecord | null> {
  const epodoc = toEpodoc(digits)
  const regDoc = (raw: OpsNode): OpsNode =>
    opsArr(
      raw?.["ops:world-patent-data"]?.["ops:register-search"]?.[
        "reg:register-documents"
      ]?.["reg:register-document"]
    )[0]

  const biblioRaw = await get(
    `/register/application/epodoc/${epodoc}/biblio`,
    tok
  )
  if (!biblioRaw) return null
  const bib = regDoc(biblioRaw)?.["reg:bibliographic-data"]
  const status = (bib?.["@status"] as string | undefined) ?? null

  const pubs = opsArr(bib?.["reg:publication-reference"])
    .map((p: OpsNode) => p?.["reg:document-id"])
    .filter(Boolean)
    .map((d: OpsNode) => ({
      country: opsText(d?.["reg:country"]) ?? "",
      docNumber: opsText(d?.["reg:doc-number"]) ?? "",
      kind: opsText(d?.["reg:kind"]) ?? "",
      date: opsDate(opsText(d?.["reg:date"])),
    }))
  const grant = pubs.find((p) => p.country === "EP" && p.kind.startsWith("B"))
  const epPub = pubs.find((p) => p.country === "EP")

  // Base adapter fetches biblio only. EP register detail — designated
  // states, renewal-fee payments (a second /procedural-steps call), and
  // X/Y search-report citations — is ADVANCED; see the advanced-enrichment
  // skill to add it back along with its columns.

  // Filing date = earliest publication date's basis is not exposed here;
  // use the request-for-examination / publication dates for the status
  // cascade, and the EP application's own filing for term once granted.
  const requestExamDate = opsDate(
    opsText(
      bib?.["reg:dates-rights-effective"]?.["reg:request-for-examination"]?.[
        "reg:date"
      ]
    )
  )
  const filingDate = filingFromEpodoc(epodoc)
  const dead = /withdrawn|refused|revoked|lapsed|deemed/i.test(status ?? "")
  const titles = opsArr(bib?.["reg:invention-title"])
  const enTitle = opsText(
    titles.find((t: OpsNode) => t?.["@lang"] === "en") ?? titles[0]
  )

  return {
    source: "EPO",
    jurisdiction: "EP",
    applicationNumber: digits,
    title: enTitle ?? epodoc,
    type: "National Phase",
    filingDate,
    status,
    statusDate:
      grant?.date ??
      requestExamDate ??
      epPub?.date ??
      pubs
        .map((p) => p.date)
        .filter(Boolean)
        .sort()[0] ??
      null,
    grantDate: grant?.date ?? null,
    patentNumber: grant ? `EP${grant.docNumber}` : null,
    publicationNumber: epPub ? `EP${epPub.docNumber}` : null,
    // EP term = 20y from filing, grant-gated and not since dead.
    estExpiry: grant && !dead && filingDate ? addYears(filingDate, 20) : null,
    parents: [], // cross-office family grouping comes from docketing/INPADOC
  }
}

// Fetch EP records for the given applicant name(s). `pace` is the pacer's
// wait(), called before every OPS request.
export async function fetchEpoRecords(
  applicants: string[],
  pace: () => Promise<void>
): Promise<PatentRecord[]> {
  await pace()
  const tok = await epoToken()
  const seen = new Set<string>()
  const out: PatentRecord[] = []
  for (const applicant of applicants) {
    const hits = await searchByApplicant(applicant, tok, pace)
    for (const hit of hits) {
      if (seen.has(hit.digits)) continue
      seen.add(hit.digits)
      await pace()
      try {
        const rec = await fetchRegister(hit.digits, tok)
        if (rec) {
          // Prefer the search-result title if the register only gave
          // us the epodoc fallback.
          if (hit.title && rec.title === toEpodoc(hit.digits))
            rec.title = hit.title
          out.push(rec)
        }
      } catch (err) {
        // One bad app must not sink the whole source — the resilience
        // layer handles total-source failures; here we skip per-app.
        console.warn(
          `[epo] ${hit.digits}: ${err instanceof Error ? err.message : err} — skipped`
        )
      }
    }
  }
  return out
}

// Auth round-trip proves reachability + valid credentials. Used by
// healthSync (its own process, so the module token cache doesn't mask it).
export async function probeEpo(pace: () => Promise<void>): Promise<void> {
  await pace()
  await epoToken()
}

// EP filing year is encoded in the epodoc (EP + YYYY + serial). The register
// biblio doesn't expose a clean filing date for Euro-PCT entries, so we
// approximate term basis from the application year. EXTEND: pull the true
// international filing date from the publication-reference if you need
// day-accuracy for term.
function filingFromEpodoc(epodoc: string): string | null {
  const m = /^EP(\d{4})/.exec(epodoc)
  return m ? `${m[1]}-01-01` : null
}

function addYears(date: string, years: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date)
  if (!m) return null
  const y = Number(m[1]) + years
  if (m[2] === "02" && m[3] === "29") return `${y}-02-28`
  return `${y}-${m[2]}-${m[3]}`
}
