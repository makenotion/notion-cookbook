// ──────────────────────────────────────────────────────────────────────
// Minimal .xlsx reader (zero dependencies)
// ──────────────────────────────────────────────────────────────────────
//
// Turns counsel's docket reports into string cell grids inside the worker
// runtime — no npm xlsx dependency, so the worker bundle stays small and
// the platform build stays fast. Scope deliberately covers what real
// docketing-system exports need and nothing more:
//
//   • ZIP: stored (0) + deflate (8) entries via node:zlib inflateRawSync.
//     No zip64, no encryption — sizes come from the central directory,
//     which every real-world xlsx writer populates.
//   • XML: regex-scanned, namespace-tolerant (some generators emit
//     <x:row>/<x:c>; Excel itself emits unprefixed <row>/<c>).
//   • Cells: shared strings (rich runs concatenated, phonetic guides
//     stripped), inline strings, formula strings, booleans, and numbers.
//     Numbers whose style carries a date number format — including the
//     Mac-legacy 1904 date system — are converted to ISO yyyy-mm-dd.

import { inflateRawSync } from "node:zlib"

// ── ZIP ────────────────────────────────────────────────────────────────

type ZipEntry = { offset: number; compressedSize: number; method: number }

function zipEntries(buf: Buffer): Map<string, ZipEntry> {
  // End-of-central-directory: scan backwards past the (usually empty)
  // archive comment for the signature.
  let eocd = -1
  for (
    let i = buf.length - 22;
    i >= Math.max(0, buf.length - 22 - 65535);
    i--
  ) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0)
    throw new Error("not a zip file (no end-of-central-directory record)")
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16) // central directory offset
  const entries = new Map<string, ZipEntry>()
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50)
      throw new Error("corrupt zip central directory")
    const method = buf.readUInt16LE(p + 10)
    const compressedSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const offset = buf.readUInt32LE(p + 42)
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen)
    entries.set(name, { offset, compressedSize, method })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function zipRead(
  buf: Buffer,
  entries: Map<string, ZipEntry>,
  name: string
): Buffer | null {
  const e = entries.get(name)
  if (!e) return null
  if (buf.readUInt32LE(e.offset) !== 0x04034b50)
    throw new Error(`corrupt zip local header for ${name}`)
  const nameLen = buf.readUInt16LE(e.offset + 26)
  const extraLen = buf.readUInt16LE(e.offset + 28)
  const start = e.offset + 30 + nameLen + extraLen
  const raw = buf.subarray(start, start + e.compressedSize)
  if (e.method === 0) return Buffer.from(raw)
  if (e.method === 8) return inflateRawSync(raw)
  throw new Error(`unsupported zip compression method ${e.method} for ${name}`)
}

// ── XML helpers ────────────────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(parseInt(h, 16))
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

// Concatenated text of every <t> inside a fragment (rich-text runs split
// one logical string across several <t> elements). Phonetic guide runs
// (<rPh>, furigana on Japanese-IME-touched cells) carry their own <t> that
// is NOT part of the cell text — strip them first.
function textRuns(fragment: string): string {
  const bare = fragment.replace(
    /<(?:\w+:)?rPh(?:\s[^>]*)?>[\s\S]*?<\/(?:\w+:)?rPh>/g,
    ""
  )
  let out = ""
  const re = /<(?:\w+:)?t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(bare))) out += decodeEntities(m[1] ?? "")
  return out
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)(?:\\w+:)?${name}="([^"]*)"`).exec(tag)
  return m ? decodeEntities(m[1]) : null
}

// ── Number formats (date detection) ────────────────────────────────────

// Built-in date/time numFmtIds per ECMA-376 §18.8.30, plus the reserved
// locale-specific date ranges (27-36 East Asian, 50-58, 71-81 Thai) so a
// re-saved report with a locale date style still parses as a date instead
// of leaking raw serial numbers into the grid.
const BUILTIN_DATE_FMTS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58, 71, 72, 73, 74, 75, 76, 77,
  78, 79, 80, 81,
])

function isDateFormatCode(code: string): boolean {
  // Strip quoted literals, [Red]/[h]-style bracket sections, and escaped
  // chars, then look for date/time tokens.
  const bare = code
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "")
  return /[ymdh]/i.test(bare)
}

// Excel serial day → ISO date. Excel's day 0 is 1899-12-30 in the 1900
// system (the offset absorbs the fictitious 1900-02-29); 25569 days later
// is the Unix epoch. Workbooks saved in the Mac-legacy 1904 system count
// from 1904-01-01 — 1,462 days later — and silently shift every date by 4
// years if unhandled. Report dates are whole days: round and truncate.
function excelSerialToIso(serial: number, date1904: boolean): string {
  const adjusted = serial + (date1904 ? 1462 : 0)
  return new Date(Math.round((adjusted - 25569) * 86_400_000))
    .toISOString()
    .slice(0, 10)
}

// ── Workbook ───────────────────────────────────────────────────────────

function firstSheetPath(buf: Buffer, entries: Map<string, ZipEntry>): string {
  const workbook = zipRead(buf, entries, "xl/workbook.xml")?.toString("utf8")
  const rels = zipRead(buf, entries, "xl/_rels/workbook.xml.rels")?.toString(
    "utf8"
  )
  const fallback = "xl/worksheets/sheet1.xml"
  if (!workbook || !rels) return fallback
  const sheetTag = /<(?:\w+:)?sheet\s[^>]*>/.exec(workbook)?.[0]
  const rid = sheetTag ? attr(sheetTag, "id") : null // r:id, prefix-stripped
  if (!rid) return fallback
  const relTag = new RegExp(`<Relationship\\s[^>]*Id="${rid}"[^>]*>`).exec(
    rels
  )?.[0]
  const target = relTag ? attr(relTag, "Target") : null
  if (!target) return fallback
  return target.startsWith("/") ? target.slice(1) : `xl/${target}`
}

