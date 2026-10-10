// ──────────────────────────────────────────────────────────────────────
// USPTO adapter (live, keyless-first)
// ──────────────────────────────────────────────────────────────────────
//
// Discovers US marks by owner name and normalizes them to UsCase. Two
// endpoints, layered by trust:
//
//   1. tmsearch.uspto.gov — the undocumented Elasticsearch proxy behind
//      the TESS-successor search UI. ONE owner query returns the full
//      case record for every mark (status, dates, classes, goods &
//      services, basis, affidavits) with NO API key — this is what lets
//      the template deploy before any key paperwork clears. The index
//      lags case changes by ~1-2 days and carries no status date.
//   2. TSDR caseMultiStatus (optional, TSDR_API_KEY) — the authoritative
//      same-day record, merged over the tmsearch baseline field by
//      field, and the ONLY source of UsCase.statusDate (which anchors
//      the OA-response deadline): keyless deployments get no Status
//      Date. There used to be a keyless middle layer — TSDR's
//      last-update endpoint supplied change stamps + status dates
//      without a key — but USPTO retired it on 2026-07-30 (connection
//      reset from every network; it was the last pre-ODP keyless TSDR
//      endpoint). Don't re-add it.
//
// The keyless backend is unofficial and WAF-fronted; a WAF can decide
// to block datacenter egress at any time. Every response is therefore
// treated defensively, and the one failure mode that could silently
// destroy the portfolio — a challenge page that parses as a valid EMPTY
// result — is converted into a loud throw (see fetchUsCases).

import { fetchWithTimeout } from "../engine/http.js"
import { strictIsoDay } from "../engine/date.js"
import type { UsCase } from "./types.js"

// ── Endpoints ──────────────────────────────────────────────────────────

const TMSEARCH_URL = "https://tmsearch.uspto.gov/prod-v1-0-0/tmsearch"

// TSDR's API host. The human-facing site (tsdr.uspto.gov, no "api") is a
// different host that serves pages and images, not JSON.
const TSDR_BASE = "https://tsdrapi.uspto.gov"
// Batch case status. Envelope (verified live):
//   { transactionList: [{ trademarks: […], searchId: "<serial>" }], … }
// — each element is the same shape the per-case info.json returns.
const TSDR_MULTI_STATUS_URL = (serials: string[]) =>
  `${TSDR_BASE}/ts/cd/caseMultiStatus/sn?ids=${serials.join(",")}`

// Serials per caseMultiStatus batch call. TSDR throttles aggressively
// ("Max transaction limit reached per user"): one call per serial trips
// its 429 on the very first full refresh, while batches of 20 keep a
// whole mid-sized portfolio at ~2 requests.
const TSDR_MULTI_STATUS_BATCH = 20
const MAX_TSDR_REDIRECTS = 5

// tmsearch page size. The endpoint is an undocumented Elasticsearch proxy,
// but it does not expose a verified exact-total + deterministic-sort contract
// that would make offset pagination safe. A full page is therefore rejected
// below instead of being mistaken for a complete portfolio.
const TMSEARCH_PAGE_SIZE = 500

// Read at CALL time, never module scope: env is injected per run, so a
// key added via `ntn workers env set` must take effect on the next cycle.
// A module-scope read would bake in the (empty) deploy-time value and
// demand a redeploy before the key is ever noticed.
const tsdrKeyOptional = (): string | null => process.env.TSDR_API_KEY || null

// Whether the optional TSDR key is configured. index.ts gates the keyed
// health probe on this, so a keyless deployment (a fully supported state)
// doesn't show a permanently-red row for a key it never claimed to have.
export function tsdrKeyConfigured(): boolean {
  return tsdrKeyOptional() !== null
}

const isRedirectStatus = (status: number): boolean =>
  status === 301 ||
  status === 302 ||
  status === 303 ||
  status === 307 ||
  status === 308

function safeTsdrRedirectUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("TSDR caseMultiStatus returned an invalid redirect URL")
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(
      "TSDR caseMultiStatus redirects must use credential-free HTTPS URLs"
    )
  }
  return url
}

