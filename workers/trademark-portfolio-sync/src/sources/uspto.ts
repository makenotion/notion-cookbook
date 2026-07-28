// ──────────────────────────────────────────────────────────────────────
// USPTO adapter (live, keyless-first)
// ──────────────────────────────────────────────────────────────────────
//
// Discovers US marks by owner name and normalizes them to UsCase. Three
// endpoints, layered by trust:
//
//   1. tmsearch.uspto.gov — the undocumented Elasticsearch proxy behind
//      the TESS-successor search UI. ONE owner query returns the full
//      case record for every mark (status, dates, classes, goods &
//      services, basis, affidavits) with NO API key — this is what lets
//      the template deploy before any key paperwork clears. The index
//      lags case changes by ~1-2 days.
//   2. TSDR last-update (keyless) — real-time per-case change stamps.
//      Their status-date component supplies UsCase.statusDate, which
//      tmsearch simply doesn't carry.
//   3. TSDR caseMultiStatus (optional, TSDR_API_KEY) — the authoritative
//      same-day record, merged over the tmsearch baseline field by
//      field. Enrichment, never row-defining: when the keyed overlay
//      fails, the keyless baseline still ships (with a warning).
//
// Both keyless backends are unofficial and WAF-fronted; a WAF can decide
// to block datacenter egress at any time. Every response is therefore
// treated defensively, and the one failure mode that could silently
// destroy the portfolio — a challenge page that parses as a valid EMPTY
// result — is converted into a loud throw (see fetchUsCases).

import { fetchWithTimeout } from "../engine/http.js"
import type { UsCase } from "./types.js"

// ── Endpoints ──────────────────────────────────────────────────────────

const TMSEARCH_URL = "https://tmsearch.uspto.gov/prod-v1-0-0/tmsearch"

// TSDR's API host. The human-facing site (tsdr.uspto.gov, no "api") is a
// different host that serves pages and images, not JSON.
const TSDR_BASE = "https://tsdrapi.uspto.gov"
const TSDR_LAST_UPDATE_URL = (serials: string[]) =>
  `${TSDR_BASE}/last-update/info.json?sn=${serials.join(",")}`
// Batch case status. Envelope (verified live):
//   { transactionList: [{ trademarks: […], searchId: "<serial>" }], … }
// — each element is the same shape the per-case info.json returns.
const TSDR_MULTI_STATUS_URL = (serials: string[]) =>
  `${TSDR_BASE}/ts/cd/caseMultiStatus/sn?ids=${serials.join(",")}`
const TSDR_STATUS_URL = (serial: string) =>
  `${TSDR_BASE}/ts/cd/casestatus/sn${serial}/info.json`

// Serials per TSDR batch call (last-update and caseMultiStatus alike).
// TSDR throttles aggressively ("Max transaction limit reached per user"):
// one call per serial trips its 429 on the very first full refresh, while
// batches of 20 keep a whole mid-sized portfolio at ~2 requests/endpoint.
const TSDR_LUS_BATCH = 20

// tmsearch page size — one page comfortably covers a company portfolio.
// EXTEND: if an owner name legitimately returns more marks, raise it (the
// backend is an Elasticsearch proxy; `size` is its page size).
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
// Dates arrive as "YYYY-MM-DD" or with time/zone suffixes; keep the day.
const day = (v: unknown): string | null => {
  const s = str(v)
  if (!s) return null
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s)
  return m ? m[1] : null
}

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
  return data.hits?.hits ?? []
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
    // tmsearch has no status-date field — the TM-LUS stamp fills this in
    // fetchUsCases, and the keyed overlay refines it further.
    statusDate: null,
    filingDate: day(src.filedDate),
    registrationDate: day(src.registrationDate),
    publishedDate: day(src.publishForOppositionDate),
    noticeOfAllowanceDate: null, // TSDR-only field
    dateAbandoned: day(src.abandonDate),
    dateCancelled: day(src.cancelDate),
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

// ── TSDR last-update stamps (keyless) ──────────────────────────────────

