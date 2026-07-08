// ──────────────────────────────────────────────────────────────────────
// PDF assembly — fetch per-page, merge into one document
// ──────────────────────────────────────────────────────────────────────
//
// Both EP full-document sources (EPO OPS images and the EP Register
// file-inspection) serve ONE page per request — there is no whole-document
// endpoint. So we fetch the pages concurrently (bounded) but keep them
// page-indexed and merge in order. Fetching pages sequentially blows the hard
// ~60s tool-execution limit on large documents; a worker tool is not a sync,
// so there is no multi-cycle budget to fall back on.

import { PDFDocument } from "pdf-lib"

// Fetch `total` pages via `fetchPage(n)` (1-based) and stitch them into a
// single PDF. `concurrency` bounds in-flight requests — keep it low for
// rate-limited sources. Page order is preserved regardless of completion order.
export async function fetchAndMergePdfPages(
  total: number,
  concurrency: number,
  fetchPage: (pageNum: number) => Promise<Uint8Array>
): Promise<Buffer> {
  const buffers: Array<Uint8Array | null> = new Array(total).fill(null)
  let nextPage = 0
  const pump = async (): Promise<void> => {
    while (true) {
      const i = nextPage++
      if (i >= total) return
      buffers[i] = await fetchPage(i + 1)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, pump))

  const merged = await PDFDocument.create()
  for (let i = 0; i < total; i++) {
    const buf = buffers[i]
    if (!buf) throw new Error(`page ${i + 1}/${total} missing`)
    const src = await PDFDocument.load(buf, { ignoreEncryption: true })
    const copied = await merged.copyPages(src, src.getPageIndices())
    for (const pg of copied) merged.addPage(pg)
  }
  return Buffer.from(await merged.save())
}