// Node's automatic redirect handling can forward custom authentication
// headers cross-origin. Follow manually and recompute the key on every hop:
// only the exact TSDR API origin receives USPTO-API-KEY.
async function fetchTsdrWithRedirects(
  url: string,
  key: string,
  pace: () => Promise<void>
): Promise<Response> {
  let current = safeTsdrRedirectUrl(url)
  for (let redirects = 0; ; redirects++) {
    if (redirects > 0) await pace()
    const headers = new Headers({ Accept: "application/json" })
    if (current.origin === TSDR_BASE && current.port === "") {
      headers.set("USPTO-API-KEY", key)
    }
    const response = await fetchWithTimeout(current.toString(), {
      headers,
      redirect: "manual",
    })
    if (!isRedirectStatus(response.status)) return response
    await response.body?.cancel().catch(() => undefined)
    if (redirects >= MAX_TSDR_REDIRECTS) {
      throw new Error(
        `TSDR caseMultiStatus exceeded ${MAX_TSDR_REDIRECTS} redirects`
      )
    }
    const location = response.headers.get("location")
    if (!location)
      throw new Error("TSDR caseMultiStatus redirect omitted Location")
    current = safeTsdrRedirectUrl(new URL(location, current).toString())
  }
}

// ── Defensive JSON access ──────────────────────────────────────────────
//
// TSDR's info.json is its internal Java model serialized directly (short
// camelCase keys), not a rendering of the published XML formats.
// Individual cases omit whole sections — pre-publication cases have no
// publication node, design-only cases no word element — and nearly every
// scalar can be null, so nothing below trusts a path to exist.

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
const strArr = (v: unknown): string[] =>
  arr(v)
    .map((x) => str(x))
    .filter((x): x is string => Boolean(x))
// ── tmsearch.uspto.gov (enumeration + primary case data) ──────────────

// Only the fields the projection below reads — a narrow _source keeps the
// response (and the runner's snapshot of it) small.
// EXTEND: tmsearch documents also carry owner addresses, attorney names,
// pseudo-marks, and more. Add the field here, map it in
// projectTmsearchHit(), and declare it on UsCase.
const TMSEARCH_SOURCE_FIELDS = [
  "id",
  "wordmark",
  "markDescription",
  "statusDescription",
  "alive",
  "filedDate",
  "publishForOppositionDate",
  "registrationId",
  "registrationDate",
  "abandonDate",
  "cancelDate",
  "currentBasis",
  "originalBasis",
  "goodsAndServices",
  "internationalClass",
  "drawingCode",
  "affidavit",
  "disclaimer",
  "registrationType",
  "internationalId",
]

type TmsearchHit = { id?: string; source?: AnyRec }

async function tmsearchQuery(
  owner: string,
  size: number
): Promise<TmsearchHit[]> {
  const res = await fetchWithTimeout(TMSEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // A browser-ish UA keeps the WAF happy; the sync makes about one
      // request per cycle, so this never resembles scraping traffic.
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
    body: JSON.stringify({
      query: { bool: { must: [{ match_phrase: { ownerName: owner } }] } },
      size,
      _source: TMSEARCH_SOURCE_FIELDS,
    }),
  })
  if (!res.ok) {
    throw new Error(
      `tmsearch ${res.status}: ${await res.text().catch(() => "")}`
    )
  }
  const data = (await res.json()) as { hits?: { hits?: TmsearchHit[] } }
  const hits = data.hits?.hits ?? []
  if (hits.length > size) {
    throw new Error(
      `tmsearch returned ${hits.length} hits after requesting at most ${size}`
    )
  }
  return hits
}

