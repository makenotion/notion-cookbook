// ──────────────────────────────────────────────────────────────────────
// PDF assembly — fetch per-page, merge into one document
// ──────────────────────────────────────────────────────────────────────
//
// Both EP full-document sources (EPO OPS images and the EP Register
// file-inspection) serve ONE page per request — there is no whole-document
// endpoint. So we fetch the pages concurrently (bounded) but keep them
// page-indexed and merge in order. Fetching pages sequentially blows the hard
// ~60s tool-execution limit on large documents; the caller deliberately stops
// at 55s to leave cleanup and response headroom. A worker tool is not a sync,
// so there is no multi-cycle budget to fall back on.

import { PDFDocument } from "pdf-lib"

export type PdfSourceByteBudget = {
  readonly limit: number
  readonly used: number
}

type MutablePdfSourceByteBudget = {
  limit: number
  used: number
}

export function createPdfSourceByteBudget(limit: number): PdfSourceByteBudget {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error(`invalid PDF source-byte limit: ${limit}`)
  return { limit, used: 0 }
}

export type BoundedResponseBytes = {
  bytes: Uint8Array
  release: () => void
}

// Read a response body incrementally while claiming bytes from a shared
// document budget. Page fetches can run concurrently, so enforcing a separate
// per-response cap would still allow several 20 MiB bodies to be buffered at
// once. A caller must release a failed/retried body; successful page bodies
// retain their claim until the document operation finishes.
export async function readBoundedPdfResponse(
  response: Response,
  budget: PdfSourceByteBudget,
  context: string
): Promise<BoundedResponseBytes> {
  const mutable = budget as MutablePdfSourceByteBudget
  if (
    !Number.isSafeInteger(mutable.limit) ||
    mutable.limit < 1 ||
    !Number.isSafeInteger(mutable.used) ||
    mutable.used < 0 ||
    mutable.used > mutable.limit
  )
    throw new Error(`${context}: invalid shared PDF source-byte budget`)

  const rawContentLength = response.headers.get("content-length")
  if (rawContentLength != null) {
    if (!/^\d+$/.test(rawContentLength)) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(
        `${context} Content-Length: malformed value ${JSON.stringify(rawContentLength)}`
      )
    }
    const declared = Number(rawContentLength)
    if (!Number.isSafeInteger(declared)) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(
        `${context} Content-Length: invalid byte length ${rawContentLength}`
      )
    }
    if (mutable.used + declared > mutable.limit) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(
        `${context} Content-Length: ${declared} bytes exceeds the remaining ${mutable.limit - mutable.used} bytes of the ${mutable.limit}-byte PDF source limit`
      )
    }
  }

  if (!response.body) throw new Error(`${context}: response has no body`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let claimed = 0
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    mutable.used -= claimed
    claimed = 0
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!(value instanceof Uint8Array))
        throw new Error(`${context}: response body yielded invalid bytes`)
      if (mutable.used + value.byteLength > mutable.limit) {
        const attempted = mutable.used + value.byteLength
        await reader.cancel().catch(() => undefined)
        throw new Error(
          `${context}: ${attempted} bytes exceeds the shared ${mutable.limit}-byte PDF source limit`
        )
      }
      mutable.used += value.byteLength
      claimed += value.byteLength
      chunks.push(value)
    }

    const bytes = new Uint8Array(claimed)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, release }
  } catch (error) {
    release()
    throw error
  } finally {
    reader.releaseLock()
  }
}

const hasPdfHeader = (bytes: Uint8Array): boolean => {
  const limit = Math.min(bytes.length - 4, 1024)
  for (let i = 0; i <= limit; i++) {
    if (
      bytes[i] === 0x25 &&
      bytes[i + 1] === 0x50 &&
      bytes[i + 2] === 0x44 &&
      bytes[i + 3] === 0x46 &&
      bytes[i + 4] === 0x2d
    )
      return true
  }
  return false
}

// Validate both the PDF signature and structure. Upstream throttles sometimes
// return an HTML error page with HTTP 200, and checking only status or
// content-type would let that page reach Notion as a corrupt attachment.
export async function validatePdfBytes(
  bytes: Uint8Array,
  context: string,
  expectedPages?: number
): Promise<number> {
  if (!hasPdfHeader(bytes)) throw new Error(`${context}: missing PDF signature`)
  let pdf: PDFDocument
  try {
    pdf = await PDFDocument.load(bytes, { ignoreEncryption: true })
  } catch (error) {
    throw new Error(
      `${context}: malformed PDF (${error instanceof Error ? error.message : String(error)})`
    )
  }
  const pages = pdf.getPageCount()
  if (pages < 1) throw new Error(`${context}: PDF contains no pages`)
  if (expectedPages != null && pages !== expectedPages)
    throw new Error(
      `${context}: expected ${expectedPages} PDF page${expectedPages === 1 ? "" : "s"}, received ${pages}`
    )
  return pages
}

// Fetch `total` pages via `fetchPage(n)` (1-based) and stitch them into a
// single PDF. `concurrency` bounds in-flight requests — keep it low for
// rate-limited sources. Page order is preserved regardless of completion order.
export async function fetchAndMergePdfPages(
  total: number,
  concurrency: number,
  fetchPage: (pageNum: number) => Promise<Uint8Array>,
  maxSourceBytes = Number.POSITIVE_INFINITY
): Promise<Buffer> {
  if (!Number.isSafeInteger(total) || total < 1)
    throw new Error(`invalid PDF page count: ${total}`)
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new Error(`invalid PDF fetch concurrency: ${concurrency}`)
  if (
    maxSourceBytes !== Number.POSITIVE_INFINITY &&
    (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1)
  )
    throw new Error(`invalid PDF source-byte limit: ${maxSourceBytes}`)
  const buffers: Array<Uint8Array | null> = new Array(total).fill(null)
  let nextPage = 0
  let sourceBytes = 0
  let stopped = false
  let firstError: unknown = null
  const pump = async (): Promise<void> => {
    try {
      while (!stopped) {
        const i = nextPage++
        if (i >= total) return
        const page = await fetchPage(i + 1)
        if (stopped) return
        const nextSourceBytes = sourceBytes + page.byteLength
        if (nextSourceBytes > maxSourceBytes)
          throw new Error(
            `PDF source bytes exceed the ${maxSourceBytes}-byte limit at page ${i + 1}/${total}`
          )
        sourceBytes = nextSourceBytes
        await validatePdfBytes(page, `page ${i + 1}/${total}`, 1)
        if (stopped) return
        buffers[i] = page
      }
    } catch (error) {
      stopped = true
      if (firstError == null) firstError = error
    }
  }
  // Promise.all would reject before other pumps settle. Await every in-flight
  // pump so a failed tool invocation cannot leave page requests running in the
  // background and consuming the upstream quota.
  await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, total) }, pump)
  )
  if (firstError != null) throw firstError

  const merged = await PDFDocument.create()
  for (let i = 0; i < total; i++) {
    const buf = buffers[i]
    if (!buf) throw new Error(`page ${i + 1}/${total} missing`)
    const src = await PDFDocument.load(buf, { ignoreEncryption: true })
    const copied = await merged.copyPages(src, src.getPageIndices())
    for (const pg of copied) merged.addPage(pg)
  }
  const result = Buffer.from(await merged.save())
  await validatePdfBytes(result, "merged PDF", total)
  return result
}