// Per-case lastModifiedDate stamps for status, prosecution, and document
// activity — this endpoint answers WITHOUT an API key (the header rides
// along when one is configured). Only the status component is kept: the
// date the case status last changed, i.e. the keyless answer to the
// Status Date column.
async function fetchLastUpdateStamps(
  serials: string[],
  pace: () => Promise<void>
): Promise<Record<string, string | null>> {
  const stamps: Record<string, string | null> = {}
  for (let i = 0; i < serials.length; i += TSDR_LUS_BATCH) {
    const batch = serials.slice(i, i + TSDR_LUS_BATCH)
    await pace()
    const res = await fetchWithTimeout(TSDR_LAST_UPDATE_URL(batch), {
      headers: {
        "USPTO-API-KEY": tsdrKeyOptional() ?? "",
        Accept: "application/json",
      },
    })
    if (!res.ok) {
      throw new Error(
        `TSDR last-update ${res.status}: ${await res.text().catch(() => "")}`
      )
    }
    const data = rec(await res.json())
    const infos = arr(data.caseUpdateInfo)
    for (let k = 0; k < infos.length; k++) {
      const info = rec(infos[k])
      // Verified live shape: { caseData: {…}, name: "Serial Number",
      // value: "12345678" } — the serial arrives in the `value` field,
      // with positional fallback to the batch order.
      const serial = str(info.value) ?? str(info.serialNumber) ?? batch[k] ?? ""
      const statusDate = day(
        rec(rec(info.caseData).caseStatusData).lastModifiedDate
      )
      if (serial) stamps[serial] = statusDate
    }
  }
  return stamps
}

// ── TSDR case-status overlay (optional, keyed) ─────────────────────────

// Reduce one casestatus / caseMultiStatus case to UsCase. ALL TSDR path
// knowledge lives in this function, so a payload-format surprise
// localizes here instead of scattering across the adapter.
function parseTsdrCase(raw: unknown, fallbackSerial: string): UsCase {
  const root = rec(raw)
  const tm = rec(arr(root.trademarks)[0])
  const status = rec(tm.status)

  // serialNumber is a NUMBER in the payload; str() stringifies it.
  const serial = str(status.serialNumber) ?? fallbackSerial

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
    statusDate: day(status.statusDate),
    filingDate: day(status.filingDate),
    registrationDate: day(status.usRegistrationDate),
    publishedDate: day(publication.datePublished),
    noticeOfAllowanceDate: day(publication.noticeOfAllowanceDate),
    dateAbandoned: day(status.dateAbandoned),
    dateCancelled: day(status.dateCancelled),
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
  for (let i = 0; i < serials.length; i += TSDR_LUS_BATCH) {
    const batch = serials.slice(i, i + TSDR_LUS_BATCH)
    await pace()
    const res = await fetchWithTimeout(TSDR_MULTI_STATUS_URL(batch), {
      headers: { "USPTO-API-KEY": key, Accept: "application/json" },
    })
    if (!res.ok) {
      throw new Error(
        `TSDR caseMultiStatus ${res.status}: ${await res.text().catch(() => "")}`
      )
    }
    const data = rec(await res.json())
    // A serial the response omits (its "missedElements") is simply absent
    // from the returned map — that row keeps its keyless baseline.
    for (const el of arr(data.transactionList)) {
      const er = rec(el)
      const c = parseTsdrCase(er, str(er.searchId) ?? "")
      if (c.serial) out[c.serial] = c
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
    for (const h of await tmsearchQuery(owner, TMSEARCH_PAGE_SIZE)) {
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

  // 2. TM-LUS status dates (keyless). A total failure throws — the
  // runner's snapshot serves — rather than degrading to stamp-less rows,
  // which would blank every Status Date and re-emit the whole portfolio.
  const serials = Object.keys(cases).sort()
  const stamps = await fetchLastUpdateStamps(serials, pace.tsdr)
  for (const sn of serials) {
    const stamp = stamps[sn]
    if (stamp) cases[sn].statusDate = stamp
  }

  // 3. Optional keyed overlay — the key is read here, at call time (see
  // tsdrKeyOptional). Overlay failures degrade to the keyless baseline
  // with a warning: the overlay refines rows, it never defines them, so
  // losing it must never cost the cycle.
  const key = tsdrKeyOptional()
  if (key) {
    try {
      const overlay = await fetchTsdrCasesBatch(serials, key, pace.tsdr)
      for (const sn of serials) {
        const o = overlay[sn]
        if (o) cases[sn] = mergeTsdrOverlay(cases[sn], o)
      }
    } catch (err) {
      console.warn(
        `[uspto] TSDR overlay unavailable this cycle — serving the keyless baseline: ${
          err instanceof Error ? err.message : err
        }`
      )
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
// contain it — and fetches its full case status with the key.
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
  await pace.tsdr()
  const res = await fetchWithTimeout(TSDR_STATUS_URL(serial), {
    headers: { "USPTO-API-KEY": key, Accept: "application/json" },
  })
  if (!res.ok) {
    throw new Error(
      `TSDR casestatus ${res.status}: key rejected or endpoint down`
    )
  }
  const parsed = parseTsdrCase(await res.json(), "")
  if (!parsed.serial) {
    throw new Error("TSDR casestatus returned an unparseable payload")
  }
}