// Project a tmsearch document straight to UsCase AT THE FETCH BOUNDARY —
// only fields UsCase declares survive. The raw documents are large, and
// whatever is kept here rides in the delta's gzipped snapshot forever
// (state-size discipline; see engine/state.ts).
function projectTmsearchHit(serial: string, src: AnyRec): UsCase {
  // markDescription is an array mixing the actual description ("The mark
  // consists of …") with color-claim boilerplate ("Color is not claimed
  // as a feature of the mark."). Prefer the real description.
  const descEntries = strArr(src.markDescription)
  const markDescription =
    descEntries.find((e) => /mark consists of/i.test(e)) ??
    descEntries.find((e) => !/color/i.test(e)) ??
    descEntries.join(" ")

  // Filing basis, bucketed to the join's vocabulary. 44(d) and 44(e)
  // collapse into one bucket — the priority-claim distinction rarely
  // survives to registration, and the schema shows them as one option.
  const basisRaw =
    strArr(src.currentBasis)[0] ?? strArr(src.originalBasis)[0] ?? null
  const basis = basisRaw
    ? /66/.test(basisRaw)
      ? "66a"
      : /44/.test(basisRaw)
        ? "44"
        : /1b/i.test(basisRaw)
          ? "1b"
          : /1a/i.test(basisRaw)
            ? "1a"
            : null
    : null

  // Affidavit entries like "SECT 8 (6-YR)" or a status descriptor like
  // "SECTION 8 & 15-ACCEPTED…" mark an accepted §8 (or Madrid §71)
  // declaration — the flag that gates the renewal-deadline forecast.
  const statusDescription = str(src.statusDescription)
  const section8Accepted =
    strArr(src.affidavit).some((a) => /SECT\.?\s*(8|71)/i.test(a)) ||
    /section (8|71)[^a-z]*accept/i.test(statusDescription ?? "")

  // goodsAndServices strings arrive pre-formatted as "IC 009: text…".
  const goodsAndServices = strArr(src.goodsAndServices).join("\n")

  const registrationType = strArr(src.registrationType)
  const drawingCode =
    typeof src.drawingCode === "number" ? src.drawingCode : null

  return {
    serial,
    registrationNumber: str(src.registrationId),
    wordmark: str(src.wordmark),
    markDescription: markDescription || null,
    // Drawing-code buckets: 2 = design only, 3 = design + words,
    // 5 = stylized words.
    hasDesignElement: [2, 3, 5].includes(drawingCode ?? 0),
    statusText: statusDescription,
    tm5StatusDesc:
      src.alive === false ? "DEAD" : src.alive === true ? "LIVE" : null,
    // tmsearch has no status-date field — only the keyed TSDR overlay
    // supplies it (the keyless TM-LUS stamp source retired 2026-07-30).
    statusDate: null,
    filingDate: strictIsoDay(src.filedDate, `tmsearch ${serial} filedDate`),
    registrationDate: strictIsoDay(
      src.registrationDate,
      `tmsearch ${serial} registrationDate`
    ),
    publishedDate: strictIsoDay(
      src.publishForOppositionDate,
      `tmsearch ${serial} publishForOppositionDate`
    ),
    noticeOfAllowanceDate: null, // TSDR-only field
    dateAbandoned: strictIsoDay(
      src.abandonDate,
      `tmsearch ${serial} abandonDate`
    ),
    dateCancelled: strictIsoDay(
      src.cancelDate,
      `tmsearch ${serial} cancelDate`
    ),
    basis,
    niceClasses: strArr(src.internationalClass)
      .map((c) => c.replace(/^IC\s+/i, "").padStart(3, "0"))
      .sort(),
    goodsAndServices: goodsAndServices || null,
    section8Accepted,
    register: registrationType.length
      ? registrationType.some((t) => /supplemental/i.test(t))
        ? "Supplemental"
        : "Principal"
      : null,
    irNumber: str(src.internationalId),
    attorneyDocket: null, // TSDR-only field
    disclaimer: str(src.disclaimer),
  }
}

// ── TSDR case-status overlay (optional, keyed) ─────────────────────────

