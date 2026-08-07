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
//   • NOTION_API_TOKEN     — only for `attach` (the multipart byte upload; the
//     bundled SDK can't do multipart). list needs no Notion token.
//
// Document-source map (each office serves bytes differently — see SKILL.md
// `.claude/skills/document-retrieval`):
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
import { fetchAndMergePdfPages } from "../engine/pdf.js"
import { OPS_REST, epoToken, opsArr, opsText } from "../sources/epo.js"

// ── Constants ────────────────────────────────────────────────────────────
const ODP_SEARCH_URL = "https://api.uspto.gov/api/v1/patent/applications/search"
const ODP_DOCS_URL = (appNum: string) =>
  `https://api.uspto.gov/api/v1/patent/applications/${appNum}/documents`

const NOTION_VERSION = "2022-06-28"
const NOTION_SINGLE_PART_LIMIT = 20 * 1024 * 1024 // 20 MB
const OPS_MAX_DOC_PAGES = 200

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
// the ~60s tool budget — larger docs are refused with a clear message.
const EP_REGISTER_BASE = "https://register.epo.org"
const EP_REGISTER_CONCURRENCY = 4
const EP_REGISTER_MAX_PAGES = 25
const EP_REGISTER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
}
const OPS_IMAGE_CONCURRENCY = 8

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
  apiKey: string
): Promise<string | null> {
  const cleaned = patentNumber.replace(/[,\s]/g, "").replace(/^US/i, "")
  const res = await fetchWithTimeout(ODP_SEARCH_URL, {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      q: `applicationMetaData.patentNumber:${cleaned}`,
      pagination: { offset: 0, limit: 1 },
    }),
  })
  if (!res.ok) return null
  const data = (await res.json()) as {
    patentFileWrapperDataBag?: Array<{ applicationNumberText?: string }>
  }
  return data.patentFileWrapperDataBag?.[0]?.applicationNumberText ?? null
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
  numberOfPages: number | null
}

const gdDate = (s: string | null | undefined): string | null => {
  if (!s) return null
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s)
  return m ? `${m[3]}-${m[1]}-${m[2]}` : s
}

async function gdFetchFamily(
  office: string,
  number: string
): Promise<GdMember[]> {
  const url = `${GD_API_BASE}/patent-family/svc/family/application/${office}/${encodeURIComponent(number)}`
  const res = await fetchWithTimeout(url, {
    headers: { ...GD_HEADERS, Accept: "application/json" },
  })
  if (!res.ok)
    throw new Error(`Global Dossier family ${office}/${number} ${res.status}`)
  const data = (await res.json()) as {
    list?: Array<{
      countryCode?: string
      appNum?: string
      kindCode?: string
      ip5?: boolean
    }>
  }
  return (data.list ?? [])
    .filter((m) => m.countryCode && m.appNum)
    .map((m) => ({
      countryCode: m.countryCode as string,
      appNum: m.appNum as string,
      kindCode: m.kindCode ?? null,
      ip5: m.ip5 === true,
    }))
}

async function gdFetchDocList(
  country: string,
  number: string,
  kind: string
): Promise<GdDoc[]> {
  const url = `${GD_API_BASE}/doc-list/svc/doclist/${country}/${encodeURIComponent(number)}/${kind}`
  const res = await fetchWithTimeout(url, {
    headers: { ...GD_HEADERS, Accept: "application/json" },
  })
  if (!res.ok)
    throw new Error(`Global Dossier doclist ${country}/${number} ${res.status}`)
  const data = (await res.json()) as { docs?: Array<Record<string, unknown>> }
  return (data.docs ?? [])
    .map((d) => ({
      docId: String(d.docId ?? ""),
      docCode: String(d.docCode ?? ""),
      docDesc: (d.docCodeDesc as string) ?? (d.docDesc as string) ?? null,
      legalDateStr: (d.legalDateStr as string) ?? null,
      numberOfPages:
        typeof d.numberOfPages === "number" ? d.numberOfPages : null,
    }))
    .filter((d) => d.docId)
}

