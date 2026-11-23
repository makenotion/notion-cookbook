// ──────────────────────────────────────────────────────────────────────
// Prosecution-document retrieval tools (optional)
// ──────────────────────────────────────────────────────────────────────
//
// Two on-demand worker tools:
//   • listProsecutionDocuments  — list a case's file-wrapper documents
//   • attachProsecutionDocumentToPage — fetch one as a full PDF + attach it
//     under a Notion page (uploaded file → titled sub-page).
//
// These are NOT syncs — they run when invoked, so they add no background load.
// Wire them in src/index.ts with registerDocumentTools(worker). Requirements:
//   • USPTO_API_KEY        — US / PCT(WO) documents (USPTO Open Data Portal)
//   • EPO_CONSUMER_KEY/SECRET — EP published-document images (EPO OPS)
//   • NOTION_API_TOKEN     — only for `attach`; Custom Agent calls inject it
//     automatically, while local `ntn workers exec` calls must set it. list
//     needs no Notion token.
//
// Document-source map (each office serves bytes differently — see
// domain-guides/document-retrieval/SKILL.md):
//   US, PCT/WO → USPTO ODP file wrapper (full PDF in one request).
//   EP published application → EPO OPS images (full doc, fetched per-page,
//     merged — fast, our credentialed API).
//   EP file-wrapper docs (office actions, search reports, claims, priority) →
//     EP Register file-inspection. Global Dossier lists them (and supplies the
//     page counts + the doc ids the Register reuses) but its PUBLIC content
//     endpoint only ever returns page 1 — so bytes come from the Register,
//     which is heavily rate-limited and is therefore page-capped here.

import type { Worker } from "@notionhq/workers"
import { j } from "@notionhq/workers/schema-builder"
import { fetchWithTimeout } from "../engine/http.js"
import {
  createPdfSourceByteBudget,
  fetchAndMergePdfPages,
  readBoundedPdfResponse,
  validatePdfBytes,
  type PdfSourceByteBudget,
} from "../engine/pdf.js"
import { OPS_REST, epoToken, invalidateEpoToken } from "../sources/epo.js"

// ── Constants ────────────────────────────────────────────────────────────
const ODP_SEARCH_URL = "https://api.uspto.gov/api/v1/patent/applications/search"
const ODP_DOCS_URL = (appNum: string) =>
  `https://api.uspto.gov/api/v1/patent/applications/${encodeURIComponent(appNum)}/documents`

const NOTION_VERSION = "2026-03-11"
const NOTION_SINGLE_PART_LIMIT = 20 * 1024 * 1024 // 20 MB
const NOTION_FILENAME_MAX_BYTES = 900
const NOTION_TEXT_CONTENT_MAX_CODE_UNITS = 2_000
const PDF_FILENAME_SUFFIX = ".pdf"
const OPS_MAX_DOC_PAGES = 20
// Deliberate headroom under the platform's hard ~60s tool-execution limit for
// cleanup, response serialization, and runtime scheduling overhead.
const TOOL_OPERATION_BUDGET_MS = 55_000
const TOOL_UPSTREAM_REQUEST_LIMIT = 40
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000
const OPS_REQUEST_INTERVAL_MS = 2_000
const US_MAX_REDIRECTS = 5

// Global Dossier — public IP5 file-wrapper aggregator. Used here only to LIST
// EP documents (the JSON doclist gives doc id + page count). Its content
// endpoint is first-page-only, so we never fetch bytes from it for EP.
const GD_PAGE = "https://globaldossier.uspto.gov"
// Global Dossier's public API host (the one the GD web app calls). It's an
// opaque CloudFront name and HAS changed before — if EP listing starts
// 404ing/timing out, re-confirm it from the network tab on globaldossier.uspto.gov.
const GD_API_BASE = "https://d1kazzu6rbodne.cloudfront.net"
const GD_HEADERS: Record<string, string> = {
  Origin: GD_PAGE,
  Referer: `${GD_PAGE}/`,
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
}

// EP Register file-inspection — the only full source for EP file-wrapper docs.
// One page per request via `showPdfPage=N`, keyed by the SAME doc id Global
// Dossier lists. Heavily rate-limited (~1.5-1.8s/page at 4-wide; long runs
// trip a throttle), so concurrency is low and the page count is capped to fit
// the internal 55-second deadline, which leaves headroom under the ~60s
// platform limit — larger docs are refused with a clear message.
const EP_REGISTER_BASE = "https://register.epo.org"
const EP_REGISTER_CONCURRENCY = 4
const EP_REGISTER_MAX_PAGES = 25
const EP_REGISTER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
}
const OPS_IMAGE_CONCURRENCY = 8
const UPSTREAM_ATTEMPTS = 5

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function truncateUtf8Bytes(value: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new Error(`invalid UTF-8 byte limit: ${maxBytes}`)
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
  const result: string[] = []
  let used = 0
  // String iteration yields complete Unicode code points, so a multi-byte
  // character is either retained whole or omitted whole.
  for (const codePoint of value) {
    const bytes = Buffer.byteLength(codePoint, "utf8")
    if (used + bytes > maxBytes) break
    result.push(codePoint)
    used += bytes
  }
  return result.join("")
}

function truncateTextContent(value: string, maxCodeUnits: number): string {
  if (!Number.isSafeInteger(maxCodeUnits) || maxCodeUnits < 0)
    throw new Error(`invalid text-content limit: ${maxCodeUnits}`)
  if (value.length <= maxCodeUnits) return value
  const result: string[] = []
  let used = 0
  // Notion's content limit is expressed in characters; enforcing the stricter
  // UTF-16 length keeps the JSON field <=2,000 under either common counting
  // convention. Iteration prevents slicing between a surrogate pair.
  for (const codePoint of value) {
    if (used + codePoint.length > maxCodeUnits) break
    result.push(codePoint)
    used += codePoint.length
  }
  return result.join("")
}

// worker.pacer is unavailable during tool execution. This module-level gate is
// also awaited by the sync's EPO pacer wrapper in index.ts, so sync and tool
// traffic in the same worker process cannot independently start OPS requests.
let opsPaceTail: Promise<void> = Promise.resolve()
let nextOpsRequestAt = 0
export async function paceDocumentOpsRequest(): Promise<void> {
  const turn = opsPaceTail.then(async () => {
    const delay = Math.max(0, nextOpsRequestAt - Date.now())
    if (delay > 0) await sleep(delay)
    nextOpsRequestAt = Date.now() + OPS_REQUEST_INTERVAL_MS
  })
  opsPaceTail = turn.catch(() => undefined)
  await turn
}

class ToolOperationBudget {
  readonly deadlineMs = Date.now() + TOOL_OPERATION_BUDGET_MS
  private requestCount = 0

  private remainingMs(context: string, minimumMs = 1): number {
    const remaining = this.deadlineMs - Date.now()
    if (remaining < minimumMs)
      throw new Error(
        `${context}: shared ${TOOL_OPERATION_BUDGET_MS}ms tool-operation deadline exhausted`
      )
    return remaining
  }

  async waitForRetry(attempt: number, context: string): Promise<void> {
    if (attempt <= 0) return
    const delay = 500 * 2 ** Math.min(attempt, 4)
    this.remainingMs(context, delay + 1)
    await sleep(delay)
    this.remainingMs(`${context} after retry delay`)
  }

  async beforeOpsAuthentication(context: string): Promise<void> {
    // epoToken owns its fetchWithTimeout call and currently uses its 30-second
    // default. Only start auth when that whole timeout fits within our shared
    // deadline; all other requests receive the exact remaining timeout below.
    await this.beforeRequest(context, true, DEFAULT_UPSTREAM_TIMEOUT_MS)
  }

  async fetch(
    url: string,
    init: RequestInit,
    context: string,
    ops = false
  ): Promise<Response> {
    const timeout = await this.beforeRequest(context, ops)
    return fetchWithTimeout(url, init, timeout)
  }

  assertActive(context: string): void {
    this.remainingMs(context)
  }