// Reduce one casestatus / caseMultiStatus case to UsCase. ALL TSDR path
// knowledge lives in this function, so a payload-format surprise
// localizes here instead of scattering across the adapter.
function parseTsdrCase(raw: unknown, expectedSerial: string): UsCase {
  const root = rec(raw)
  if (!Array.isArray(root.trademarks) || root.trademarks.length === 0) {
    throw new Error(
      `TSDR caseMultiStatus ${expectedSerial} has no trademarks record`
    )
  }
  const tm = rec(root.trademarks[0])
  const status = rec(tm.status)
  if (Object.keys(status).length === 0) {
    throw new Error(
      `TSDR caseMultiStatus ${expectedSerial} has no status record`
    )
  }

  // serialNumber is a NUMBER in the payload; str() stringifies it. It must
  // agree with both the transaction searchId and the batch request — an
  // alien case must never be merged into another portfolio row.
  const serial = str(status.serialNumber) ?? ""
  if (!/^\d{8}$/.test(serial) || serial !== expectedSerial) {
    throw new Error(
      `TSDR caseMultiStatus requested ${expectedSerial} but returned serial ${JSON.stringify(serial)}`
    )
  }

  // Goods & services live in gsList (a sibling of status). Nice classes
  // come from internationalClasses[].code, zero-padded to the 3-digit
  // form the schema's multi-select expects.
  const niceClasses: string[] = []
  const gsLines: string[] = []
  for (const g of arr(tm.gsList)) {
    const gr = rec(g)
    const codes = arr(gr.internationalClasses)
      .map((c) => str(rec(c).code))
      .filter((c): c is string => Boolean(c))
      .map((c) => c.padStart(3, "0"))
    for (const c of codes) if (!niceClasses.includes(c)) niceClasses.push(c)
    const text = str(gr.description)
    if (text) gsLines.push(codes[0] ? `IC ${codes[0]}: ${text}` : text)
  }
  niceClasses.sort()

  // Filing basis: current-basis booleans, falling back to filed-as flags
  // for young applications. 66(a) and 44 take display precedence.
  const flag = (k: string) => status[k] === true
  const basis =
    flag("sect66aCurr") || flag("filed66a")
      ? "66a"
      : flag("sect44eCurr") ||
          flag("sect44dCurr") ||
          flag("filed44e") ||
          flag("filed44d")
        ? "44"
        : flag("useCurr") || flag("filedUse")
          ? "1a"
          : flag("ituCurr") || flag("filedItu")
            ? "1b"
            : null

  // §8 (and Madrid §71) acceptance is spelled four ways across cases; a
  // partial acceptance still resets the year-6 deadline.
  const section8Accepted =
    flag("sect8Acpt") ||
    flag("sect8PartialAcpt") ||
    flag("sect71Acpt") ||
    flag("sect71PartialAcpt")

  // markDrawingCd: 1 = typeset words, 2 = design only, 3 = design +
  // words, 4 = standard characters, 5 = stylized, 6 = no drawing.
  const drawingFirst = (str(status.markDrawingCd) ?? "").charAt(0)

  // Principal vs Supplemental register; null = not stated on the record.
  const supplemental =
    typeof status.supplementalRegister === "boolean"
      ? status.supplementalRegister || status.amendSupplemental === true
      : null

  // publication is a sibling of status; the key is absent until the mark
  // is actually published.
  const publication = rec(tm.publication)

  return {
    serial,
    // usRegistrationNumber is "" when not registered — str() nulls it.
    registrationNumber: str(status.usRegistrationNumber),
    wordmark: str(status.markElement),
    markDescription: str(status.descOfMark),
    hasDesignElement: ["2", "3", "5"].includes(drawingFirst),
    statusText: str(status.extStatusDesc),
    tm5StatusDesc: str(status.tm5StatusDesc),
    statusDate: strictIsoDay(status.statusDate, `TSDR ${serial} statusDate`),
    filingDate: strictIsoDay(status.filingDate, `TSDR ${serial} filingDate`),
    registrationDate: strictIsoDay(
      status.usRegistrationDate,
      `TSDR ${serial} usRegistrationDate`
    ),
    publishedDate: strictIsoDay(
      publication.datePublished,
      `TSDR ${serial} datePublished`
    ),
    noticeOfAllowanceDate: strictIsoDay(
      publication.noticeOfAllowanceDate,
      `TSDR ${serial} noticeOfAllowanceDate`
    ),
    dateAbandoned: strictIsoDay(
      status.dateAbandoned,
      `TSDR ${serial} dateAbandoned`
    ),
    dateCancelled: strictIsoDay(
      status.dateCancelled,
      `TSDR ${serial} dateCancelled`
    ),
    basis,
    niceClasses,
    goodsAndServices: gsLines.join("\n") || null,
    section8Accepted,
    register:
      supplemental === null
        ? null
        : supplemental
          ? "Supplemental"
          : "Principal",
    // Madrid IR number: usReference (this case designates an IR) or the
    // intlRegistrationList (this case anchors one).
    irNumber:
      str(rec(tm.usReference).intlRegistrationNum) ??
      str(rec(arr(tm.intlRegistrationList)[0]).registrationNum),
    attorneyDocket: str(status.attrnyDktNumber),
    disclaimer: str(status.disclaimer),
  }
}

