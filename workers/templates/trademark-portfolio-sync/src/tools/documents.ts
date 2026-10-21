// ──────────────────────────────────────────────────────────────────────
// Trademark document + mark-image tools (optional)
// ──────────────────────────────────────────────────────────────────────
//
// Three on-demand worker tools:
//   • listTrademarkDocuments — list a US case's file-wrapper documents
//     (office actions, responses, specimens, certificates) from TSDR.
//   • attachTrademarkDocumentToPage — fetch one as a PDF and attach it
//     under a Notion page (uploaded file → titled sub-page).
//   • refreshMarkImages — download + validate each row's mark image, then
//     upload it into a "Mark Image" files property and the page icon.
//
// These are NOT syncs — they run only when invoked, so they add no
// background load. Wire them in src/index.ts with
// registerDocumentTools(worker). Requirements:
//   • TSDR_API_KEY — list + attach (the file-wrapper endpoints are keyed;
//     everything else in this template stays keyless without it).
//   • NOTION_API_TOKEN — attach + refreshMarkImages (the multipart byte
//     upload; the bundled SDK client can't do multipart).
//
// Tools cannot use worker.pacer — pacer handles only exist inside the
// sync runtime — so politeness is structural instead: attach moves ONE
// document per call against TSDR's separate 4/min PDF budget, and
// refreshMarkImages processes a bounded batch per call. Self-contained by
// design: the few TSDR fetch helpers below are duplicated from
// src/sources/uspto.ts rather than imported, so a tool tweak can never
// destabilize the sync path (and vice versa).

import type { Worker } from "@notionhq/workers"
import { j } from "@notionhq/workers/schema-builder"
import { config } from "../config.js"
import { strictIsoDay } from "../engine/date.js"
import { fetchWithTimeout } from "../engine/http.js"

// ── Constants ──────────────────────────────────────────────────────────

// TSDR's API host. tsdr.uspto.gov (no "api") is the human-facing site —
// its keyless /img endpoint is what refreshMarkImages reads.
const TSDR_BASE = "https://tsdrapi.uspto.gov"
const TSDR_DOCS_LIST_URL = (serial: string) =>
  `${TSDR_BASE}/ts/cd/casedocs/bundle.xml?sn=${serial}`
// Single-document download ("casedoc", singular). documentId is DERIVED —
// {DocumentTypeCode}{ScanDateTime → yyyyMMddHHmmss} — because bundle.xml
// carries no identifier element at all (see parseDocsBundle).
const TSDR_DOC_PDF_URL = (serial: string, documentId: string) =>
  `${TSDR_BASE}/ts/cd/casedoc/sn${serial}/${encodeURIComponent(documentId)}/download.pdf`
const TSDR_IMAGE_URL = (serial: string) =>
  `https://tsdr.uspto.gov/img/${serial}/large`
// TMview mark thumbnail — present for every ST13 (it renders the word for
// word marks), which is what foreign rows key on.
const TMVIEW_IMAGE_URL = (st13: string) =>
  `https://www.tmdn.org/tmview/api/trademark/thumbnail/${st13}`

// file_uploads and data_sources use the current multi-source API surface.
const NOTION_VERSION = "2026-03-11"
const NOTION_SINGLE_PART_LIMIT = 20 * 1024 * 1024 // 20 MB
const MAX_TSDR_REDIRECTS = 5
const MAX_ATTACH_CHILD_PAGES = 5
const ATTACH_OPERATION_BUDGET_MS = 55_000
const DEFAULT_ATTACH_REQUEST_TIMEOUT_MS = 30_000

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

export class AttachOperationDeadlineError extends Error {
  constructor(context: string) {
    super(
      `${context}: shared ${ATTACH_OPERATION_BUDGET_MS}ms attachment-operation deadline exhausted`
    )
    this.name = "AttachOperationDeadlineError"
  }
}

// One budget is created at the very start of each attach invocation and passed
// through every network/sleep path. The injectable clock is intentionally tiny:
// private regression tests can prove composed retries stay inside 55 seconds
// without waiting on wall-clock timers, while production uses Date.now/sleep.
export class AttachOperationBudget {
  readonly deadlineMs: number

  constructor(
    readonly limitMs = ATTACH_OPERATION_BUDGET_MS,
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number) => Promise<void> = sleep
  ) {
    if (!Number.isSafeInteger(limitMs) || limitMs <= 0)
      throw new Error(`operation budget must be a positive integer: ${limitMs}`)
    this.deadlineMs = this.now() + limitMs
  }

  remainingMs(context: string): number {
    const remaining = this.deadlineMs - this.now()
    if (!Number.isFinite(remaining) || remaining <= 0)
      throw new AttachOperationDeadlineError(context)
    return remaining
  }

  assertActive(context: string): void {
    this.remainingMs(context)
  }

  async fetch(
    url: string,
    init: RequestInit,
    context: string,
    preferredTimeoutMs = DEFAULT_ATTACH_REQUEST_TIMEOUT_MS
  ): Promise<Response> {
    const timeoutMs = Math.max(
      1,
      Math.floor(Math.min(preferredTimeoutMs, this.remainingMs(context)))
    )
    const response = await fetchWithTimeout(url, init, timeoutMs)
    this.assertActive(`${context} response`)
    return response
  }

  // Returning false lets the caller emit a structured retryAfter response.
  // We never start a delay that can reach or cross the operation deadline.
  async waitForRetry(delayMs: number, context: string): Promise<boolean> {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0)
      throw new Error(`retry delay must be a non-negative integer: ${delayMs}`)
    if (delayMs + 1 > this.remainingMs(context)) return false
    await this.wait(delayMs)
    this.assertActive(`${context} after retry delay`)
    return true
  }
}

// ── Small helpers (deliberately duplicated — see the header) ───────────

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
// Read at CALL time, never module scope: env is injected per run, so a
// key set via `ntn workers env set` works on the very next invocation
// with no redeploy.
function tsdrKey(): string {
  const key = process.env.TSDR_API_KEY
  if (!key) {
    throw new Error(
      "TSDR_API_KEY env var is not set. The portfolio sync runs fully without it (tmsearch supplies the case data); the key only enables file-wrapper document retrieval and same-day TSDR enrichment. Request one at https://account.uspto.gov/api-manager/ — note that a key issued for a different USPTO product can pass the gateway yet fail every TSDR call."
    )
  }
  return key
}