// ── EPO OPS images (EP published application — full doc) ──────────────────
function opsCollectDocdbIds(
  node: unknown,
  out: Array<{ num: string; kind: string; country: string }>
): void {
  if (Array.isArray(node)) {
    for (const x of node) opsCollectDocdbIds(x, out)
    return
  }
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>
    // docdb carries a separate `kind` (A1/B1) — epodoc is a bare combined
    // number with no kind, so we can't tell a publication from an application.
    if (o["@document-id-type"] === "docdb") {
      const num = (o["doc-number"] as { $?: string } | undefined)?.$
      const kind = (o.kind as { $?: string } | undefined)?.$
      const country = (o.country as { $?: string } | undefined)?.$
      if (num && kind) out.push({ num, kind, country: country ?? "" })
    }
    for (const k of Object.keys(o)) opsCollectDocdbIds(o[k], out)
  }
}
function opsCollectImages(
  node: unknown,
  out: Array<{ link: string; desc: string; pages: number }>
): void {
  if (Array.isArray(node)) {
    for (const x of node) opsCollectImages(x, out)
    return
  }
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>
    if (typeof o["@link"] === "string") {
      out.push({
        link: o["@link"],
        desc: typeof o["@desc"] === "string" ? o["@desc"] : "",
        pages: Number(o["@number-of-pages"] ?? 0) || 0,
      })
    }
    for (const k of Object.keys(o)) opsCollectImages(o[k], out)
  }
}

// EP application number → its published FullDocument image (publication number,
// then the image instance). null on any miss (unpublished, no image, error).
async function opsResolveFullDocument(
  epAppNum: string
): Promise<{ link: string; pages: number } | null> {
  const serial = epAppNum.replace(/\D/g, "")
  if (!serial) return null
  const token = await epoToken()
  const auth = { Authorization: `Bearer ${token}`, Accept: "application/json" }

  const biblio = await fetchWithTimeout(
    `${OPS_REST}/published-data/application/epodoc/EP${serial}/biblio`,
    { headers: auth }
  )
  if (!biblio.ok) return null
  const ids: Array<{ num: string; kind: string; country: string }> = []
  opsCollectDocdbIds(await biblio.json(), ids)
  const pubs = ids.filter(
    (i) => /^[AB]\d$/.test(i.kind) && (i.country === "" || i.country === "EP")
  )
  const pub =
    pubs.find((i) => i.kind.startsWith("B")) ?? pubs.find((i) => i.kind)
  if (!pub) return null

  const imgRes = await fetchWithTimeout(
    `${OPS_REST}/published-data/publication/epodoc/EP${pub.num}/images`,
    { headers: auth }
  )
  if (!imgRes.ok) return null
  const insts: Array<{ link: string; desc: string; pages: number }> = []
  opsCollectImages(await imgRes.json(), insts)
  const full = insts
    .filter((i) => i.desc === "FullDocument" && i.pages > 0)
    .sort((a, b) => b.pages - a.pages)[0]
  return full ? { link: full.link, pages: full.pages } : null
}

async function opsFetchImagePage(
  link: string,
  pageNum: number,
  total: number
): Promise<Uint8Array> {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** attempt)
    const token = await epoToken()
    const res = await fetchWithTimeout(`${OPS_REST}/${link}.pdf`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/pdf",
        Range: String(pageNum),
      },
    })
    if (res.status === 429) continue
    if (!res.ok)
      throw new Error(
        `OPS image ${link} page ${pageNum}/${total} ${res.status}`
      )
    return new Uint8Array(await res.arrayBuffer())
  }
  throw new Error(
    `OPS image ${link} page ${pageNum}/${total} throttled after retries`
  )
}

const opsDownloadFullPdf = (link: string, pages: number): Promise<Buffer> =>
  fetchAndMergePdfPages(
    Math.min(pages, OPS_MAX_DOC_PAGES),
    OPS_IMAGE_CONCURRENCY,
    (p) => opsFetchImagePage(link, p, Math.min(pages, OPS_MAX_DOC_PAGES))
  )

// ── EP Register file-inspection (EP file-wrapper docs — full doc) ─────────
async function epRegisterFetchPage(
  docId: string,
  appNumber: string,
  pageNum: number,
  total: number
): Promise<Uint8Array> {
  const ref = `${EP_REGISTER_BASE}/application?documentId=${docId}&number=EP${appNumber}&lng=en&npl=false`
  const url = `${EP_REGISTER_BASE}/application?showPdfPage=${pageNum}&documentId=${docId}&appnumber=EP${appNumber}&proc=`
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** attempt)
    const res = await fetchWithTimeout(url, {
      headers: {
        ...EP_REGISTER_HEADERS,
        Referer: ref,
        Accept: "application/pdf",
      },
    })
    if (res.status === 429 || res.status >= 500) continue
    if (!res.ok)
      throw new Error(
        `EP Register ${docId} page ${pageNum}/${total} ${res.status}`
      )
    const ct = res.headers.get("content-type") ?? ""
    const buf = new Uint8Array(await res.arrayBuffer())
    // A throttle/expiry can return an HTML notice with a 200 — never stitch
    // a non-PDF page into the document.
    if (!ct.includes("pdf"))
      throw new Error(
        `EP Register ${docId} page ${pageNum}/${total} returned ${ct || "non-PDF"}`
      )
    return buf
  }
  throw new Error(
    `EP Register ${docId} page ${pageNum}/${total} throttled after retries`
  )
}