async function fetchTsdrCasesBatch(
  serials: string[],
  key: string,
  pace: () => Promise<void>
): Promise<Record<string, UsCase>> {
  const out: Record<string, UsCase> = {}
  for (let i = 0; i < serials.length; i += TSDR_MULTI_STATUS_BATCH) {
    const batch = serials.slice(i, i + TSDR_MULTI_STATUS_BATCH)
    await pace()
    const res = await fetchTsdrWithRedirects(
      TSDR_MULTI_STATUS_URL(batch),
      key,
      pace
    )
    if (!res.ok) {
      throw new Error(
        `TSDR caseMultiStatus ${res.status}: ${await res.text().catch(() => "")}`
      )
    }
    const data = rec(await res.json())
    if (
      !Array.isArray(data.transactionList) ||
      data.transactionList.length === 0
    ) {
      throw new Error(
        `TSDR caseMultiStatus returned no transaction records for batch ${batch.join(",")}`
      )
    }
    const requested = new Set(batch)
    const seen = new Set<string>()
    for (const el of data.transactionList) {
      const er = rec(el)
      const searchId = str(er.searchId) ?? ""
      if (!requested.has(searchId)) {
        throw new Error(
          `TSDR caseMultiStatus returned alien searchId ${JSON.stringify(searchId)} for batch ${batch.join(",")}`
        )
      }
      if (seen.has(searchId)) {
        throw new Error(
          `TSDR caseMultiStatus returned duplicate transaction for ${searchId}`
        )
      }
      seen.add(searchId)
      const c = parseTsdrCase(er, searchId)
      out[c.serial] = c
    }
    const missing = batch.filter((serial) => !seen.has(serial))
    if (missing.length > 0) {
      throw new Error(
        `TSDR caseMultiStatus omitted requested serials: ${missing.join(",")}`
      )
    }
  }
  return out
}

// TSDR wins wherever it has a value — it is same-day authoritative while
// the tmsearch index lags ~1-2 days. Booleans OR together (an acceptance
// seen by either source sticks), and non-empty arrays win.
function mergeTsdrOverlay(base: UsCase, o: UsCase): UsCase {
  return {
    serial: base.serial,
    registrationNumber: o.registrationNumber ?? base.registrationNumber,
    wordmark: o.wordmark ?? base.wordmark,
    markDescription: o.markDescription ?? base.markDescription,
    hasDesignElement: base.hasDesignElement || o.hasDesignElement,
    statusText: o.statusText ?? base.statusText,
    tm5StatusDesc: o.tm5StatusDesc ?? base.tm5StatusDesc,
    statusDate: o.statusDate ?? base.statusDate,
    filingDate: o.filingDate ?? base.filingDate,
    registrationDate: o.registrationDate ?? base.registrationDate,
    publishedDate: o.publishedDate ?? base.publishedDate,
    noticeOfAllowanceDate:
      o.noticeOfAllowanceDate ?? base.noticeOfAllowanceDate,
    dateAbandoned: o.dateAbandoned ?? base.dateAbandoned,
    dateCancelled: o.dateCancelled ?? base.dateCancelled,
    basis: o.basis ?? base.basis,
    niceClasses: o.niceClasses.length > 0 ? o.niceClasses : base.niceClasses,
    goodsAndServices: o.goodsAndServices ?? base.goodsAndServices,
    section8Accepted: base.section8Accepted || o.section8Accepted,
    register: o.register ?? base.register,
    irNumber: o.irNumber ?? base.irNumber,
    attorneyDocket: o.attorneyDocket ?? base.attorneyDocket,
    disclaimer: o.disclaimer ?? base.disclaimer,
  }
}

// ── The adapter ────────────────────────────────────────────────────────