const isRedirectStatus = (status: number): boolean =>
  status === 301 ||
  status === 302 ||
  status === 303 ||
  status === 307 ||
  status === 308

const isTsdrApiOrigin = (url: URL): boolean =>
  url.origin === TSDR_BASE && url.port === ""

function safeDownloadUrl(value: string, context: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${context}: invalid redirect URL`)
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${context}: redirects must use credential-free HTTPS URLs`)
  }
  return url
}

// Follow redirects manually and recompute credentials for every hop. Fetch's
// automatic redirect logic strips standard Authorization, but custom headers
// such as USPTO-API-KEY are forwarded cross-origin by Node's fetch.
async function fetchTsdrWithRedirects(
  downloadUrl: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
  operation?: AttachOperationBudget,
  context = "TSDR request"
): Promise<Response> {
  let current = safeDownloadUrl(downloadUrl, "TSDR request")
  for (let redirects = 0; ; redirects++) {
    const headers = new Headers(init.headers)
    headers.delete("USPTO-API-KEY")
    if (isTsdrApiOrigin(current)) headers.set("USPTO-API-KEY", tsdrKey())
    const requestInit = { ...init, headers, redirect: "manual" } as RequestInit
    const response = operation
      ? await operation.fetch(
          current.toString(),
          requestInit,
          `${context} redirect hop ${redirects + 1}`,
          timeoutMs
        )
      : await fetchWithTimeout(current.toString(), requestInit, timeoutMs)
    if (!isRedirectStatus(response.status)) return response
    await response.body?.cancel().catch(() => undefined)
    if (redirects >= MAX_TSDR_REDIRECTS) {
      throw new Error(`TSDR request exceeded ${MAX_TSDR_REDIRECTS} redirects`)
    }
    const location = response.headers.get("location")
    if (!location) throw new Error("TSDR redirect omitted Location")
    current = safeDownloadUrl(
      new URL(location, current).toString(),
      "TSDR request"
    )
  }
}

// Accepts a bare Notion ID (with or without dashes) or a full page URL.
const normalizeNotionId = (raw: string): string | null => {
  const m = /[0-9a-f]{32}/i.exec(raw.replace(/-/g, ""))
  return m ? m[0] : null
}

const exactUuid = (raw: string): string | null => {
  if (
    !/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(
      raw
    )
  ) {
    return null
  }
  const bare = raw.replace(/-/g, "")
  return /^[0-9a-f]{32}$/i.test(bare) ? bare.toLowerCase() : null
}

function validatedNotionUploadUrl(raw: string, createdId: string): URL | null {
  const expectedId = exactUuid(createdId)
  if (!expectedId) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const pathMatch = /^\/v1\/file_uploads\/([^/]+)\/send$/.exec(url.pathname)
  let pathId: string | null = null
  if (pathMatch) {
    try {
      pathId = exactUuid(decodeURIComponent(pathMatch[1]))
    } catch {
      return null
    }
  }
  if (
    url.origin !== "https://api.notion.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    pathId !== expectedId
  ) {
    return null
  }
  return url
}

// The tool-context Notion client (structural: only .request is used).
type NotionClient = {
  request(opts: {
    path: string
    method: string
    body?: unknown
  }): Promise<unknown>
}

type NotionJsonResponse = {
  ok: boolean
  status: number
  body: AnyRec
}