  private async beforeRequest(
    context: string,
    ops: boolean,
    minimumMs = 1
  ): Promise<number> {
    if (this.requestCount >= TOOL_UPSTREAM_REQUEST_LIMIT)
      throw new Error(
        `${context}: shared ${TOOL_UPSTREAM_REQUEST_LIMIT}-request tool-operation limit exceeded`
      )
    this.remainingMs(context, minimumMs)
    // Reserve before an awaited pacing turn so concurrent page pumps cannot
    // all observe the same pre-increment count and oversubscribe the cap.
    this.requestCount++
    if (ops) {
      await paceDocumentOpsRequest()
      this.remainingMs(`${context} after OPS pacing`, minimumMs)
    }
    return Math.max(
      1,
      Math.floor(
        Math.min(DEFAULT_UPSTREAM_TIMEOUT_MS, this.remainingMs(context))
      )
    )
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const responseExcerpt = async (response: Response): Promise<string> =>
  (await response.text().catch(() => ""))
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 200)

async function jsonObject(
  response: Response,
  context: string
): Promise<Record<string, unknown>> {
  const text = await response.text().catch(() => "")
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `${context}: malformed JSON (${error instanceof Error ? error.message : String(error)}); response=${text.replace(/[\r\n\t]+/g, " ").slice(0, 200)}`
    )
  }
  if (!isObject(value))
    throw new Error(`${context}: JSON root is not an object`)
  return value
}

async function notionJsonPost(
  path: "file_uploads" | "pages",
  body: Record<string, unknown>,
  token: string,
  operation: ToolOperationBudget,
  context: string
): Promise<Record<string, unknown>> {
  const response = await operation.fetch(
    `https://api.notion.com/v1/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION,
      },
      body: JSON.stringify(body),
    },
    context
  )
  if (!response.ok)
    throw new Error(
      `${context} ${response.status}: ${await responseExcerpt(response)}`
    )
  return jsonObject(response, context)
}

const isPdfContentType = (response: Response): boolean =>
  (response.headers.get("content-type") ?? "")
    .toLowerCase()
    .includes("application/pdf")

const isTransientStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500

function canonicalIsoDate(value: string, context: string): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/.exec(
      value
    )
  if (!match)
    throw new Error(`${context}: invalid date ${JSON.stringify(value)}`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const candidate = new Date(Date.UTC(year, month - 1, day))
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  )
    throw new Error(`${context}: invalid date ${JSON.stringify(value)}`)
  return `${match[1]}-${match[2]}-${match[3]}`
}

// ── Types ──────────────────────────────────────────────────────────────
type Jurisdiction = "US" | "WO" | "EP"
const GD_OFFICES = new Set<Jurisdiction>(["EP"])

type OfficeDoc = {
  jurisdiction: string
  code: string
  date: string | null
  id: string | null
  description: string | null
  pages: number | null
  _fetch:
    | { kind: "us"; downloadUrl: string }
    | { kind: "opsImage"; link: string; pages: number }
    | { kind: "epRegister"; docId: string; appNumber: string; pages: number }
}
type DocInventory = {
  jurisdiction: Jurisdiction
  sourceAppNum: string
  documents: OfficeDoc[]
  note?: string
}
type InventoryError = { error: string; message: string; [k: string]: unknown }
const isInventoryError = (
  x: DocInventory | InventoryError
): x is InventoryError => "error" in x

// ── USPTO ODP (US / WO) ──────────────────────────────────────────────────
type OdpDocument = {
  documentCode?: string
  documentCodeDescriptionText?: string
  documentIdentifier?: string
  officialDate?: string
  downloadOptionBag?: Array<{
    mimeTypeIdentifier?: string
    downloadUrl?: string
  }>
}

async function applicationNumberFromPatentNumber(
  patentNumber: string,
  apiKey: string,
  operation: ToolOperationBudget
): Promise<string | null> {
  const cleaned = patentNumber.replace(/[,\s]/g, "").replace(/^US/i, "")
  if (!/^[A-Z0-9]+$/i.test(cleaned))
    throw new Error(`Invalid US patent number ${JSON.stringify(patentNumber)}`)
  const res = await operation.fetch(
    ODP_SEARCH_URL,
    {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        q: `applicationMetaData.patentNumber:${cleaned}`,
        pagination: { offset: 0, limit: 1 },
      }),
    },
    "USPTO ODP patent-number lookup"
  )
  if (!res.ok)
    throw new Error(
      `USPTO ODP patent-number lookup ${res.status}: ${await responseExcerpt(res)}`
    )
  const data = await jsonObject(res, "USPTO ODP patent-number lookup")
  const bag = data.patentFileWrapperDataBag
  const count = data.count
  if (!Number.isSafeInteger(count) || (count as number) < 0)
    throw new Error("USPTO ODP patent-number lookup: invalid count")
  if (!Array.isArray(bag))
    throw new Error(
      "USPTO ODP patent-number lookup: missing patentFileWrapperDataBag"
    )
  if (bag.length > 1 || bag.length !== Math.min(count as number, 1))
    throw new Error(
      "USPTO ODP patent-number lookup: count/result length mismatch"
    )
  if ((count as number) > 1)
    throw new Error(
      `USPTO ODP patent-number lookup: patent number matched ${count as number} applications`
    )
  if (bag.length === 0) return null
  const first = bag[0]
  if (!isObject(first) || typeof first.applicationNumberText !== "string")
    throw new Error(
      "USPTO ODP patent-number lookup: malformed application result"
    )
  return normalizeUsApplicationNumber(first.applicationNumberText)
}

// ── Global Dossier (EP listing only) ─────────────────────────────────────
type GdMember = {
  countryCode: string
  appNum: string
  kindCode: string | null
  ip5: boolean
}
type GdDoc = {
  docId: string
  docCode: string
  docDesc: string | null
  legalDateStr: string | null
  numberOfPages: number
}

const gdDate = (s: string | null | undefined): string | null => {
  if (s == null) return null
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s)
  if (!m)
    throw new Error(`Global Dossier: invalid legalDateStr ${JSON.stringify(s)}`)
  const month = Number(m[1])
  const day = Number(m[2])
  const year = Number(m[3])
  const candidate = new Date(Date.UTC(year, month - 1, day))
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  )
    throw new Error(`Global Dossier: invalid legalDateStr ${JSON.stringify(s)}`)
  return `${m[3]}-${m[1]}-${m[2]}`
}

async function gdFetchFamily(
  office: string,
  number: string,
  operation: ToolOperationBudget
): Promise<GdMember[]> {
  const url = `${GD_API_BASE}/patent-family/svc/family/application/${office}/${encodeURIComponent(number)}`
  const res = await operation.fetch(
    url,
    { headers: { ...GD_HEADERS, Accept: "application/json" } },
    `Global Dossier family ${office}/${number}`
  )
  if (!res.ok)
    throw new Error(`Global Dossier family ${office}/${number} ${res.status}`)
  const data = await jsonObject(
    res,
    `Global Dossier family ${office}/${number}`
  )
  if (!Array.isArray(data.list))
    throw new Error(`Global Dossier family ${office}/${number}: missing list`)
  return data.list.map((raw, index) => {
    if (!isObject(raw))
      throw new Error(
        `Global Dossier family ${office}/${number}: member ${index} is not an object`
      )
    const { countryCode, appNum, kindCode, ip5 } = raw
    if (
      typeof countryCode !== "string" ||
      !/^[A-Z]{2}$/i.test(countryCode) ||
      typeof appNum !== "string" ||
      appNum.trim() === "" ||
      (kindCode != null &&
        (typeof kindCode !== "string" || !/^[A-Z0-9]+$/i.test(kindCode))) ||
      typeof ip5 !== "boolean"
    )
      throw new Error(
        `Global Dossier family ${office}/${number}: malformed member ${index}`
      )
    return {
      countryCode: countryCode.toUpperCase(),
      appNum,
      kindCode: kindCode ?? null,
      ip5,
    }
  })
}

async function gdFetchDocList(
  country: string,
  number: string,
  kind: string,
  operation: ToolOperationBudget
): Promise<GdDoc[]> {
  if (!/^[A-Z]{2}$/i.test(country) || !/^[A-Z0-9]+$/i.test(kind))
    throw new Error(`Global Dossier doclist: invalid country or kind`)
  const url = `${GD_API_BASE}/doc-list/svc/doclist/${country}/${encodeURIComponent(number)}/${encodeURIComponent(kind)}`
  const res = await operation.fetch(
    url,
    { headers: { ...GD_HEADERS, Accept: "application/json" } },
    `Global Dossier doclist ${country}/${number}`
  )
  if (!res.ok)
    throw new Error(`Global Dossier doclist ${country}/${number} ${res.status}`)
  const data = await jsonObject(
    res,
    `Global Dossier doclist ${country}/${number}`
  )
  if (!Array.isArray(data.docs))
    throw new Error(`Global Dossier doclist ${country}/${number}: missing docs`)
  return data.docs.map((raw, index) => {
    if (!isObject(raw))
      throw new Error(
        `Global Dossier doclist ${country}/${number}: document ${index} is not an object`
      )
    const description = raw.docCodeDesc ?? raw.docDesc ?? null
    if (
      typeof raw.docId !== "string" ||
      raw.docId.trim() === "" ||
      typeof raw.docCode !== "string" ||
      raw.docCode.trim() === "" ||
      (description != null && typeof description !== "string") ||
      (raw.legalDateStr != null && typeof raw.legalDateStr !== "string") ||
      !Number.isSafeInteger(raw.numberOfPages) ||
      (raw.numberOfPages as number) < 1
    )
      throw new Error(
        `Global Dossier doclist ${country}/${number}: malformed document ${index}`
      )
    // Parse now so a malformed date fails the inventory atomically instead of
    // being surfaced as an opaque sort key later.
    gdDate(raw.legalDateStr as string | null)
    return {
      docId: raw.docId,
      docCode: raw.docCode,
      docDesc: description,
      legalDateStr: (raw.legalDateStr as string | null) ?? null,
      numberOfPages: raw.numberOfPages as number,
    }
  })
}

// ── EPO OPS images (EP published application — full doc) ──────────────────
const opsText = (value: unknown): string | null => {
  if (typeof value === "string" || typeof value === "number")
    return String(value)
  return isObject(value) &&
    (typeof value.$ === "string" || typeof value.$ === "number")
    ? String(value.$)
    : null
}

const opsArray = (value: unknown): unknown[] =>
  value == null ? [] : Array.isArray(value) ? value : [value]

function epApplicationKey(value: string): string | null {
  const cleaned = value.trim().toUpperCase()
  const original = /^(?:EP)?(\d{8})(?:\.\d)?$/.exec(cleaned)
  if (original) return original[1]
  const epodoc = /^(?:EP)?((?:19|20)\d{9})$/.exec(cleaned)
  if (epodoc) {
    const expanded = epodoc[1]
    const serial = expanded.slice(4)
    if (!serial.startsWith("0")) return null
    return `${expanded.slice(2, 4)}${serial.slice(1)}`
  }
  return null
}

function epApplicationEpodoc(value: string): string | null {
  const key = epApplicationKey(value)
  if (!key) return null
  const yy = Number(key.slice(0, 2))
  const century = yy >= 78 ? "19" : "20"
  return `EP${century}${key.slice(0, 2)}0${key.slice(2)}`
}

function opsDocumentIds(
  reference: unknown,
  context: string
): Record<string, unknown>[] {
  if (!isObject(reference)) throw new Error(`${context}: malformed reference`)
  const raw = reference["document-id"]
  if (raw == null) throw new Error(`${context}: missing document-id`)
  return opsArray(raw).map((item, index) => {
    if (!isObject(item))
      throw new Error(`${context}: malformed document-id ${index}`)
    return item
  })
}

async function opsJsonGet(
  path: string,
  context: string,
  operation: ToolOperationBudget
): Promise<Record<string, unknown> | null> {
  let refreshed401 = false
  for (let attempt = 0; attempt < UPSTREAM_ATTEMPTS; attempt++) {
    await operation.waitForRetry(attempt, context)
    const token = await epoToken(() =>
      operation.beforeOpsAuthentication(`${context} authentication`)
    )
    operation.assertActive(`${context} authentication`)
    const response = await operation.fetch(
      `${OPS_REST}${path}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      },
      context,
      true
    )
    if (response.status === 404) return null
    if (response.status === 401 && !refreshed401) {
      refreshed401 = true
      invalidateEpoToken(token)
      continue
    }
    if (isTransientStatus(response.status)) continue
    if (!response.ok)
      throw new Error(
        `${context} ${response.status}: ${await responseExcerpt(response)}`
      )
    const contentType = response.headers.get("content-type") ?? ""
    if (!contentType.toLowerCase().includes("json")) {
      if (attempt + 1 < UPSTREAM_ATTEMPTS) continue
      throw new Error(
        `${context}: expected JSON, received ${contentType || "unknown"}`
      )
    }
    return jsonObject(response, context)
  }
  throw new Error(`${context}: upstream remained unavailable after retries`)
}