// Fetch every US case for the given owner names. `pace` carries the two
// pacer waits, injected by the caller — sources never import pacers, so
// they stay callable from syncs, probes, and tests alike. `search` runs
// before each tmsearch request, `tsdr` before each TSDR batch.
export async function fetchUsCases(
  ownerNames: string[],
  pace: { search: () => Promise<void>; tsdr: () => Promise<void> }
): Promise<Record<string, UsCase>> {
  // 1. Enumeration + primary case data: one tmsearch query per owner
  // name. Serials are 8 digits; anything else (or a repeat across owner
  // spellings) is dropped.
  const cases: Record<string, UsCase> = {}
  for (const owner of ownerNames) {
    await pace.search()
    const hits = await tmsearchQuery(owner, TMSEARCH_PAGE_SIZE)
    if (hits.length === TMSEARCH_PAGE_SIZE) {
      throw new Error(
        `tmsearch returned a full ${TMSEARCH_PAGE_SIZE}-hit page for "${owner}"; completeness cannot be proven because this undocumented endpoint has no verified stable pagination contract`
      )
    }
    for (const h of hits) {
      const source = rec(h.source)
      const serial = h.id ?? str(source.id) ?? ""
      if (!/^\d{8}$/.test(serial) || cases[serial]) continue
      cases[serial] = projectTmsearchHit(serial, source)
    }
  }
  if (Object.keys(cases).length === 0) {
    // A WAF challenge page or a renamed index surfaces as a well-formed
    // EMPTY result — and an owner with zero marks is not a reachable
    // state for a portfolio this template syncs. Treating it as data
    // would hand the strict backfill an empty row set to mark-and-sweep
    // the whole portfolio with. Throw instead: the resilient delta then
    // serves its last-known-good snapshot.
    throw new Error(
      "tmsearch returned zero hits for all owner names — likely a WAF challenge or endpoint change"
    )
  }

  // 2. Optional keyed overlay — the key is read here, at call time (see
  // tsdrKeyOptional). Since USPTO retired the keyless TM-LUS stamp
  // endpoint (2026-07-30) this is the ONLY source of statusDate, so when
  // a key is configured an overlay failure THROWS — the runner's
  // snapshot serves — rather than degrading to overlay-less rows, which
  // would blank every Status Date (and the OA-response deadlines
  // anchored on it) and re-emit the whole portfolio.
  const serials = Object.keys(cases).sort()
  const key = tsdrKeyOptional()
  if (key) {
    const overlay = await fetchTsdrCasesBatch(serials, key, pace.tsdr)
    for (const sn of serials) {
      const o = overlay[sn]
      if (o) cases[sn] = mergeTsdrOverlay(cases[sn], o)
    }
  }

  return cases
}

// ── Health probes ──────────────────────────────────────────────────────

// Cheapest call that proves tmsearch is reachable AND answering with real
// hits. Zero hits is this endpoint's lying failure mode (see the throw in
// fetchUsCases), so the probe treats it as down too.
export async function probeTmsearch(
  ownerNames: string[],
  pace: () => Promise<void>
): Promise<void> {
  const owner = ownerNames[0]
  if (!owner) throw new Error("no owner names configured")
  await pace()
  const hits = await tmsearchQuery(owner, 1)
  if (hits.length === 0) {
    throw new Error(
      `tmsearch returned zero hits for "${owner}" — likely a WAF challenge or endpoint change`
    )
  }
}

// Proves the TSDR key actually WORKS, not just that the host is up: an
// API-manager key issued for a different USPTO product can pass the
// gateway while the backend rejects every call, so a token-level check
// would lie. The probe takes any serial from the live portfolio —
// hardcoding one would break for adopters whose portfolio doesn't
// contain it — and fetches it through caseMultiStatus, the exact
// endpoint the overlay depends on (a sibling endpoint being up proves
// nothing: USPTO retired last-update while casestatus stayed healthy).
export async function probeTsdrKeyed(
  ownerNames: string[],
  pace: { search: () => Promise<void>; tsdr: () => Promise<void> }
): Promise<void> {
  const key = tsdrKeyOptional()
  if (!key) throw new Error("TSDR_API_KEY env var is not set")
  const owner = ownerNames[0]
  if (!owner) throw new Error("no owner names configured")
  await pace.search()
  const hits = await tmsearchQuery(owner, 1)
  const first = hits[0]
  const serial = first?.id ?? str(rec(first?.source).id) ?? ""
  if (!/^\d{8}$/.test(serial)) {
    throw new Error(`tmsearch returned no usable serial for "${owner}"`)
  }
  const overlay = await fetchTsdrCasesBatch([serial], key, pace.tsdr)
  if (!overlay[serial]?.serial) {
    throw new Error(
      "TSDR caseMultiStatus returned no usable case — key rejected or endpoint down"
    )
  }
}