async function attachNotionJsonRequest(
  operation: AttachOperationBudget,
  notionToken: string,
  path: string,
  method: "GET" | "POST",
  context: string,
  body?: Record<string, unknown>
): Promise<NotionJsonResponse> {
  const response = await operation.fetch(
    `https://api.notion.com/v1/${path}`,
    {
      method,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${notionToken}`,
        "Notion-Version": NOTION_VERSION,
        ...(body && { "Content-Type": "application/json" }),
      },
      ...(body && { body: JSON.stringify(body) }),
    },
    context
  )
  const text = await response.text()
  operation.assertActive(`${context} body`)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(
      `${context}: Notion returned malformed JSON (HTTP ${response.status})`
    )
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${context}: Notion JSON root is not an object`)
  return { ok: response.ok, status: response.status, body: rec(parsed) }
}

// One single-part file upload: create (JSON via the managed client) +
// send bytes (multipart via raw fetch — the bundled SDK can't do
// multipart, and fetch must set the boundary itself). Returns the
// file_upload id or a reason. An upload can be ATTACHED ONLY ONCE, so a
// files-property value and a page icon each need their own upload of the
// same bytes.
async function uploadToNotion(
  notion: NotionClient,
  notionToken: string,
  buffer: Buffer,
  filename: string,
  mime: string
): Promise<{ id: string } | { error: string }> {
  // The dev-surface API can return HTTP 200 with { object: "error" } —
  // always check the object field rather than trusting the transport.
  const created = (await notion.request({
    path: "file_uploads",
    method: "post",
    body: { mode: "single_part", filename, content_type: mime },
  })) as { id?: string; upload_url?: string; object?: string; message?: string }
  if (created.object === "error" || !created.id || !created.upload_url) {
    return {
      error: `file_upload create failed: ${created.message ?? "unknown"}`,
    }
  }
  const uploadUrl = validatedNotionUploadUrl(created.upload_url, created.id)
  if (!uploadUrl) {
    return { error: "file_upload create returned an unexpected upload_url" }
  }
  const form = new FormData()
  form.append(
    "file",
    new Blob([new Uint8Array(buffer)], { type: mime }),
    filename
  )
  let sendRes: Response
  try {
    sendRes = await fetchWithTimeout(uploadUrl.toString(), {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${notionToken}`,
        "Notion-Version": NOTION_VERSION,
      },
      body: form,
    })
  } catch (err) {
    return {
      error: `upload send failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!sendRes.ok)
    return { error: `upload send failed: HTTP ${sendRes.status}` }
  return { id: created.id }
}

// ── TSDR file-wrapper listing ──────────────────────────────────────────

type TsdrDoc = {
  id: string
  code: string | null
  description: string | null
  date: string | null // YYYY-MM-DD (mail date, falling back to scan date)
  pages: number | null
}

// bundle.xml (namespace urn:us:gov:doc:uspto:trademark, no prefixes)
// wraps each document in a repeated <Document> element; a tiny regex
// extractor avoids an XML-parser dependency. Live structure:
//   <DocumentTypeCode>NOA</DocumentTypeCode>
//   <DocumentTypeCodeDescriptionText>Notice of Abandonment</…>
//   <MailRoomDate>2007-09-25-04:00</MailRoomDate>
//   <ScanDateTime>2007-09-26T10:06:13.000-04:00</ScanDateTime>
//   <TotalPageQuantity>1</TotalPageQuantity>
// There is NO identifier element — the single-document endpoint addresses
// a document as {DocumentTypeCode}{ScanDateTime → yyyyMMddHHmmss}, so the
// id is derived here from those two fields.
function parseDocsBundle(xml: string): TsdrDoc[] {
  const docs: TsdrDoc[] = []
  const docBlocks = xml.match(/<Document>[\s\S]*?<\/Document>/g) ?? []
  const tag = (block: string, name: string): string | null => {
    const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)
    return m ? m[1].trim() : null
  }
  for (const block of docBlocks) {
    const code = tag(block, "DocumentTypeCode")
    const scan = tag(block, "ScanDateTime")
    if (!code || !scan) continue
    const scanDigits = scan.slice(0, 19).replace(/\D/g, "") // yyyyMMddHHmmss
    const mailDate = tag(block, "MailRoomDate")
    const pagesStr = tag(block, "TotalPageQuantity")
    docs.push({
      id: `${code}${scanDigits}`,
      code,
      description:
        tag(block, "DocumentTypeCodeDescriptionText") ??
        tag(block, "DocumentTypeDescriptionText"),
      date: strictIsoDay(mailDate ?? scan, `TSDR document ${code} date`),
      pages: pagesStr ? Number.parseInt(pagesStr, 10) || null : null,
    })
  }
  // Newest first — the natural order for "attach the latest office action".
  docs.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
  return docs
}

async function fetchDocsBundle(
  serial: string,
  operation?: AttachOperationBudget
): Promise<TsdrDoc[]> {
  const res = await fetchTsdrWithRedirects(
    TSDR_DOCS_LIST_URL(serial),
    {
      headers: { Accept: "application/xml" },
    },
    30_000,
    operation,
    `TSDR document inventory sn${serial}`
  )
  if (!res.ok) {
    throw new Error(
      `TSDR casedocs sn${serial} ${res.status}: ${await res.text().catch(() => "")}`
    )
  }
  const xml = await res.text()
  operation?.assertActive(`TSDR document inventory sn${serial} body`)
  return parseDocsBundle(xml)
}

// Portfolio rows key on serial, but users often hold a registration
// number instead — TSDR resolves rn → sn via the status endpoint.
async function resolveSerial(
  input: {
    serialNumber?: string | null
    registrationNumber?: string | null
  },
  operation?: AttachOperationBudget
): Promise<string> {
  // Foreign rows are keyed by ST13 (two letters + digits). TSDR is the
  // only connected source with retrievable file wrappers, so refuse these
  // outright rather than stripping the letters and querying TSDR with
  // garbage digits.
  for (const v of [input.serialNumber, input.registrationNumber]) {
    if (v && /^[A-Z]{2}\d/i.test(v.trim())) {
      throw new Error(
        `"${v}" is a foreign (ST13) identifier — file-wrapper documents are only available for US marks via TSDR; no connected source exposes documents for foreign marks.`
      )
    }
  }
  const sn = input.serialNumber?.replace(/\D/g, "")
  if (sn) return sn
  const rn = input.registrationNumber?.replace(/\D/g, "")
  if (!rn) throw new Error("Provide serialNumber or registrationNumber.")
  const res = await fetchTsdrWithRedirects(
    `${TSDR_BASE}/ts/cd/casestatus/rn${rn}/info.json`,
    { headers: { Accept: "application/json" } },
    30_000,
    operation,
    `TSDR registration-to-serial resolution rn${rn}`
  )
  if (!res.ok) throw new Error(`TSDR casestatus rn${rn} ${res.status}`)
  // status.serialNumber is a NUMBER in the payload; str() stringifies it.
  const data = rec(await res.json())
  operation?.assertActive(`TSDR registration-to-serial resolution rn${rn} body`)
  const status = rec(rec(arr(data.trademarks)[0]).status)
  const serial = str(status.serialNumber)
  if (!serial) {
    throw new Error(`could not resolve registration ${rn} to a serial number`)
  }
  return serial
}

// ── Mark-image download + validation ───────────────────────────────────

// Magic-byte signatures for the formats Notion renders as thumbnails and
// icons. Bytes are decisive on purpose: TSDR and TMview both serve HTML
// error pages (with assorted status codes) when they block a request, and
// the content-type header can lie in either direction.
const IMAGE_MAGIC: Array<{ bytes: number[]; ext: string; mime: string }> = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], ext: "png", mime: "image/png" },
  { bytes: [0xff, 0xd8, 0xff], ext: "jpg", mime: "image/jpeg" },
  { bytes: [0x47, 0x49, 0x46, 0x38], ext: "gif", mime: "image/gif" },
]

function sniffImage(buf: Buffer): { ext: string; mime: string } | null {
  for (const m of IMAGE_MAGIC) {
    if (m.bytes.every((b, i) => buf[i] === b)) {
      return { ext: m.ext, mime: m.mime }
    }
  }
  // RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf.toString("latin1", 0, 4) === "RIFF" &&
    buf.toString("latin1", 8, 12) === "WEBP"
  ) {
    return { ext: "webp", mime: "image/webp" }
  }
  return null
}

// Download a mark image (TSDR for 8-digit US serials, the TMview
// thumbnail for ST13-keyed foreign rows) and validate it end-to-end.
// Returns a reason instead of throwing so one bad image never fails the
// whole batch.
async function fetchValidatedMarkImage(
  id: string
): Promise<
  { buffer: Buffer; filename: string; mime: string } | { error: string }