function opsExchangeDocuments(
  root: Record<string, unknown>,
  context: string
): Record<string, unknown>[] {
  const world = root["ops:world-patent-data"]
  if (!isObject(world))
    throw new Error(`${context}: missing ops:world-patent-data`)
  const exchange = world["exchange-documents"]
  if (!isObject(exchange))
    throw new Error(`${context}: missing exchange-documents`)
  const raw = exchange["exchange-document"]
  if (raw == null) throw new Error(`${context}: missing exchange-document`)
  return opsArray(raw).map((item, index) => {
    if (!isObject(item))
      throw new Error(`${context}: malformed exchange-document ${index}`)
    return item
  })
}

type OpsPublication = { num: string; kind: "A1" | "A2" }

function opsPublishedApplications(
  root: Record<string, unknown>,
  requestedApplication: string
): OpsPublication[] {
  const context = `OPS biblio for ${requestedApplication}`
  const requestedKey = epApplicationKey(requestedApplication)
  if (!requestedKey)
    throw new Error(`${context}: invalid EP application number`)
  const candidates = new Map<string, OpsPublication>()
  let matchedApplication = false

  for (const document of opsExchangeDocuments(root, context)) {
    const bib = document["bibliographic-data"]
    if (!isObject(bib))
      throw new Error(`${context}: missing bibliographic-data`)
    const appRef = bib["application-reference"]
    const applicationMatches = opsDocumentIds(appRef, context).some(
      (id, index) => {
        const idType = id["@document-id-type"]
        if (
          typeof idType !== "string" ||
          !["docdb", "epodoc", "original"].includes(idType)
        )
          throw new Error(
            `${context}: unsupported application document-id type at ${index}`
          )
        const country = opsText(id.country)
        if (country != null && country.toUpperCase() !== "EP") return false
        const number = opsText(id["doc-number"])
        if (number == null)
          throw new Error(
            `${context}: application document-id ${index} is missing doc-number`
          )
        const key = epApplicationKey(number)
        if (!key) {
          if (country?.toUpperCase() === "EP" || /^EP/i.test(number))
            throw new Error(
              `${context}: malformed EP application identity ${JSON.stringify(number)}`
            )
          return false
        }
        return key === requestedKey
      }
    )
    if (!applicationMatches) continue
    matchedApplication = true

    const publicationRef = bib["publication-reference"]
    for (const id of opsDocumentIds(publicationRef, context)) {
      if (id["@document-id-type"] !== "docdb") continue
      const country = (opsText(id.country) ?? "").toUpperCase()
      const num = opsText(id["doc-number"])
      const kind = (opsText(id.kind) ?? "").toUpperCase()
      if (country !== "EP" || !num || (kind !== "A1" && kind !== "A2")) continue
      if (!/^\d+$/.test(num))
        throw new Error(`${context}: malformed EP publication number`)
      if (
        (typeof document["@country"] === "string" &&
          document["@country"] !== country) ||
        (typeof document["@doc-number"] === "string" &&
          document["@doc-number"] !== num) ||
        (typeof document["@kind"] === "string" && document["@kind"] !== kind)
      )
        throw new Error(`${context}: publication identity mismatch`)
      candidates.set(`${num}.${kind}`, { num, kind })
    }
  }
  if (!matchedApplication)
    throw new Error(
      `${context}: response does not match the requested application`
    )
  const ordered = [...candidates.values()].sort(
    (a, b) => (a.kind === "A1" ? 0 : 1) - (b.kind === "A1" ? 0 : 1)
  )
  const preferredKind = ordered[0]?.kind
  if (
    preferredKind &&
    ordered.filter((item) => item.kind === preferredKind).length > 1
  )
    throw new Error(
      `${context}: multiple ${preferredKind} publications matched`
    )
  return ordered
}