// Column letters of an A1-style cell ref → 0-based column index.
function colIndex(ref: string): number {
  let n = 0
  for (const ch of ref) {
    const c = ch.charCodeAt(0)
    if (c < 65 || c > 90) break
    n = n * 26 + (c - 64)
  }
  return n - 1
}

// ── Public API ─────────────────────────────────────────────────────────

// Parse the first worksheet into a dense grid of trimmed cell strings
// (1 outer element per spreadsheet row, gaps included so row numbers line
// up with what counsel sees in Excel). Date-styled numeric cells become
// ISO yyyy-mm-dd strings.
export function parseXlsxSheet(data: Buffer | ArrayBuffer): string[][] {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const entries = zipEntries(buf)

  // 1904-date-system flag lives on <workbookPr> (Mac-legacy workbooks).
  const workbookXml =
    zipRead(buf, entries, "xl/workbook.xml")?.toString("utf8") ?? ""
  const date1904 = /<(?:\w+:)?workbookPr\s[^>]*date1904="(?:1|true)"/.test(
    workbookXml
  )

  const shared: string[] = []
  const sst = zipRead(buf, entries, "xl/sharedStrings.xml")?.toString("utf8")
  if (sst) {
    // Self-closed <si/> entries still occupy an index — missing them
    // shifts every later shared string by one.
    const re = /<(?:\w+:)?si(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(sst))) shared.push(textRuns(m[1] ?? ""))
  }

  // Style index → "is this a date format" (via cellXfs → numFmtId).
  const dateStyles = new Set<number>()
  const styles = zipRead(buf, entries, "xl/styles.xml")?.toString("utf8")
  if (styles) {
    const customDateFmts = new Set<number>()
    const numFmtRe = /<(?:\w+:)?numFmt\s[^>]*>/g
    let m: RegExpExecArray | null
    while ((m = numFmtRe.exec(styles))) {
      const id = Number(attr(m[0], "numFmtId") ?? -1)
      const code = attr(m[0], "formatCode") ?? ""
      if (id >= 0 && isDateFormatCode(code)) customDateFmts.add(id)
    }
    const cellXfs =
      /<(?:\w+:)?cellXfs[\s\S]*?<\/(?:\w+:)?cellXfs>/.exec(styles)?.[0] ?? ""
    const xfRe = /<(?:\w+:)?xf\b[^>]*>/g
    let i = 0
    while ((m = xfRe.exec(cellXfs))) {
      const fmt = Number(attr(m[0], "numFmtId") ?? 0)
      if (BUILTIN_DATE_FMTS.has(fmt) || customDateFmts.has(fmt))
        dateStyles.add(i)
      i++
    }
  }

  const sheetXml = zipRead(
    buf,
    entries,
    firstSheetPath(buf, entries)
  )?.toString("utf8")
  if (!sheetXml) throw new Error("xlsx has no first worksheet")

  const byRow = new Map<number, string[]>()
  let maxRow = 0
  const rowRe = /<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g
  let rm: RegExpExecArray | null
  while ((rm = rowRe.exec(sheetXml))) {
    const rowNum = Number(attr(`<row ${rm[1]}>`, "r") ?? 0)
    if (!rowNum) continue
    maxRow = Math.max(maxRow, rowNum)
    const cells: string[] = []
    const cellRe = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g
    let cm: RegExpExecArray | null
    let nextCol = 0
    while ((cm = cellRe.exec(rm[2]))) {
      const tag = `<c ${cm[1]}>`
      const body = cm[2] ?? ""
      const ref = attr(tag, "r")
      const col = ref ? colIndex(ref) : nextCol
      nextCol = col + 1
      const type = attr(tag, "t") ?? "n"
      const style = Number(attr(tag, "s") ?? -1)
      const v = /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/.exec(
        body
      )?.[1]
      let value = ""
      if (type === "s") {
        value = v !== undefined ? (shared[Number(v)] ?? "") : ""
      } else if (type === "inlineStr") {
        value = textRuns(body)
      } else if (type === "str") {
        value = v !== undefined ? decodeEntities(v) : ""
      } else if (type === "b") {
        value = v === "1" ? "TRUE" : "FALSE"
      } else if (type === "e") {
        value = ""
      } else if (v !== undefined && v !== "") {
        const n = Number(v)
        value =
          dateStyles.has(style) && Number.isFinite(n)
            ? excelSerialToIso(n, date1904)
            : decodeEntities(v)
      }
      cells[col] = value.trim()
    }
    // Dense row: fill holes so header/value zips stay positional.
    for (let i = 0; i < cells.length; i++)
      if (cells[i] === undefined) cells[i] = ""
    byRow.set(rowNum, cells)
  }

  // A single stray cell parked in a bottom row (the "Ctrl+End says row
  // 1048576" disease after hand-editing) would balloon the dense grid to
  // ~1M rows and tens of MB — fail loudly instead.
  if (maxRow > 100_000) {
    throw new Error(
      `sheet claims ${maxRow} rows — stray cells far below the data? refusing to parse`
    )
  }

  const grid: string[][] = []
  for (let r = 1; r <= maxRow; r++) grid.push(byRow.get(r) ?? [])
  return grid
}
