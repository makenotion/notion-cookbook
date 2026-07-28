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

const NOTION_VERSION = "2022-06-28"
const NOTION_SINGLE_PART_LIMIT = 20 * 1024 * 1024 // 20 MB

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
const day = (v: unknown): string | null => {
  const s = str(v)
  if (!s) return null
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s)
  return m ? m[1] : null
}

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

// Accepts a bare Notion ID (with or without dashes) or a full page URL.
const normalizeNotionId = (raw: string): string | null => {
  const m = /[0-9a-f]{32}/i.exec(raw.replace(/-/g, ""))
  return m ? m[0] : null
}

// The tool-context Notion client (structural: only .request is used).
type NotionClient = {
  request(opts: {
    path: string
    method: string
    body?: unknown
  }): Promise<unknown>
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
  const form = new FormData()
  form.append(
    "file",
    new Blob([new Uint8Array(buffer)], { type: mime }),
    filename
  )
  const sendRes = await fetchWithTimeout(created.upload_url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": NOTION_VERSION,
    },
    body: form,
  })
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
      date: mailDate ? (day(mailDate) ?? mailDate.slice(0, 10)) : day(scan),
      pages: pagesStr ? Number.parseInt(pagesStr, 10) || null : null,
    })
  }
  // Newest first — the natural order for "attach the latest office action".
  docs.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
  return docs
}

async function fetchDocsBundle(serial: string): Promise<TsdrDoc[]> {
  const res = await fetchWithTimeout(TSDR_DOCS_LIST_URL(serial), {
    headers: { "USPTO-API-KEY": tsdrKey() },
  })
  if (!res.ok) {
    throw new Error(
      `TSDR casedocs sn${serial} ${res.status}: ${await res.text().catch(() => "")}`
    )
  }
  return parseDocsBundle(await res.text())
}

// Portfolio rows key on serial, but users often hold a registration
// number instead — TSDR resolves rn → sn via the status endpoint.
async function resolveSerial(input: {
  serialNumber?: string | null
  registrationNumber?: string | null
}): Promise<string> {
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
  const res = await fetchWithTimeout(
    `${TSDR_BASE}/ts/cd/casestatus/rn${rn}/info.json`,
    { headers: { "USPTO-API-KEY": tsdrKey(), Accept: "application/json" } }
  )
  if (!res.ok) throw new Error(`TSDR casestatus rn${rn} ${res.status}`)
  // status.serialNumber is a NUMBER in the payload; str() stringifies it.
  const data = rec(await res.json())
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

      const serial = await resolveSerial(input)
      const documents = await fetchDocsBundle(serial)
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
      const children: ChildPage[] = []
      let childCursor: string | null = null
      for (let page = 0; page < 5; page++) {
        const kids = (await notion.request({
          path: `blocks/${normalizedPageId}/children?page_size=100${
            childCursor
              ? `&start_cursor=${encodeURIComponent(childCursor)}`
              : ""
          }`,
          method: "get",
        })) as {
          results?: ChildPage[]
          has_more?: boolean
          next_cursor?: string | null
        }
        children.push(...(kids.results ?? []))
        if (!kids.has_more || !kids.next_cursor) break
        childCursor = kids.next_cursor
      }
      const existing = children.find(
        (k) => k.type === "child_page" && k.child_page?.title === subPageTitle
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
          res = await fetchWithTimeout(
            attempt.url,
            { headers: { "USPTO-API-KEY": tsdrKey() } },
            60_000
          )
        } catch (err) {
          lastFailure = `${attempt.source}: ${err instanceof Error ? err.message : String(err)}`
          continue
        }
        if (res.status === 429) {
          // One bounded in-tool retry: honor Retry-After when it fits the
          // tool's execution budget (waiting longer would get the run
          // killed mid-backoff), else ~40s, capped at 45s.
          const retryAfter = Number.parseInt(
            res.headers.get("retry-after") ?? "",
            10
          )
          if (!retried429) {
            retried429 = true
            const waitMs = Math.min(
              Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : 40_000,
              45_000
            )
            await sleep(waitMs)
            attempts.push(attempt) // requeue this attempt once
            continue
          }
          return {
            error: "rate_limited",
            rateLimited: true,
            status: 429,
            retryAfterSeconds:
              Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 90,
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
      const created = (await notion.request({
        path: "file_uploads",
        method: "post",
        body: {
          mode: "single_part",
          filename,
          content_type: "application/pdf",
        },
      })) as {
        id?: string
        upload_url?: string
        object?: string
        code?: string
        message?: string
      }
      if (created.object === "error" || !created.id || !created.upload_url) {
        return {
          error: "file_upload_create_failed",
          code: created.code ?? null,
          message: created.message ?? null,
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
      const sendRes = await fetchWithTimeout(created.upload_url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${notionToken}`,
          "Notion-Version": NOTION_VERSION,
        },
        body: formData,
      })
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
      const createRes = (await notion.request({
        path: "pages",
        method: "post",
        body: {
          parent: { page_id: normalizedPageId },
          properties: {
            title: { title: [{ text: { content: subPageTitle } }] },
          },
          children: [block],
        },
      })) as {
        id?: string
        url?: string
        object?: string
        code?: string
        message?: string
      }
      if (createRes.object === "error" || !createRes.id) {
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
      const maxImages = Math.max(1, Math.min(input.maxImages ?? 10, 25))
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

      // One page of rows per call — the tool has a hard time limit, and
      // each row costs a download + two uploads + a page update. With a
      // serialNumbers filter the page reads 100 rows: the expensive work
      // only happens for wanted rows, and small pages would make targeted
      // refreshes crawl the whole database one thin page per call.
      const queryBody = {
        page_size: wanted ? 100 : maxImages,
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