function opsFullDocument(
  root: Record<string, unknown>,
  publication: OpsPublication
): { link: string; pages: number } | null {
  const context = `OPS images for EP${publication.num}.${publication.kind}`
  const world = root["ops:world-patent-data"]
  if (!isObject(world))
    throw new Error(`${context}: missing ops:world-patent-data`)
  const inquiry = world["ops:document-inquiry"]
  if (!isObject(inquiry))
    throw new Error(`${context}: missing ops:document-inquiry`)
  const result = inquiry["ops:inquiry-result"]
  if (!isObject(result))
    throw new Error(`${context}: missing ops:inquiry-result`)
  const ref =
    result["publication-reference"] ?? result["ops:publication-reference"]
  const identityMatches = opsDocumentIds(ref, context).some((id) => {
    return (
      id["@document-id-type"] === "docdb" &&
      (opsText(id.country) ?? "").toUpperCase() === "EP" &&
      opsText(id["doc-number"]) === publication.num &&
      (opsText(id.kind) ?? "").toUpperCase() === publication.kind
    )
  })
  if (!identityMatches)
    throw new Error(`${context}: publication identity mismatch`)

  const instances = opsArray(result["ops:document-instance"])
  if (instances.length === 0) return null
  const expectedLink = `EP/${publication.num}/${publication.kind}/fullimage`
  const full: Array<{ link: string; pages: number }> = []
  for (const [index, raw] of instances.entries()) {
    if (!isObject(raw))
      throw new Error(`${context}: malformed document-instance ${index}`)
    const link = raw["@link"]
    const desc = raw["@desc"]
    const rawPages = raw["@number-of-pages"]
    const pages =
      typeof rawPages === "number"
        ? rawPages
        : typeof rawPages === "string" && /^\d+$/.test(rawPages)
          ? Number(rawPages)
          : Number.NaN
    if (
      typeof link !== "string" ||
      typeof desc !== "string" ||
      !Number.isSafeInteger(pages) ||
      pages < 1
    )
      throw new Error(`${context}: malformed document-instance ${index}`)
    if (desc === "FullDocument") {
      if (link !== expectedLink)
        throw new Error(`${context}: unsafe or mismatched image link ${link}`)
      full.push({ link, pages })
    }
  }
  if (full.length > 1)
    throw new Error(`${context}: multiple FullDocument image instances`)
  return full[0] ?? null
}

// EP application number → its A1/A2 published-application image. References
// are read only from the response's direct bibliography nodes; recursive scans
// can accidentally select a cited, related, or granted (B-kind) publication.
async function opsResolveFullDocument(
  epAppNum: string,
  operation: ToolOperationBudget
): Promise<{ link: string; pages: number } | null> {
  const epodoc = epApplicationEpodoc(epAppNum)
  if (!epodoc) throw new Error(`Invalid EP application number ${epAppNum}`)
  const biblio = await opsJsonGet(
    `/published-data/application/epodoc/${epodoc}/biblio`,
    `OPS biblio for ${epodoc}`,
    operation
  )
  if (!biblio) return null
  const publications = opsPublishedApplications(biblio, epAppNum)
  const publication = publications[0]
  if (!publication) return null
  const images = await opsJsonGet(
    `/published-data/publication/docdb/EP.${publication.num}.${publication.kind}/images`,
    `OPS images for EP${publication.num}.${publication.kind}`,
    operation
  )
  return images ? opsFullDocument(images, publication) : null
}

async function opsFetchImagePage(
  link: string,
  pageNum: number,
  total: number,
  operation: ToolOperationBudget,
  byteBudget: PdfSourceByteBudget
): Promise<Uint8Array> {
  if (!/^EP\/\d+\/A[12]\/fullimage$/.test(link))
    throw new Error(`OPS image: unsafe image link ${link}`)
  let refreshed401 = false
  for (let attempt = 0; attempt < UPSTREAM_ATTEMPTS; attempt++) {
    const context = `OPS image ${link} page ${pageNum}/${total}`
    await operation.waitForRetry(attempt, context)
    const token = await epoToken(() =>
      operation.beforeOpsAuthentication(`${context} authentication`)
    )
    operation.assertActive(`${context} authentication`)
    const res = await operation.fetch(
      `${OPS_REST}/published-data/images/${link}.pdf`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/pdf",
          "X-OPS-Range": String(pageNum),
        },
      },
      context,
      true
    )
    if (res.status === 401 && !refreshed401) {
      refreshed401 = true
      invalidateEpoToken(token)
      await res.body?.cancel().catch(() => undefined)
      continue
    }
    if (isTransientStatus(res.status)) {
      await res.body?.cancel().catch(() => undefined)
      continue
    }
    if (!res.ok)
      throw new Error(
        `OPS image ${link} page ${pageNum}/${total} ${res.status}`
      )
    if (!isPdfContentType(res)) {
      await res.body?.cancel().catch(() => undefined)
      continue
    }
    const body = await readBoundedPdfResponse(res, byteBudget, context)
    try {
      await validatePdfBytes(body.bytes, context, 1)
      return body.bytes
    } catch {
      body.release()
      // OPS throttles can return a 200 HTML body. Retry all non-PDF/malformed
      // page bodies before failing the document atomically.
      continue
    }
  }
  throw new Error(
    `OPS image ${link} page ${pageNum}/${total} unavailable after retries`
  )
}

const opsDownloadFullPdf = (
  link: string,
  pages: number,
  operation: ToolOperationBudget
): Promise<Buffer> => {
  if (!Number.isSafeInteger(pages) || pages < 1)
    throw new Error(`OPS image ${link}: invalid page count ${pages}`)
  if (pages > OPS_MAX_DOC_PAGES)
    throw new Error(
      `OPS image ${link}: ${pages} pages exceeds the ${OPS_MAX_DOC_PAGES}-page tool limit`
    )
  const byteBudget = createPdfSourceByteBudget(NOTION_SINGLE_PART_LIMIT)
  return fetchAndMergePdfPages(
    pages,
    OPS_IMAGE_CONCURRENCY,
    (page) => opsFetchImagePage(link, page, pages, operation, byteBudget),
    NOTION_SINGLE_PART_LIMIT
  )
}

// ── EP Register file-inspection (EP file-wrapper docs — full doc) ─────────
async function epRegisterFetchPage(
  docId: string,
  appNumber: string,
  pageNum: number,
  total: number,
  operation: ToolOperationBudget,
  byteBudget: PdfSourceByteBudget
): Promise<Uint8Array> {
  const refParams = new URLSearchParams({
    documentId: docId,
    number: `EP${appNumber}`,
    lng: "en",
    npl: "false",
  })
  const pageParams = new URLSearchParams({
    showPdfPage: String(pageNum),
    documentId: docId,
    appnumber: `EP${appNumber}`,
    proc: "",
  })
  const ref = `${EP_REGISTER_BASE}/application?${refParams}`
  const url = `${EP_REGISTER_BASE}/application?${pageParams}`
  for (let attempt = 0; attempt < UPSTREAM_ATTEMPTS; attempt++) {
    const context = `EP Register ${docId} page ${pageNum}/${total}`
    await operation.waitForRetry(attempt, context)
    const res = await operation.fetch(
      url,
      {
        headers: {
          ...EP_REGISTER_HEADERS,
          Referer: ref,
          Accept: "application/pdf",
        },
      },
      context
    )
    if (isTransientStatus(res.status)) {
      await res.body?.cancel().catch(() => undefined)
      continue
    }
    if (!res.ok)
      throw new Error(
        `EP Register ${docId} page ${pageNum}/${total} ${res.status}`
      )
    // A throttle/expiry can return an HTML notice with a 200 — never stitch
    // a non-PDF page into the document.
    if (!isPdfContentType(res)) {
      await res.body?.cancel().catch(() => undefined)
      continue
    }
    const body = await readBoundedPdfResponse(res, byteBudget, context)
    try {
      await validatePdfBytes(body.bytes, context, 1)
      return body.bytes
    } catch {
      body.release()
      continue
    }
  }
  throw new Error(
    `EP Register ${docId} page ${pageNum}/${total} unavailable after retries`
  )
}