> {
  const url = /^\d{8}$/.test(id) ? TSDR_IMAGE_URL(id) : TMVIEW_IMAGE_URL(id)
  let res: Response
  try {
    res = await fetchWithTimeout(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      },
    })
  } catch (err) {
    return {
      error: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!res.ok) return { error: `HTTP ${res.status}` }
  const buffer = Buffer.from(await res.arrayBuffer())
  const sniffed = sniffImage(buffer)
  if (!sniffed) {
    const contentType = res.headers.get("content-type") ?? "unknown"
    return {
      error: `response is not an image (content-type ${contentType}, first bytes ${buffer.subarray(0, 8).toString("hex")})`,
    }
  }
  if (buffer.length > NOTION_SINGLE_PART_LIMIT) {
    return {
      error: `image is ${buffer.length} bytes, over the ${NOTION_SINGLE_PART_LIMIT}-byte single-part upload limit`,
    }
  }
  return { buffer, filename: `${id}.${sniffed.ext}`, mime: sniffed.mime }
}

// ── Tool registration ──────────────────────────────────────────────────

export function registerDocumentTools(worker: Worker): void {
  worker.tool("listTrademarkDocuments", {
    title: "List Trademark Documents",
    description:
      "List file-wrapper documents for a US trademark application/registration, newest-first (US ONLY — foreign/ST13-keyed rows have no retrievable documents in any connected source). Each entry includes documentIdentifier (pass it to attachTrademarkDocumentToPage), documentCode, documentDate (YYYY-MM-DD), description, and page count. Provide serialNumber (preferred — it's the Serial # / ID column in the portfolio database) or registrationNumber. Requires TSDR_API_KEY. Always call this before attach to get exact identifiers.",
    schema: j.object({
      serialNumber: j
        .string()
        .describe("USPTO serial number, e.g. '12345678' (the Serial # column).")
        .nullable(),
      registrationNumber: j
        .string()
        .describe(
          "US registration number, e.g. '9876543'. Provide this OR serialNumber."
        )
        .nullable(),
    }),
    execute: async (input) => {
      const serial = await resolveSerial(input)
      const documents = await fetchDocsBundle(serial)
      return {
        serialNumber: serial,
        count: documents.length,
        documents: documents.map((d) => ({
          documentIdentifier: d.id,
          documentCode: d.code,
          documentDate: d.date,
          description: d.description,
          pages: d.pages,
        })),
      } as never
    },
  })

  worker.tool("attachTrademarkDocumentToPage", {
    title: "Attach Trademark Document to Page",
    description:
      "Fetch a file-wrapper document for a US trademark application/registration and attach it as a hosted PDF sub-page under the specified Notion page. Picks the document by documentIdentifier (preferred) or documentCode (+ optional documentDate), downloads the PDF from TSDR, uploads it to Notion, and creates a titled sub-page (e.g. 'Registration Certificate — 2023-09-06'). Sub-pages persist across sync re-emits. ALWAYS call listTrademarkDocuments first to get exact identifiers, then call this once per document. TSDR PDF downloads are rate-limited to 4/minute — attach documents one at a time, ~90s apart.",
    schema: j.object({
      serialNumber: j
        .string()
        .describe("USPTO serial number, e.g. '12345678'.")
        .nullable(),
      registrationNumber: j
        .string()
        .describe("US registration number. Provide this OR serialNumber.")
        .nullable(),
      documentIdentifier: j
        .string()
        .describe(
          "Exact document identifier from listTrademarkDocuments (preferred)."
        )
        .nullable(),
      documentCode: j
        .string()
        .describe(
          "Document type code from listTrademarkDocuments (e.g. 'ORC' registration certificate, 'OOA' office action, 'SPE' specimen). Used when documentIdentifier is omitted."
        )
        .nullable(),
      documentDate: j
        .string()
        .describe(
          "YYYY-MM-DD date to disambiguate when several documents share a code."
        )
        .nullable(),
      pageId: j
        .string()
        .describe(
          "Notion page ID (or URL) of the portfolio row to attach the document under."
        ),
      blockType: j
        .enum("pdf", "file")
        .describe(
          "Embed as an inline PDF viewer ('pdf', default) or a file attachment ('file')."
        )
        .nullable(),
    }),
    execute: async (input, { notion }) => {
      const operation = new AttachOperationBudget()
      try {
        const notionToken = process.env.NOTION_API_TOKEN
        if (!notionToken) {
          return {
            error: "missing_notion_token",
            message:
              "NOTION_API_TOKEN env var is not set. attach needs it for the multipart byte upload: ntn workers env set NOTION_API_TOKEN=<integration-token> && ntn workers env push",
          } as never
        }
        const blockType = input.blockType ?? "pdf"
        const normalizedPageId = normalizeNotionId(input.pageId ?? "")
        if (!normalizedPageId) {
          return {
            error: "invalid_page_id",
            message: "pageId must be a Notion page ID (32-hex) or a page URL.",
            received: input.pageId,
          } as never
        }
        const serial = await resolveSerial(input, operation)
        const documents = await fetchDocsBundle(serial, operation)
        if (documents.length === 0) {
          return { error: "no_documents", serialNumber: serial } as never
        }

        // Select the target: documentIdentifier wins, else code (+ optional
        // date), else the newest document.
        const codeMatches = input.documentCode
          ? documents.filter((d) => d.code === input.documentCode)
          : documents
        let target: TsdrDoc | undefined
        if (input.documentIdentifier) {
          target = documents.find((d) => d.id === input.documentIdentifier)
          if (!target) {
            return {
              error: "no_matching_document_for_identifier",
              serialNumber: serial,
              documentIdentifier: input.documentIdentifier,
              availableIdentifiers: codeMatches.slice(0, 25).map((d) => ({
                documentIdentifier: d.id,
                documentDate: d.date,
              })),
            } as never
          }
        } else if (input.documentDate) {
          const dateMatches = codeMatches.filter(
            (d) => d.date === input.documentDate
          )
          if (dateMatches.length !== 1) {
            return {
              error:
                dateMatches.length === 0
                  ? "no_matching_document_for_date"
                  : "multiple_matches_for_date",
              serialNumber: serial,
              documentCode: input.documentCode,
              documentDate: input.documentDate,
              documentIdentifiers: dateMatches.map((d) => d.id),
              availableDates: codeMatches.map((d) => d.date).filter(Boolean),
            } as never
          }
          target = dateMatches[0]
        } else {
          target = codeMatches[0]
        }
        if (!target) {
          return {
            error: "no_matching_document",
            serialNumber: serial,
            documentCode: input.documentCode,
            availableCodes: Array.from(
              new Set(documents.map((d) => d.code).filter(Boolean))
            ),
          } as never
        }

        // Build the sub-page title ONCE and reuse it for both the
        // idempotency check and the eventual creation. If the expected
        // title were constructed separately (e.g. with a different code
        // sanitizer), a description-less document with a special-character
        // code would re-attach on every retry.
        const docDate = target.date ?? "undated"
        const safeCode = (target.code || "DOC").replace(/[^A-Za-z0-9._-]/g, "_")
        const subPageTitle =
          docDate === "undated"
            ? (target.description ?? safeCode)
            : `${target.description ?? safeCode} — ${docDate}`

        // Idempotency: if a sub-page for this exact document already
        // exists, return it instead of re-downloading and duplicating —
        // retries after ambiguous failures are therefore always safe. The
        // listing is PAGINATED: portfolio row pages accumulate document
        // sub-pages, and a first-100-only check quietly loses idempotency
        // on busy pages.
        type ChildPage = {
          id: string
          type?: string
          child_page?: { title?: string }
        }
        let childCursor: string | null = null
        const seenChildCursors = new Set<string>()
        let childScanComplete = false
        for (let page = 0; page < MAX_ATTACH_CHILD_PAGES; page++) {
          let listed: NotionJsonResponse
          try {
            listed = await attachNotionJsonRequest(
              operation,
              notionToken,
              `blocks/${normalizedPageId}/children?page_size=100${
                childCursor
                  ? `&start_cursor=${encodeURIComponent(childCursor)}`
                  : ""
              }`,
              "GET",
              `Notion attachment idempotency scan page ${page + 1}`
            )
          } catch (error) {
            if (error instanceof AttachOperationDeadlineError) throw error
            return {
              error: "idempotency_scan_failed",
              message: error instanceof Error ? error.message : String(error),
            } as never
          }
          const kids = listed.body
          if (
            !listed.ok ||
            kids.object === "error" ||
            kids.object !== "list" ||
            !Array.isArray(kids.results) ||
            typeof kids.has_more !== "boolean"
          ) {
            return {
              error: "idempotency_scan_failed",
              status: listed.status,
              message:
                typeof kids.message === "string"
                  ? kids.message
                  : "Notion returned a malformed child-block page; no attachment was created.",
            } as never
          }
          const pageChildren: ChildPage[] = []
          for (const value of kids.results) {
            const child = rec(value)
            if (
              typeof child.id !== "string" ||
              typeof child.type !== "string"
            ) {
              return {
                error: "idempotency_scan_failed",
                message:
                  "Notion returned a malformed child block; no attachment was created.",
              } as never
            }
            if (
              child.type === "child_page" &&
              typeof rec(child.child_page).title !== "string"
            ) {
              return {
                error: "idempotency_scan_failed",
                message:
                  "Notion returned a child page without a title; no attachment was created.",
              } as never
            }
            pageChildren.push(child as ChildPage)
          }
          const existing = pageChildren.find(
            (child) =>
              child.type === "child_page" &&
              child.child_page?.title === subPageTitle
          )
          if (existing) {
            return {
              alreadyAttached: true,
              serialNumber: serial,
              documentIdentifier: target.id,
              subPageId: existing.id,
              subPageTitle,
              note: "A sub-page for this document already exists — nothing was re-downloaded or duplicated.",
            } as never
          }
          if (!kids.has_more) {
            childScanComplete = true
            break
          }
          const nextCursor = kids.next_cursor
          if (typeof nextCursor !== "string" || nextCursor.trim() === "") {
            return {
              error: "idempotency_scan_incomplete",
              reason: "missing_cursor",
              message:
                "Notion reported more child blocks without a next cursor; no attachment was created.",
            } as never
          }
          if (seenChildCursors.has(nextCursor)) {
            return {
              error: "idempotency_scan_incomplete",
              reason: "repeated_cursor",
              message:
                "Notion repeated a child-block cursor; no attachment was created.",
            } as never
          }
          if (page === MAX_ATTACH_CHILD_PAGES - 1) {
            return {
              error: "idempotency_scan_incomplete",
              reason: "page_limit",
              pagesScanned: MAX_ATTACH_CHILD_PAGES,
              message: `The parent has more than ${MAX_ATTACH_CHILD_PAGES * 100} child blocks; no attachment was created because duplicate detection could not complete.`,
            } as never
          }
          seenChildCursors.add(nextCursor)
          childCursor = nextCursor
        }
        if (!childScanComplete) {
          return {
            error: "idempotency_scan_incomplete",
            reason: "page_limit",
            pagesScanned: MAX_ATTACH_CHILD_PAGES,
            message: "Child-block duplicate detection did not complete.",
          } as never
        }

        // PDF download — TSDR's 4/min PDF budget applies; this tool runs
        // ONE download per call, and the rate_limited error below guides
        // retry pacing. Two paths, both validated as real PDFs first:
        //   1. The precise single-document ("casedoc") endpoint. Its store
        //      stopped covering NEW documents around the office's data-
        //      platform transition — documents from ~2025 onward 404 even
        //      though the bundle listing shows them, while older documents
        //      resolve fine.
        //   2. The bundle endpoint filtered to this document's type code +
        //      mail date, which serves recent documents correctly. If two
        //      documents share both type and date, the PDF contains each of
        //      them — flagged in the response rather than guessed at.
        // Order matters because each attempt costs a PDF-class request
        // against the 4/min budget: 2025+ documents skip the known-dead
        // casedoc store entirely; older documents try casedoc first with
        // the bundle as the backstop.
        const casedocAttempt = {
          source: "casedoc",
          url: TSDR_DOC_PDF_URL(serial, target.id),
        }
        const bundleAttempt =
          target.code && target.date
            ? {
                source: "bundle-filtered",
                url: `${TSDR_BASE}/ts/cd/casedocs/bundle.pdf?sn=${serial}&type=${encodeURIComponent(target.code)}&date=${target.date}`,
              }
            : null
        const modernDoc = (target.date ?? "") >= "2025-01-01"
        const attempts: Array<{ source: string; url: string }> = bundleAttempt
          ? modernDoc
            ? [bundleAttempt]
            : [casedocAttempt, bundleAttempt]
          : [casedocAttempt]
        let pdfBuffer: Buffer | null = null
        let downloadSource = ""
        let lastFailure = ""
        let retried429 = false
        for (const attempt of attempts) {
          let res: Response
          try {
            res = await fetchTsdrWithRedirects(
              attempt.url,
              { headers: { Accept: "application/pdf" } },
              60_000,
              operation,
              `TSDR PDF ${attempt.source}`
            )
          } catch (err) {
            if (err instanceof AttachOperationDeadlineError) throw err
            lastFailure = `${attempt.source}: ${err instanceof Error ? err.message : String(err)}`
            continue
          }
          if (res.status === 429) {
            // One bounded in-tool retry. Never shorten an explicit Retry-After:
            // replaying early can extend TSDR's penalty. If the full delay cannot
            // fit inside this invocation's shared deadline, return immediately.
            const retryAfterHeader = res.headers.get("retry-after") ?? ""
            const retryAfter = /^\d+$/.test(retryAfterHeader)
              ? Number(retryAfterHeader)
              : Number.NaN
            const validRetryAfter =
              Number.isSafeInteger(retryAfter) && retryAfter > 0
            const retryAfterSeconds = validRetryAfter ? retryAfter : 90
            if (!retried429) {
              retried429 = true
              const waitMs = validRetryAfter ? retryAfter * 1000 : 40_000
              const canRetry =
                Number.isSafeInteger(waitMs) &&
                (await operation.waitForRetry(
                  waitMs,
                  `TSDR PDF ${attempt.source} rate-limit retry`
                ))
              if (!canRetry) {
                return {
                  error: "rate_limited",
                  rateLimited: true,
                  status: 429,
                  retryAfterSeconds,
                  limitScope: "apiKey",
                  message:
                    "TSDR's Retry-After delay does not fit inside the 55-second attachment-operation budget. No retry was started; wait retryAfterSeconds, then invoke attach again.",
                } as never
              }
              attempts.push(attempt) // requeue this attempt once
              continue
            }
            return {
              error: "rate_limited",
              rateLimited: true,
              status: 429,
              retryAfterSeconds,
              limitScope: "apiKey",
              message:
                "TSDR's PDF budget (4/min per key, with multi-minute penalties after repeated 429s) is exhausted and one in-tool retry already failed. Wait retryAfterSeconds, then retry — space attaches ~90s apart and never run them in parallel.",
            } as never
          }
          if (!res.ok) {
            lastFailure = `${attempt.source}: HTTP ${res.status}`
            continue
          }
          const buf = Buffer.from(await res.arrayBuffer())
          operation.assertActive(`TSDR PDF ${attempt.source} body`)
          // Never upload a non-PDF — TSDR serves plain-text/HTML error
          // pages with assorted statuses, and the magic bytes are the only
          // trustworthy signal.
          if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
            lastFailure = `${attempt.source}: response is not a PDF (content-type ${res.headers.get("content-type") ?? "unknown"})`
            continue
          }
          pdfBuffer = buf
          downloadSource = attempt.source
          break
        }
        if (!pdfBuffer) {
          return {
            error: "pdf_fetch_failed",
            message: lastFailure || "all download paths failed",
          } as never
        }
        if (pdfBuffer.length > NOTION_SINGLE_PART_LIMIT) {
          return {
            error: "pdf_too_large_for_single_part",
            bytes: pdfBuffer.length,
            limitBytes: NOTION_SINGLE_PART_LIMIT,
          } as never
        }
        const sameTypeAndDate = documents.filter(
          (d) => d.code === target.code && d.date === target.date
        ).length

        const filename = `${serial}-${safeCode}-${docDate}.pdf`

        // Step 1: create the file_upload (JSON via the managed client). The
        // dev-surface API can return HTTP 200 with { object: "error" } —
        // detect the shape ourselves.
        let createdResponse: NotionJsonResponse
        try {
          createdResponse = await attachNotionJsonRequest(
            operation,
            notionToken,
            "file_uploads",
            "POST",
            "Notion file upload creation",
            {
              mode: "single_part",
              filename,
              content_type: "application/pdf",
            }
          )
        } catch (error) {
          if (error instanceof AttachOperationDeadlineError) throw error
          return {
            error: "file_upload_create_failed",
            message: error instanceof Error ? error.message : String(error),
          } as never
        }
        const created = createdResponse.body as {
          id?: string
          upload_url?: string
          object?: string
          code?: string
          message?: string
        }
        if (
          !createdResponse.ok ||
          created.object === "error" ||
          !created.id ||
          !created.upload_url
        ) {
          return {
            error: "file_upload_create_failed",
            code: created.code ?? null,
            message: created.message ?? null,
          } as never
        }
        const uploadUrl = validatedNotionUploadUrl(
          created.upload_url,
          created.id
        )
        if (!uploadUrl) {
          return {
            error: "file_upload_create_failed",
            message: "Notion returned an unexpected upload_url.",
          } as never
        }

        // Step 2: send the binary as multipart/form-data (raw fetch — the
        // bundled SDK can't do multipart; fetch sets the boundary itself).
        const formData = new FormData()
        formData.append(
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
              redirect: "error",
              headers: {
                Authorization: `Bearer ${notionToken}`,
                "Notion-Version": NOTION_VERSION,
              },
              body: formData,
            },
            "Notion PDF upload"
          )
        } catch (err) {
          if (err instanceof AttachOperationDeadlineError) throw err
          return {
            error: "upload_send_failed",
            message: err instanceof Error ? err.message : String(err),
          } as never
        }
        if (!sendRes.ok) {
          return {
            error: "upload_send_failed",
            status: sendRes.status,
            message: await sendRes.text().catch(() => ""),
          } as never
        }

        // Step 3: a titled sub-page with the PDF as its only block —
        // sub-pages survive sync re-emits, so attachments persist.
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
        let pageResponse: NotionJsonResponse
        try {
          pageResponse = await attachNotionJsonRequest(
            operation,
            notionToken,
            "pages",
            "POST",
            "Notion attachment sub-page creation",
            {
              parent: { page_id: normalizedPageId },
              properties: {
                title: { title: [{ text: { content: subPageTitle } }] },
              },
              children: [block],
            }
          )
        } catch (error) {
          if (error instanceof AttachOperationDeadlineError) throw error
          return {
            error: "subpage_create_failed",
            message: error instanceof Error ? error.message : String(error),
            fileUploadId: created.id,
          } as never
        }
        const createRes = pageResponse.body as {
          id?: string
          url?: string
          object?: string
          code?: string
          message?: string
        }
        if (!pageResponse.ok || createRes.object === "error" || !createRes.id) {
          return {
            error: "subpage_create_failed",
            code: createRes.code ?? null,
            message: createRes.message ?? null,
            fileUploadId: created.id,
          } as never
        }

        return {
          serialNumber: serial,
          documentIdentifier: target.id,
          documentCode: target.code,
          documentDate: docDate === "undated" ? null : docDate,
          description: target.description,
          filename,
          bytes: pdfBuffer.length,
          downloadSource,
          ...(downloadSource === "bundle-filtered" &&
            sameTypeAndDate > 1 && {
              note: `${sameTypeAndDate} documents share type ${target.code} and date ${target.date}; the attached PDF contains all of them (TSDR's single-document store doesn't cover recent documents).`,
            }),
          subPageId: createRes.id,
          subPageUrl: createRes.url ?? null,
          subPageTitle,
          blockType,
        } as never
      } catch (error) {
        if (error instanceof AttachOperationDeadlineError) {
          return {
            error: "operation_deadline_exceeded",
            retryable: true,
            operationBudgetMs: ATTACH_OPERATION_BUDGET_MS,
            message: error.message,
          } as never
        }
        throw error
      }
    },
  })

  // The sync write path can only reference EXTERNAL URLs in a files
  // property, and TSDR's image endpoint has no file extension — Notion
  // renders such references as a generic attachment chip, and both image
  // hosts serve HTML error pages when they block a request. So the "Mark
  // Image" column is populated by this tool instead: download the bytes,
  // PROVE they're an image, and upload them with a real filename and MIME
  // type. Uploaded property values survive sync re-emits (upserts leave
  // unspecified properties alone); page ICONS do not — an upsert with no
  // icon field CLEARS the icon, so every backfill wipes them, and
  // re-running this tool is the documented recovery. That is why it
  // always sets both surfaces.
  worker.tool("refreshMarkImages", {
    title: "Refresh Mark Images",
    description:
      "Populate the portfolio's 'Mark Image' files & media property AND each row's page icon with real uploaded mark images (validated PNG/JPEG bytes — US rows from TSDR, foreign/ST13 rows from TMview thumbnails; never HTML error pages), so table rows show actual thumbnails. Sync re-emits clear page icons, so rerun this after every backfill. Processes up to maxImages rows per call (default 10, to stay inside the tool time limit) and returns nextCursor when more rows remain — CALL REPEATEDLY, passing nextCursor back, until hasMore is false. Optionally restrict to specific rows via serialNumbers. Requires NOTION_API_TOKEN.",
    schema: j.object({
      databaseId: j
        .string()
        .describe(
          "ID or URL of the portfolio database. Omit to find it by title (config.notionDatabaseTitle) automatically."
        )
        .nullable(),
      serialNumbers: j
        .string()
        .describe(
          "Comma-separated row IDs to refresh — US serials or ST13s (e.g. '12345678,EM500000012345678'). Omit to process every row."
        )
        .nullable(),
      startCursor: j
        .string()
        .describe("Pagination cursor from a previous call's nextCursor.")
        .nullable(),
      maxImages: j
        .number()
        .describe("Maximum rows to process this call (default 10, cap 25).")
        .nullable(),
    }),
    execute: async (input, { notion }) => {
      const notionToken = process.env.NOTION_API_TOKEN
      if (!notionToken) {
        return {
          error: "missing_notion_token",
          message:
            "NOTION_API_TOKEN env var is not set. refreshMarkImages needs it for the multipart byte uploads: ntn workers env set NOTION_API_TOKEN=<integration-token> && ntn workers env push",
        } as never
      }
      const requestedMax = input.maxImages ?? 10
      if (
        !Number.isSafeInteger(requestedMax) ||
        requestedMax < 1 ||
        requestedMax > 25
      ) {
        return {
          error: "invalid_max_images",
          message: "maxImages must be an integer from 1 through 25.",
          received: input.maxImages,
        } as never
      }
      const maxImages = requestedMax
      const wanted = input.serialNumbers
        ? new Set(
            input.serialNumbers
              .split(",")
              .map((s: string) => s.trim())
              .filter(Boolean)
          )
        : null

      // Resolve the database. A managed database's ID isn't knowable at
      // module scope (it's assigned at deploy), so find it by title via
      // the search API unless the caller passed one. Note the client
      // speaks the newer API surface: search filters on "data_source"
      // (not "database"), and rows are queried via /data_sources/…/query.
      let databaseId = input.databaseId
        ? (normalizeNotionId(input.databaseId) ?? input.databaseId)
        : null
      if (!databaseId) {
        const search = (await notion.request({
          path: "search",
          method: "post",
          body: {
            query: config.notionDatabaseTitle,
            filter: { property: "object", value: "data_source" },
            page_size: 20,
          },
        })) as {
          results?: Array<{
            id: string
            title?: Array<{ plain_text?: string }>
          }>
        }
        const titled = (search.results ?? []).map((r) => ({
          id: r.id,
          title: (r.title ?? []).map((t) => t.plain_text ?? "").join(""),
        }))
        // Single match or refuse-with-candidates: guessing between look-
        // alike databases would write images into the wrong one.
        const matches = titled.filter((r) =>
          r.title
            .toLowerCase()
            .includes(config.notionDatabaseTitle.toLowerCase())
        )
        if (matches.length !== 1) {
          return {
            error: "database_not_found",
            message:
              matches.length === 0
                ? `No data source titled like "${config.notionDatabaseTitle}" is visible to the worker (renamed database? missing connection?). Pass databaseId explicitly.`
                : `Several matching data sources are visible: ${matches
                    .map((m) => `"${m.title}" (${m.id})`)
                    .join(", ")}. Pass databaseId explicitly.`,
          } as never
        }
        databaseId = matches[0].id
      }

      // "Mark Image" is deliberately NOT in the managed sync schema —
      // schema-declared properties are read-only on this platform, so a
      // tool (or a user) could never write one. That is exactly why the
      // sync never touches this column: it lives in user space, owned by
      // this tool. Ensure it exists as a plain files property.
      const ds = (await notion.request({
        path: `data_sources/${databaseId}`,
        method: "get",
      })) as {
        object?: string
        properties?: Record<string, unknown>
        message?: string
      }
      if (
        ds.object !== "error" &&
        ds.properties &&
        !("Mark Image" in ds.properties)
      ) {
        const addProp = (await notion.request({
          path: `data_sources/${databaseId}`,
          method: "patch",
          body: { properties: { "Mark Image": { files: {} } } },
        })) as { object?: string; message?: string }
        if (addProp.object === "error") {
          return {
            error: "property_create_failed",
            message:
              addProp.message ?? "could not add the Mark Image files property",
            databaseId,
          } as never
        }
      }

      // One bounded page per call — every returned row can cost a download,
      // two uploads, and a page update. Keep page_size at maxImages even for
      // targeted scans: reading 100 rows and processing every wanted match
      // would violate the advertised cap. Stopping halfway through such a
      // page and returning Notion's page-level cursor would instead skip the
      // unprocessed remainder, so a smaller lossless page is the safe trade.
      const queryBody = {
        page_size: maxImages,
        ...(input.startCursor && { start_cursor: input.startCursor }),
      }
      let query = (await notion.request({
        path: `data_sources/${databaseId}/query`,
        method: "post",
        body: queryBody,
      })) as {
        object?: string
        message?: string
        results?: Array<{ id: string; properties?: Record<string, unknown> }>
        has_more?: boolean
        next_cursor?: string | null
      }
      if (query.object === "error" || !query.results) {
        // Older-style ID (or older API routing): retry the legacy path.
        query = (await notion.request({
          path: `databases/${databaseId}/query`,
          method: "post",
          body: queryBody,
        })) as typeof query
      }
      if (query.object === "error" || !query.results) {
        return {
          error: "database_query_failed",
          message: query.message ?? "no results returned",
          databaseId,
        } as never
      }
      if (query.results.length > maxImages) {
        return {
          error: "database_query_failed",
          message: `Notion returned ${query.results.length} rows after page_size=${maxImages}; refusing to exceed maxImages or skip a partial page.`,
          databaseId,
        } as never
      }

      const attached: Array<{
        serialNumber: string
        filename: string
        bytes: number
      }> = []
      const skipped: Array<{ serialNumber: string; reason: string }> = []
      for (const page of query.results) {
        // The ID property is a US serial (8 digits) or a TMview ST13 —
        // both map to an image endpoint in fetchValidatedMarkImage.
        const idProp = rec(rec(page.properties)["ID"])
        const serial = arr(idProp.rich_text)
          .map((t) => str(rec(t).plain_text))
          .filter(Boolean)
          .join("")
        // Docket-only rows (DKT-*) have no image source by design — skip
        // silently instead of re-reporting them on every sweep.
        if (serial.startsWith("DKT-")) continue
        if (!/^(\d{8}|[A-Z]{2}\w{6,20})$/.test(serial)) {
          skipped.push({
            serialNumber: serial || page.id,
            reason: "row has no usable ID",
          })
          continue
        }
        if (wanted && !wanted.has(serial)) continue

        const img = await fetchValidatedMarkImage(serial)
        if ("error" in img) {
          skipped.push({ serialNumber: serial, reason: img.error })
          continue
        }

        // Two uploads of the same bytes: one for the files property, one
        // for the page icon (a Notion file upload attaches only once).
        const fileUp = await uploadToNotion(
          notion,
          notionToken,
          img.buffer,
          img.filename,
          img.mime
        )
        if ("error" in fileUp) {
          skipped.push({ serialNumber: serial, reason: fileUp.error })
          continue
        }
        // Icon failure is non-fatal — the thumbnail column is the point;
        // the icon is a bonus that the next sweep repairs anyway.
        const iconUp = await uploadToNotion(
          notion,
          notionToken,
          img.buffer,
          img.filename,
          img.mime
        )
        const iconId = "error" in iconUp ? null : iconUp.id

        const updated = (await notion.request({
          path: `pages/${page.id}`,
          method: "patch",
          body: {
            ...(iconId && {
              icon: { type: "file_upload", file_upload: { id: iconId } },
            }),
            properties: {
              "Mark Image": {
                files: [
                  {
                    type: "file_upload",
                    file_upload: { id: fileUp.id },
                    name: img.filename,
                  },
                ],
              },
            },
          },
        })) as { object?: string; message?: string }
        if (updated.object === "error") {
          skipped.push({
            serialNumber: serial,
            reason: `page update failed: ${updated.message ?? "unknown"}`,
          })
          continue
        }
        attached.push({
          serialNumber: serial,
          filename: img.filename,
          bytes: img.buffer.length,
        })
      }

      return {
        databaseId,
        attached,
        skipped,
        processed: attached.length + skipped.length,
        hasMore: Boolean(query.has_more),
        nextCursor: query.next_cursor ?? null,
        ...(query.has_more && {
          note: "More rows remain — call refreshMarkImages again with startCursor set to nextCursor.",
        }),
      } as never
    },
  })
}