const epRegisterDownloadPdf = (
  docId: string,
  appNumber: string,
  pages: number
): Promise<Buffer> =>
  fetchAndMergePdfPages(pages, EP_REGISTER_CONCURRENCY, (p) =>
    epRegisterFetchPage(docId, appNumber, p, pages)
  )

// ── Routing helpers ──────────────────────────────────────────────────────
function detectJurisdiction(idRaw: string): Jurisdiction {
  const s = idRaw.trim().toUpperCase()
  if (/^(PCT|WO)/.test(s)) return "WO"
  if (s.startsWith("EP")) return "EP"
  return "US"
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
  usptoKey: string
}): Promise<DocInventory | InventoryError> {
  const { jurisdiction, applicationNumber, patentNumber, usptoKey } = opts

  // US + WO → USPTO ODP file wrapper (PCT docs land here because filing is at
  // RO/US). Full PDFs, one request each.
  if (jurisdiction === "US" || jurisdiction === "WO") {
    const appNum =
      applicationNumber ??
      (patentNumber
        ? await applicationNumberFromPatentNumber(patentNumber, usptoKey)
        : null)
    if (!appNum)
      return {
        error: "not_found",
        message: `No US application found for ${patentNumber ?? "(no identifier)"}.`,
      }
    const res = await fetchWithTimeout(ODP_DOCS_URL(appNum), {
      headers: { "X-API-KEY": usptoKey },
    })
    if (!res.ok)
      return {
        error: "list_fetch_failed",
        message: `USPTO ODP documents ${res.status}.`,
        applicationNumber: appNum,
      }
    const data = (await res.json()) as { documentBag?: OdpDocument[] }
    const documents = (data.documentBag ?? [])
      .map((d): OfficeDoc | null => {
        const url = d.downloadOptionBag?.find(
          (o) => o.mimeTypeIdentifier === "PDF"
        )?.downloadUrl
        if (!url) return null
        return {
          jurisdiction: "US",
          code: d.documentCode ?? "",
          date: (d.officialDate ?? "").slice(0, 10) || null,
          id: d.documentIdentifier ?? null,
          description: d.documentCodeDescriptionText ?? null,
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
    const startOffice = patentNumber
      ? "US"
      : detectJurisdiction(applicationNumber ?? "")
    const startNumber = patentNumber
      ? await applicationNumberFromPatentNumber(patentNumber, usptoKey)
      : gdNormalizeNumber(applicationNumber ?? "")
    if (!startNumber)
      return {
        error: "missing_identifier",
        message:
          "Provide a US applicationNumber/patentNumber (family is traversed) or the EP application number.",
      }

    const family = await gdFetchFamily(startOffice, startNumber)
    const member = family.find((m) => m.countryCode === jurisdiction)
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
      member.kindCode ?? "A"
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
          pages: d.numberOfPages ?? 1,
        },
      }))
      .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))

    // Route the published application (pamphlet) to the fast OPS images path
    // instead of the rate-limited Register. Best-effort — an OPS miss leaves
    // the Register entry in place.
    try {
      const full = await opsResolveFullDocument(member.appNum)
      if (full) {
        const idx = documents.findIndex((d) => /PAMPHLET/i.test(d.code))
        const fetchDesc = {
          kind: "opsImage" as const,
          link: full.link,
          pages: full.pages,
        }
        if (idx >= 0) {
          documents[idx] = {
            ...documents[idx],
            pages: full.pages,
            description: `${documents[idx].description ?? "Published application"} (full ${full.pages}-page document via EPO OPS)`,
            _fetch: fetchDesc,
          }
        }
      }
    } catch {
      // OPS enrichment is best-effort; never breaks the listing.
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
      "List prosecution-history documents for a patent application in US, PCT/WO, or EP, newest-first. Each entry has documentCode, documentDate (YYYY-MM-DD), documentIdentifier (pass to attachProsecutionDocumentToPage), description, and pages. Set `jurisdiction` (default US). US & WO/PCT come from the USPTO file wrapper — for WO pass the related US applicationNumber/patentNumber. EP comes from Global Dossier; pass a US applicationNumber/patentNumber (the family is traversed) or the EP application number (e.g. 'EP1234567'). Always call this before attach to get exact identifiers.",
    schema: j.object({
      applicationNumber: j
        .string()
        .describe(
          "Application number. For US/WO use the US app number (e.g. '12345678'). For EP, pass the US app number to traverse the family, or the EP number directly (e.g. '1234567')."
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
      const usptoKey = process.env.USPTO_API_KEY
      if (!usptoKey) throw new Error("USPTO_API_KEY env var is not set")
      const { applicationNumber, patentNumber } = input
      if (!applicationNumber && !patentNumber) {
        return {
          error: "missing_identifier",
          message: "Provide either applicationNumber or patentNumber.",
        } as never
      }
      const jurisdiction: Jurisdiction =
        (input.jurisdiction as Jurisdiction | null) ??
        (applicationNumber ? detectJurisdiction(applicationNumber) : "US")
      const inv = await buildDocInventory({
        jurisdiction,
        applicationNumber,
        patentNumber,
        usptoKey,
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
      "Fetch a prosecution-history document (US, PCT/WO, or EP) as a full PDF and attach it as a hosted sub-page under a Notion page. Resolves via the same source as listProsecutionDocuments — ALWAYS call that first to get the exact documentIdentifier. Picks by documentIdentifier (preferred) or documentCode (+ optional documentDate). Requires NOTION_API_TOKEN. Large EP file-wrapper documents (over ~25 pages) are refused — the EP Register is rate-limited; the published application is fetched in full via EPO OPS regardless of size.",
    schema: j.object({
      applicationNumber: j
        .string()
        .describe(
          "US/WO: the US app number. EP: a US app number (family traversed) or the EP number. Provide this OR patentNumber."
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
    execute: async (input, { notion }) => {
      const usptoKey = process.env.USPTO_API_KEY
      if (!usptoKey) throw new Error("USPTO_API_KEY env var is not set")
      const notionToken = process.env.NOTION_API_TOKEN
      if (!notionToken) {
        return {
          error: "missing_notion_token",
          message:
            "NOTION_API_TOKEN env var is not set. attach needs it for the multipart byte upload: ntn workers env set NOTION_API_TOKEN=<integration-token> && ntn workers env push",
        } as never
      }
      const { applicationNumber, patentNumber, documentCode } = input
      const blockType = input.blockType ?? "pdf"
      if (!applicationNumber && !patentNumber) {
        return {
          error: "missing_identifier",
          message: "Provide either applicationNumber or patentNumber.",
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
      const jurisdiction: Jurisdiction =
        (input.jurisdiction as Jurisdiction | null) ??
        (applicationNumber ? detectJurisdiction(applicationNumber) : "US")

      const inv = await buildDocInventory({
        jurisdiction,
        applicationNumber,
        patentNumber,
        usptoKey,
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

      // Select the target: documentIdentifier wins, else code (+ optional date), else newest.
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
      } else if (input.documentDate) {
        const dateMatches = codeMatches.filter(
          (d) => d.date === input.documentDate
        )
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

      // Fetch the PDF bytes per source.
      let pdfBuffer: Buffer
      try {
        if (target._fetch.kind === "us") {
          const pdfRes = await fetchWithTimeout(target._fetch.downloadUrl, {
            headers: { "X-API-KEY": usptoKey },
          })
          if (!pdfRes.ok)
            return { error: "pdf_fetch_failed", status: pdfRes.status } as never
          pdfBuffer = Buffer.from(await pdfRes.arrayBuffer())
        } else if (target._fetch.kind === "opsImage") {
          pdfBuffer = await opsDownloadFullPdf(
            target._fetch.link,
            target._fetch.pages
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
            target._fetch.pages
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

      const docDate = target.date ?? "undated"
      const safeCode = (target.code || "DOC").replace(/[^A-Za-z0-9._-]/g, "_")
      const filename = `${inv.sourceAppNum}-${safeCode}-${docDate}.pdf`

      // 1. Create the file_upload (JSON via the managed SDK client).
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

      // 2. Send the bytes (multipart — the bundled SDK can't, so raw fetch
      // with the integration token; let fetch set the boundary).
      const form = new FormData()
      form.append(
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
        body: form,
      })
      if (!sendRes.ok)
        return {
          error: "upload_send_failed",
          status: sendRes.status,
          message: await sendRes.text().catch(() => ""),
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
      const title =
        docDate === "undated"
          ? (target.description ?? target.code)
          : `${target.description ?? target.code} — ${docDate}`
      const createRes = (await notion.request({
        path: "pages",
        method: "post",
        body: {
          parent: { page_id: normalizedPageId },
          properties: { title: { title: [{ text: { content: title } }] } },
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