const epRegisterDownloadPdf = (
  docId: string,
  appNumber: string,
  pages: number,
  operation: ToolOperationBudget
): Promise<Buffer> => {
  const byteBudget = createPdfSourceByteBudget(NOTION_SINGLE_PART_LIMIT)
  return fetchAndMergePdfPages(
    pages,
    EP_REGISTER_CONCURRENCY,
    (p) =>
      epRegisterFetchPage(docId, appNumber, p, pages, operation, byteBudget),
    NOTION_SINGLE_PART_LIMIT
  )
}

const isRedirectStatus = (status: number): boolean =>
  status === 301 ||
  status === 302 ||
  status === 303 ||
  status === 307 ||
  status === 308

const isUsptoApiOrigin = (url: URL): boolean =>
  url.origin === "https://api.uspto.gov" && url.port === ""

function safeUsDownloadUrl(value: string, context: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${context}: invalid redirect URL`)
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error(
      `${context}: download redirects must use credential-free HTTPS URLs`
    )
  return url
}

async function fetchUsDownloadResponse(
  downloadUrl: string,
  apiKey: string,
  operation: ToolOperationBudget
): Promise<Response> {
  let current = safeUsDownloadUrl(downloadUrl, "USPTO document download")
  for (let redirects = 0; ; redirects++) {
    const headers: Record<string, string> = { Accept: "application/pdf" }
    // Recompute this per hop. The key authenticates the exact ODP API origin;
    // it is not a general credential for storage hosts or other USPTO
    // subdomains and must not follow a redirect to either.
    if (isUsptoApiOrigin(current)) headers["X-API-KEY"] = apiKey
    const response = await operation.fetch(
      current.toString(),
      { headers, redirect: "manual" },
      `USPTO document download ${current.hostname}`
    )
    if (!isRedirectStatus(response.status)) return response
    await response.body?.cancel().catch(() => undefined)
    if (redirects >= US_MAX_REDIRECTS)
      throw new Error(
        `USPTO document download exceeded ${US_MAX_REDIRECTS} redirects`
      )
    const location = response.headers.get("location")
    if (!location)
      throw new Error("USPTO document download redirect omitted Location")
    current = safeUsDownloadUrl(
      new URL(location, current).toString(),
      "USPTO document download"
    )
  }
}

async function usDownloadPdf(
  downloadUrl: string,
  apiKey: string,
  operation: ToolOperationBudget
): Promise<Buffer> {
  const byteBudget = createPdfSourceByteBudget(NOTION_SINGLE_PART_LIMIT)
  for (let attempt = 0; attempt < UPSTREAM_ATTEMPTS; attempt++) {
    await operation.waitForRetry(attempt, "USPTO document download")
    const response = await fetchUsDownloadResponse(
      downloadUrl,
      apiKey,
      operation
    )
    if (isTransientStatus(response.status)) {
      await response.body?.cancel().catch(() => undefined)
      continue
    }
    if (!response.ok)
      throw new Error(
        `USPTO document download ${response.status}: ${await responseExcerpt(response)}`
      )
    if (!isPdfContentType(response)) {
      if (attempt + 1 < UPSTREAM_ATTEMPTS) {
        await response.body?.cancel().catch(() => undefined)
        continue
      }
      throw new Error(
        `USPTO document download: expected application/pdf, received ${response.headers.get("content-type") ?? "unknown"}`
      )
    }
    const body = await readBoundedPdfResponse(
      response,
      byteBudget,
      "USPTO document download"
    )
    const bytes = Buffer.from(body.bytes)
    try {
      await validatePdfBytes(bytes, "USPTO document download")
      return bytes
    } catch (error) {
      body.release()
      if (attempt + 1 >= UPSTREAM_ATTEMPTS) throw error
    }
  }
  throw new Error("USPTO document download remained unavailable after retries")
}

// ── Routing helpers ──────────────────────────────────────────────────────
function detectJurisdiction(idRaw: string): Jurisdiction {
  const s = idRaw.trim().toUpperCase()
  if (/^(PCT|WO)/.test(s)) return "WO"
  if (s.startsWith("EP")) return "EP"
  return "US"
}
function explicitJurisdiction(idRaw: string): Jurisdiction | null {
  const value = idRaw.trim().toUpperCase()
  if (/^(PCT|WO)/.test(value)) return "WO"
  if (value.startsWith("EP")) return "EP"
  if (value.startsWith("US")) return "US"
  return null
}

function normalizeUsApplicationNumber(value: string): string {
  const digits = value
    .trim()
    .toUpperCase()
    .replace(/^US/, "")
    .replace(/[\s,/.-]/g, "")
  if (!/^\d{8}$/.test(digits))
    throw new Error(
      `US application number must resolve to exactly 8 digits; received ${JSON.stringify(value)}`
    )
  return digits
}

function normalizeDirectEpApplicationNumber(value: string): string {
  const match = /^EP(\d{8})(?:\.(\d))?$/i.exec(
    value.trim().replace(/[\s,]/g, "")
  )
  if (!match)
    throw new Error(
      `Direct EP application number must be EP followed by 8 digits and an optional check digit; received ${JSON.stringify(value)}`
    )
  if (match[2]) {
    const sum = [...match[1]].reduce((total, digit, index) => {
      const product = Number(digit) * (index % 2 === 0 ? 1 : 2)
      return total + Math.floor(product / 10) + (product % 10)
    }, 0)
    const expected = String((10 - (sum % 10)) % 10)
    if (match[2] !== expected)
      throw new Error(
        `Direct EP application number has an invalid check digit; expected .${expected}`
      )
  }
  return match[1]
}
// Strip an office prefix and a trailing ".N" check digit so a foreign number
// ("EP1234567" or "1234567.8") matches Global Dossier's bare form.
const gdNormalizeNumber = (s: string): string =>
  s
    .trim()
    .replace(/[,\s]/g, "")
    .replace(/^[A-Z]{2}/i, "")
    .replace(/\.\d$/, "")

const normalizeNotionId = (raw: string): string | null => {
  const m = /[0-9a-f]{32}/i.exec(raw.replace(/-/g, ""))
  return m ? m[0] : null
}

async function buildDocInventory(opts: {
  jurisdiction: Jurisdiction
  applicationNumber: string | null
  patentNumber: string | null
  usptoKey: string | null
  operation: ToolOperationBudget
}): Promise<DocInventory | InventoryError> {
  const { jurisdiction, applicationNumber, patentNumber, usptoKey, operation } =
    opts

  // US + WO → USPTO ODP file wrapper (PCT docs land here because filing is at
  // RO/US). Full PDFs, one request each.
  if (jurisdiction === "US" || jurisdiction === "WO") {
    if (!usptoKey)
      return {
        error: "missing_uspto_key",
        message: "USPTO_API_KEY env var is required for US and WO documents.",
      }
    const appNum =
      (applicationNumber
        ? normalizeUsApplicationNumber(applicationNumber)
        : null) ??
      (patentNumber
        ? await applicationNumberFromPatentNumber(
            patentNumber,
            usptoKey,
            operation
          )
        : null)
    if (!appNum)
      return {
        error: "not_found",
        message: `No US application found for ${patentNumber ?? "(no identifier)"}.`,
      }
    const res = await operation.fetch(
      ODP_DOCS_URL(appNum),
      { headers: { "X-API-KEY": usptoKey } },
      `USPTO ODP documents ${appNum}`
    )
    if (!res.ok)
      return {
        error: "list_fetch_failed",
        message: `USPTO ODP documents ${res.status}.`,
        applicationNumber: appNum,
      }
    const data = await jsonObject(res, `USPTO ODP documents ${appNum}`)
    if (!Array.isArray(data.documentBag))
      throw new Error(`USPTO ODP documents ${appNum}: missing documentBag`)
    if (!Number.isSafeInteger(data.count) || (data.count as number) < 0)
      throw new Error(`USPTO ODP documents ${appNum}: invalid count`)
    if (data.documentBag.length !== data.count)
      throw new Error(
        `USPTO ODP documents ${appNum}: count/result length mismatch`
      )
    const documents = data.documentBag
      .map((d): OfficeDoc | null => {
        if (!isObject(d))
          throw new Error(`USPTO ODP documents ${appNum}: malformed document`)
        const typed = d as OdpDocument
        for (const [field, value] of [
          ["documentCode", typed.documentCode],
          ["documentCodeDescriptionText", typed.documentCodeDescriptionText],
          ["documentIdentifier", typed.documentIdentifier],
          ["officialDate", typed.officialDate],
        ] as const) {
          if (value != null && typeof value !== "string")
            throw new Error(`USPTO ODP documents ${appNum}: malformed ${field}`)
        }
        const officialDate = typed.officialDate
          ? canonicalIsoDate(
              typed.officialDate,
              `USPTO ODP documents ${appNum} officialDate`
            )
          : null
        if (
          typed.downloadOptionBag != null &&
          !Array.isArray(typed.downloadOptionBag)
        )
          throw new Error(
            `USPTO ODP documents ${appNum}: malformed downloadOptionBag`
          )
        for (const option of typed.downloadOptionBag ?? []) {
          if (
            !isObject(option) ||
            (option.mimeTypeIdentifier != null &&
              typeof option.mimeTypeIdentifier !== "string") ||
            (option.downloadUrl != null &&
              typeof option.downloadUrl !== "string")
          )
            throw new Error(
              `USPTO ODP documents ${appNum}: malformed download option`
            )
        }
        const pdfOption = typed.downloadOptionBag?.find((o) =>
          ["PDF", "APPLICATION/PDF"].includes(
            o.mimeTypeIdentifier?.toUpperCase() ?? ""
          )
        )
        const url = pdfOption?.downloadUrl
        if (pdfOption && !url)
          throw new Error(
            `USPTO ODP documents ${appNum}: PDF option is missing downloadUrl`
          )
        if (!url) return null
        if (!typed.documentCode?.trim() || !typed.documentIdentifier?.trim())
          throw new Error(
            `USPTO ODP documents ${appNum}: PDF document is missing code or identifier`
          )
        let parsed: URL
        try {
          parsed = new URL(url)
        } catch {
          throw new Error(
            `USPTO ODP documents ${appNum}: malformed downloadUrl`
          )
        }
        if (parsed.protocol !== "https:")
          throw new Error(
            `USPTO ODP documents ${appNum}: downloadUrl must use HTTPS`
          )
        return {
          jurisdiction,
          code: typed.documentCode ?? "",
          date: officialDate,
          id: typed.documentIdentifier ?? null,
          description: typed.documentCodeDescriptionText ?? null,
          pages: null,
          _fetch: { kind: "us", downloadUrl: url },
        }
      })
      .filter((d): d is OfficeDoc => d !== null)
      .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    return { jurisdiction, sourceAppNum: appNum, documents }
  }

  // EP → list via Global Dossier (traverse the family from the US app), fetch
  // bytes from OPS (published app) or the EP Register (everything else).
  if (!GD_OFFICES.has(jurisdiction)) {
    return {
      error: "unsupported_jurisdiction",
      message: `Document retrieval is not implemented for ${jurisdiction}.`,
    }
  }
  try {
    const directEp = Boolean(
      applicationNumber && /^\s*EP/i.test(applicationNumber)
    )
    const startOffice = patentNumber || !directEp ? "US" : "EP"
    const startNumber = patentNumber
      ? usptoKey
        ? await applicationNumberFromPatentNumber(
            patentNumber,
            usptoKey,
            operation
          )
        : null
      : directEp
        ? normalizeDirectEpApplicationNumber(applicationNumber ?? "")
        : normalizeUsApplicationNumber(applicationNumber ?? "")
    if (patentNumber && !usptoKey)
      return {
        error: "missing_uspto_key",
        message:
          "USPTO_API_KEY env var is required when an EP family lookup starts from a US patent number.",
      }
    if (!startNumber)
      return {
        error: "missing_identifier",
        message:
          "Provide a US applicationNumber/patentNumber (family is traversed) or the EP application number.",
      }

    const family = await gdFetchFamily(startOffice, startNumber, operation)
    const epMembers = family.filter((m) => m.countryCode === jurisdiction)
    const membersByNumber = new Map(
      epMembers.map((member) => {
        const number = gdNormalizeNumber(member.appNum)
        if (!/^\d{8}$/.test(number))
          throw new Error(
            `Global Dossier family: malformed EP application number ${JSON.stringify(member.appNum)}`
          )
        return [number, member]
      })
    )
    const candidates = [...membersByNumber.values()]
    const member =
      startOffice === "EP"
        ? membersByNumber.get(gdNormalizeNumber(startNumber))
        : candidates.length === 1
          ? candidates[0]
          : undefined
    if (startOffice === "US" && candidates.length > 1)
      return {
        error: "ambiguous_ep_family",
        message:
          "The US family contains multiple EP applications. Repeat the request with the exact EP-prefixed applicationNumber.",
        applicationNumbers: candidates.map((candidate) => candidate.appNum),
      }
    if (!member)
      return {
        jurisdiction,
        sourceAppNum: startNumber,
        documents: [],
        note: `No ${jurisdiction} family member found for ${startOffice} ${startNumber}.`,
      }
    if (!member.ip5)
      return {
        jurisdiction,
        sourceAppNum: member.appNum,
        documents: [],
        note: `${jurisdiction} member ${member.appNum} contributes no file-wrapper documents.`,
      }

    const gdDocs = await gdFetchDocList(
      member.countryCode,
      member.appNum,
      member.kindCode ?? "A",
      operation
    )
    const documents: OfficeDoc[] = gdDocs
      .map((d) => ({
        jurisdiction: member.countryCode,
        code: d.docCode,
        date: gdDate(d.legalDateStr),
        id: d.docId,
        description: d.docDesc,
        pages: d.numberOfPages,
        // Bytes come from the EP Register (Global Dossier serves only page 1).
        _fetch: {
          kind: "epRegister" as const,
          docId: d.docId,
          appNumber: member.appNum,
          pages: d.numberOfPages,
        },
      }))
      .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))

    // Route the published application (pamphlet) to the fast OPS images path
    // instead of the rate-limited Register. OPS is optional, but when
    // credentials are configured malformed/error responses fail closed rather
    // than being mistaken for a clean enrichment miss.
    const pamphletIndex = documents.findIndex((d) => /PAMPHLET/i.test(d.code))
    const hasEpoKey = Boolean(process.env.EPO_CONSUMER_KEY)
    const hasEpoSecret = Boolean(process.env.EPO_CONSUMER_SECRET)
    if (pamphletIndex >= 0 && hasEpoKey !== hasEpoSecret)
      throw new Error(
        "EPO_CONSUMER_KEY and EPO_CONSUMER_SECRET must be configured together"
      )
    if (pamphletIndex >= 0 && hasEpoKey && hasEpoSecret) {
      const full = await opsResolveFullDocument(member.appNum, operation)
      if (full) {
        const fetchDesc = {
          kind: "opsImage" as const,
          link: full.link,
          pages: full.pages,
        }
        documents[pamphletIndex] = {
          ...documents[pamphletIndex],
          pages: full.pages,
          description: `${documents[pamphletIndex].description ?? "Published application"} (full ${full.pages}-page document via EPO OPS)`,
          _fetch: fetchDesc,
        }
      }
    }

    return { jurisdiction, sourceAppNum: member.appNum, documents }
  } catch (err) {
    return {
      error: "ep_lookup_failed",
      message: `EP document lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

// ── Tool registration ────────────────────────────────────────────────────
export function registerDocumentTools(worker: Worker): void {
  worker.tool("listProsecutionDocuments", {
    title: "List Prosecution Documents",
    description:
      "List prosecution-history documents for exactly one patent application identifier in US, PCT/WO, or EP, newest-first. Each entry has documentCode, documentDate (YYYY-MM-DD), documentIdentifier (pass to attachProsecutionDocumentToPage), description, and pages. Set `jurisdiction` (default US). US & WO/PCT come from the USPTO file wrapper — for WO pass the related 8-digit US applicationNumber or US patentNumber. For EP, pass a bare/formatted 8-digit US applicationNumber or US patentNumber to traverse the family; a direct EP lookup must use an exact EP-prefixed application number (e.g. 'EP03789660.2'). Always call this before attach to get exact identifiers.",
    schema: j.object({
      applicationNumber: j
        .string()
        .describe(
          "Application number. For US/WO use the 8-digit US app number (e.g. '12/345,678'). For EP, a bare/formatted 8-digit number is a US family anchor; a direct EP lookup must use the exact EP-prefixed number (e.g. 'EP03789660.2'). Cannot be combined with patentNumber."
        )
        .nullable(),
      patentNumber: j
        .string()
        .describe(
          "US granted patent number (e.g. '11234567'). Resolves to the US application; for EP it's the family-traversal start. Provide this OR applicationNumber."
        )
        .nullable(),
      jurisdiction: j
        .enum("US", "WO", "EP")
        .describe(
          "Office whose documents to list. Defaults to US (or inferred from the applicationNumber prefix)."
        )
        .nullable(),
    }),
    execute: async (input) => {
      const usptoKey = process.env.USPTO_API_KEY ?? null
      const { applicationNumber, patentNumber } = input
      if (Boolean(applicationNumber) === Boolean(patentNumber)) {
        return {
          error: "invalid_identifier_choice",
          message: "Provide exactly one of applicationNumber or patentNumber.",
        } as never
      }
      const jurisdiction: Jurisdiction =
        (input.jurisdiction as Jurisdiction | null) ??
        (applicationNumber ? detectJurisdiction(applicationNumber) : "US")
      const prefix = applicationNumber
        ? explicitJurisdiction(applicationNumber)
        : null
      if (prefix && prefix !== jurisdiction) {
        return {
          error: "jurisdiction_identifier_conflict",
          message: `applicationNumber is ${prefix}-prefixed but jurisdiction is ${jurisdiction}.`,
        } as never
      }
      const operation = new ToolOperationBudget()
      const inv = await buildDocInventory({
        jurisdiction,
        applicationNumber,
        patentNumber,
        usptoKey,
        operation,
      })
      if (isInventoryError(inv)) return inv as never
      return {
        jurisdiction: inv.jurisdiction,
        applicationNumber: inv.sourceAppNum,
        count: inv.documents.length,
        ...(inv.note && { note: inv.note }),
        documents: inv.documents.map((d) => ({
          documentCode: d.code || null,
          documentDate: d.date,
          documentIdentifier: d.id,
          description: d.description,
          pages: d.pages,
          jurisdiction: d.jurisdiction,
        })),
      } as never
    },
  })

  worker.tool("attachProsecutionDocumentToPage", {
    title: "Attach Prosecution Document to Page",
    description:
      "Fetch a prosecution-history document (US, PCT/WO, or EP) as a full PDF and attach it as a hosted sub-page under a Notion page. Resolves via the same source as listProsecutionDocuments — ALWAYS call that first to get the exact documentIdentifier. Picks by documentIdentifier (preferred) or documentCode (+ optional documentDate). Uses NOTION_API_TOKEN (injected for Custom Agent calls; set it for local execution). EP Register documents over 25 pages and OPS published applications over 20 pages are refused rather than silently truncated.",
    schema: j.object({
      applicationNumber: j
        .string()
        .describe(
          "US/WO: the 8-digit US app number. EP: a bare/formatted US app family anchor or the exact EP-prefixed application number. Provide exactly this OR patentNumber."
        )
        .nullable(),
      patentNumber: j
        .string()
        .describe(
          "US granted patent number. Provide this OR applicationNumber."
        )
        .nullable(),
      jurisdiction: j
        .enum("US", "WO", "EP")
        .describe(
          "Office the document belongs to. Must match what listProsecutionDocuments used."
        )
        .nullable(),
      documentCode: j
        .string()
        .describe(
          "Document code from listProsecutionDocuments. Optional if documentIdentifier is given."
        )
        .nullable(),
      documentDate: j
        .string()
        .describe(
          "YYYY-MM-DD; attach a specific historical version. If null, the newest matching document is used."
        )
        .nullable(),
      documentIdentifier: j
        .string()
        .describe(
          "Exact documentIdentifier from listProsecutionDocuments. Takes precedence over documentDate."
        )
        .nullable(),
      pageId: j
        .string()
        .describe(
          "Notion page ID (or full page URL) to attach the document under."
        ),
      blockType: j
        .enum("pdf", "file")
        .describe(
          "'pdf' renders inline (default); 'file' shows as a downloadable attachment."
        )
        .nullable(),
    }),
    execute: async (input) => {
      const usptoKey = process.env.USPTO_API_KEY ?? null
      const { applicationNumber, patentNumber, documentCode, documentDate } =
        input
      const blockType = input.blockType ?? "pdf"
      if (Boolean(applicationNumber) === Boolean(patentNumber)) {
        return {
          error: "invalid_identifier_choice",
          message: "Provide exactly one of applicationNumber or patentNumber.",
        } as never
      }
      const normalizedPageId = normalizeNotionId(input.pageId ?? "")
      if (!normalizedPageId) {
        return {
          error: "invalid_page_id",
          message: "pageId must be a Notion page ID (32-hex) or a page URL.",
          received: input.pageId,
        } as never
      }
      if (documentDate) {
        try {
          if (canonicalIsoDate(documentDate, "documentDate") !== documentDate)
            throw new Error("timestamp is not allowed")
        } catch {
          return {
            error: "invalid_document_date",
            message: "documentDate must be a valid YYYY-MM-DD calendar date.",
          } as never
        }
      }
      const jurisdiction: Jurisdiction =
        (input.jurisdiction as Jurisdiction | null) ??
        (applicationNumber ? detectJurisdiction(applicationNumber) : "US")
      const prefix = applicationNumber
        ? explicitJurisdiction(applicationNumber)
        : null
      if (prefix && prefix !== jurisdiction) {
        return {
          error: "jurisdiction_identifier_conflict",
          message: `applicationNumber is ${prefix}-prefixed but jurisdiction is ${jurisdiction}.`,
        } as never
      }
      const notionToken = process.env.NOTION_API_TOKEN
      if (!notionToken) {
        return {
          error: "missing_notion_token",
          message:
            "NOTION_API_TOKEN is not set. Custom Agent calls inject it automatically; for local execution, set NOTION_API_TOKEN to a connection token with access to the target page.",
        } as never
      }

      const operation = new ToolOperationBudget()
      const inv = await buildDocInventory({
        jurisdiction,
        applicationNumber,
        patentNumber,
        usptoKey,
        operation,
      })
      if (isInventoryError(inv)) return inv as never
      if (inv.documents.length === 0) {
        return {
          error: "no_documents",
          jurisdiction: inv.jurisdiction,
          applicationNumber: inv.sourceAppNum,
          ...(inv.note && { message: inv.note }),
        } as never
      }
      if (!input.documentIdentifier && !documentCode) {
        return {
          error: "missing_document_selector",
          message:
            "Provide documentIdentifier from listProsecutionDocuments, or documentCode (plus documentDate when needed).",
        } as never
      }

      // Select the target: documentIdentifier wins; otherwise code plus an
      // optional date selects the newest matching code.
      const codeMatches = documentCode
        ? inv.documents.filter((d) => d.code === documentCode)
        : inv.documents
      let target: OfficeDoc | undefined
      if (input.documentIdentifier) {
        target = inv.documents.find((d) => d.id === input.documentIdentifier)
        if (!target) {
          return {
            error: "no_matching_document_for_identifier",
            availableIdentifiers: codeMatches
              .map((d) => ({ documentIdentifier: d.id, documentDate: d.date }))
              .filter((x) => Boolean(x.documentIdentifier)),
          } as never
        }
      } else if (documentDate) {
        const dateMatches = codeMatches.filter((d) => d.date === documentDate)
        if (dateMatches.length === 0)
          return {
            error: "no_matching_document_for_date",
            availableDates: codeMatches.map((d) => d.date).filter(Boolean),
          } as never
        if (dateMatches.length > 1) {
          return {
            error: "multiple_matches_for_date",
            message: `${dateMatches.length} documents share that date. Call once per documentIdentifier.`,
            documentIdentifiers: dateMatches
              .map((d) => d.id)
              .filter((x): x is string => Boolean(x)),
          } as never
        }
        target = dateMatches[0]
      } else {
        target = codeMatches[0]
      }
      if (!target) {
        return {
          error: "no_matching_document",
          availableCodes: Array.from(
            new Set(inv.documents.map((d) => d.code).filter(Boolean))
          ),
        } as never
      }

      // Bound all Notion text fields before creating or sending an upload.
      // Preserve the useful application/date portions and the required .pdf
      // suffix; only the upstream-controlled code/description is truncated.
      const docDate = target.date ?? "undated"
      const safeCode = (target.code || "DOC").replace(/[^A-Za-z0-9._-]/g, "_")
      const filenamePrefix = `${inv.sourceAppNum}-`
      const filenameSuffix = `-${docDate}${PDF_FILENAME_SUFFIX}`
      const fixedFilenameBytes = Buffer.byteLength(
        `${filenamePrefix}${filenameSuffix}`,
        "utf8"
      )
      if (fixedFilenameBytes > NOTION_FILENAME_MAX_BYTES)
        throw new Error("validated document identifiers exceed filename limit")
      const filename = `${filenamePrefix}${truncateUtf8Bytes(
        safeCode,
        NOTION_FILENAME_MAX_BYTES - fixedFilenameBytes
      )}${filenameSuffix}`

      const titleLabel = target.description ?? target.code
      const titleSuffix = docDate === "undated" ? "" : ` — ${docDate}`
      const title = `${truncateTextContent(
        titleLabel,
        NOTION_TEXT_CONTENT_MAX_CODE_UNITS - titleSuffix.length
      )}${titleSuffix}`

      // Fetch the PDF bytes per source.
      let pdfBuffer: Buffer
      try {
        if (target._fetch.kind === "us") {
          if (!usptoKey)
            return {
              error: "missing_uspto_key",
              message: "USPTO_API_KEY env var is required for this document.",
            } as never
          pdfBuffer = await usDownloadPdf(
            target._fetch.downloadUrl,
            usptoKey,
            operation
          )
        } else if (target._fetch.kind === "opsImage") {
          if (target._fetch.pages > OPS_MAX_DOC_PAGES) {
            return {
              error: "document_too_large_for_ops",
              pages: target._fetch.pages,
              maxPages: OPS_MAX_DOC_PAGES,
              message: `This published application has ${target._fetch.pages} pages, above the ${OPS_MAX_DOC_PAGES}-page OPS tool limit. It was not truncated.`,
            } as never
          }
          pdfBuffer = await opsDownloadFullPdf(
            target._fetch.link,
            target._fetch.pages,
            operation
          )
        } else {
          if (target._fetch.pages > EP_REGISTER_MAX_PAGES) {
            return {
              error: "document_too_large_for_ep_register",
              pages: target._fetch.pages,
              maxPages: EP_REGISTER_MAX_PAGES,
              message: `This EP document has ${target._fetch.pages} pages. The EP Register serves one rate-limited page per request, so documents over ${EP_REGISTER_MAX_PAGES} pages can't be retrieved within the tool time limit. (Large priority documents are also in the related US/WO file wrapper — call with jurisdiction "WO".)`,
            } as never
          }
          pdfBuffer = await epRegisterDownloadPdf(
            target._fetch.docId,
            target._fetch.appNumber,
            target._fetch.pages,
            operation
          )
        }
      } catch (err) {
        return {
          error: "pdf_fetch_failed",
          message: err instanceof Error ? err.message : String(err),
        } as never
      }

      if (pdfBuffer.length > NOTION_SINGLE_PART_LIMIT) {
        return {
          error: "pdf_too_large_for_single_part",
          bytes: pdfBuffer.length,
          limitBytes: NOTION_SINGLE_PART_LIMIT,
          message: "Exceeds Notion's 20 MB single-part upload limit.",
        } as never
      }

      // 1. Create the file_upload. Use the same token as the managed client,
      // but send this through our bounded fetch so the SDK's independent
      // 60-second timeout/retries cannot outlive the tool operation.
      const created = (await notionJsonPost(
        "file_uploads",
        {
          mode: "single_part",
          filename,
          content_type: "application/pdf",
        },
        notionToken,
        operation,
        "Notion file upload creation"
      )) as {
        id?: string
        upload_url?: string
        object?: string
        status?: string
        code?: string
        message?: string
      }
      if (
        created.object !== "file_upload" ||
        created.status !== "pending" ||
        !created.id ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          created.id
        ) ||
        !created.upload_url
      ) {
        return {
          error: "file_upload_create_failed",
          code: created.code ?? null,
          message: created.message ?? null,
        } as never
      }
      let uploadUrl: URL
      try {
        uploadUrl = new URL(created.upload_url)
      } catch {
        return {
          error: "file_upload_create_failed",
          message: "Notion returned an invalid upload_url.",
        } as never
      }
      if (
        uploadUrl.origin !== "https://api.notion.com" ||
        uploadUrl.port !== "" ||
        uploadUrl.username !== "" ||
        uploadUrl.password !== "" ||
        uploadUrl.search !== "" ||
        uploadUrl.hash !== "" ||
        uploadUrl.pathname !==
          `/v1/file_uploads/${encodeURIComponent(created.id)}/send`
      )
        return {
          error: "file_upload_create_failed",
          message: "Notion returned an unexpected upload_url.",
        } as never

      // 2. Send the bytes with the same bounded raw-fetch path so the upload
      // cannot outlive the shared operation deadline; let fetch set the
      // multipart boundary.
      const form = new FormData()
      form.append(
        "file",
        new Blob([new Uint8Array(pdfBuffer)], { type: "application/pdf" }),
        filename
      )
      let sendRes: Response
      try {
        sendRes = await operation.fetch(
          uploadUrl.toString(),
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${notionToken}`,
              "Notion-Version": NOTION_VERSION,
            },
            body: form,
          },
          "Notion file upload"
        )
      } catch (error) {
        return {
          error: "upload_send_failed",
          message: error instanceof Error ? error.message : String(error),
        } as never
      }
      if (!sendRes.ok)
        return {
          error: "upload_send_failed",
          status: sendRes.status,
          message: await sendRes.text().catch(() => ""),
        } as never
      let sent: Record<string, unknown>
      try {
        sent = await jsonObject(sendRes, "Notion file upload")
      } catch (error) {
        return {
          error: "upload_send_failed",
          message: error instanceof Error ? error.message : String(error),
        } as never
      }
      if (
        sent.object !== "file_upload" ||
        sent.id !== created.id ||
        sent.status !== "uploaded"
      )
        return {
          error: "upload_send_failed",
          message: "Notion did not confirm the uploaded file.",
        } as never

      // 3. Create a sub-page holding the PDF (sub-pages survive sync re-emits).
      const block =
        blockType === "pdf"
          ? {
              type: "pdf",
              pdf: { type: "file_upload", file_upload: { id: created.id } },
            }
          : {
              type: "file",
              file: {
                type: "file_upload",
                file_upload: { id: created.id },
                name: filename,
              },
            }
      const createRes = (await notionJsonPost(
        "pages",
        {
          parent: { page_id: normalizedPageId },
          properties: { title: { title: [{ text: { content: title } }] } },
          children: [block],
        },
        notionToken,
        operation,
        "Notion sub-page creation"
      )) as {
        id?: string
        url?: string
        object?: string
        code?: string
        message?: string
      }
      if (createRes.object !== "page" || !createRes.id) {
        return {
          error: "subpage_create_failed",
          code: createRes.code ?? null,
          message: createRes.message ?? null,
        } as never
      }

      return {
        ok: true,
        jurisdiction: inv.jurisdiction,
        documentCode: target.code,
        documentDate: target.date,
        pages: target.pages,
        bytes: pdfBuffer.length,
        subPageId: createRes.id,
        subPageUrl: createRes.url ?? null,
      } as never
    },
  })
}
