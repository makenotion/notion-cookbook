// Offline tests for the trademark-portfolio sync worker.
// Run from this directory with `npm test` — no network or credentials needed.

import assert from "node:assert/strict"
import { test } from "node:test"

import { DERIVATION_VERSION, fingerprint } from "./src/engine/fingerprint.js"
import type { SourceSnapshots } from "./src/engine/resilience.js"
import { packSnapshots, unpackSnapshots } from "./src/engine/state.js"
import { addMonths, computeNextDeadline, statusBucket } from "./src/join.js"
import {
  classifyReportName,
  parseDocketReport,
  parsePropertiesReport,
  reportDateFromName,
} from "./src/sources/counsel-docket.js"
import type { UsCase } from "./src/sources/types.js"

// ── Engine ─────────────────────────────────────────────────────────────

test("fingerprint is stable and independent of object key order", () => {
  const a = fingerprint({ b: 1, a: 2, nested: { y: 1, x: 2 } })
  const b = fingerprint({ a: 2, b: 1, nested: { x: 2, y: 1 } })
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{16}$/)
})

test("fingerprint changes when a value changes", () => {
  assert.notEqual(
    fingerprint({ status: "Pending" }),
    fingerprint({ status: "Registered" })
  )
})

test("DERIVATION_VERSION is a non-empty part of the fingerprint contract", () => {
  assert.ok(DERIVATION_VERSION.length > 0)
})

test("snapshots survive a gzip+base64 round-trip", () => {
  const snapshots: SourceSnapshots = {
    uspto: {
      data: { "12345678": { serial: "12345678" } },
      lastSuccessAt: "2026-07-01T00:00:00Z",
    },
  }
  const packed = packSnapshots(snapshots)
  assert.deepEqual(unpackSnapshots(packed, undefined), snapshots)
})

test("a corrupt snapshot blob degrades to empty instead of throwing", () => {
  assert.deepEqual(unpackSnapshots("!!not-gzip-base64!!", undefined), {})
})

// ── Derivations ────────────────────────────────────────────────────────

const usCase = (over: Partial<UsCase>): UsCase => ({
  serial: "12345678",
  registrationNumber: null,
  wordmark: "EXAMPLE",
  markDescription: null,
  hasDesignElement: false,
  statusText: null,
  tm5StatusDesc: null,
  statusDate: null,
  filingDate: null,
  registrationDate: null,
  publishedDate: null,
  noticeOfAllowanceDate: null,
  dateAbandoned: null,
  dateCancelled: null,
  basis: null,
  niceClasses: ["009"],
  goodsAndServices: null,
  section8Accepted: false,
  register: null,
  irNumber: null,
  attorneyDocket: null,
  disclaimer: null,
  ...over,
})

test("statusBucket: descriptor keywords never kill a LIVE mark", () => {
  // A live registration facing a TTAB cancellation must stay Registered —
  // bucketing it Cancelled would also suppress its renewal deadline.
  const underAttack = usCase({
    registrationNumber: "7654321",
    tm5StatusDesc: "LIVE/REGISTRATION/Issued and Active",
    statusText:
      "A cancellation proceeding is pending at the Trademark Trial and Appeal Board.",
  })
  assert.equal(statusBucket(underAttack), "Registered")
  // …but the same keyword on a DEAD mark disambiguates the dead state.
  const cancelled = usCase({
    registrationNumber: "7654321",
    tm5StatusDesc: "DEAD/REGISTRATION/Cancelled",
    statusText: "Registration cancelled.",
    dateCancelled: "2025-01-02",
  })
  assert.equal(statusBucket(cancelled), "Cancelled")
})

test("addMonths clamps month ends (Jan 31 + 3mo → Apr 30)", () => {
  assert.equal(addMonths("2026-01-31", 3), "2026-04-30")
  assert.equal(addMonths("2024-02-29", 12), "2025-02-28") // leap clamp
})

test("registered marks: §8 at year 6, then 10-year renewals once accepted", () => {
  const s8 = computeNextDeadline(
    usCase({
      registrationNumber: "7654321",
      registrationDate: "2022-09-06",
      statusText: "Registered.",
    }),
    "2026-07-01"
  )
  assert.deepEqual(s8, { date: "2028-09-06", type: "§8 Declaration" })
  const renewal = computeNextDeadline(
    usCase({
      registrationNumber: "7654321",
      registrationDate: "2016-11-29",
      section8Accepted: true,
      statusText: "Registered.",
    }),
    "2026-07-01"
  )
  assert.deepEqual(renewal, { date: "2026-11-29", type: "§8/§9 Renewal" })
})

test("SOU pipeline runs on a 6-month lattice from the NOA date", () => {
  const d = computeNextDeadline(
    usCase({
      statusText: "Second extension granted.",
      noticeOfAllowanceDate: "2025-02-25",
    }),
    "2026-07-01"
  )
  // 6/12 months passed; the next lattice point is NOA + 18 months.
  assert.deepEqual(d, { date: "2026-08-25", type: "Statement of Use" })
})

test("closed opposition windows are noise, not deadlines", () => {
  const d = computeNextDeadline(
    usCase({
      statusText: "Published for opposition.",
      publishedDate: "2026-01-01",
    }),
    "2026-07-01"
  )
  assert.equal(d, null)
})

// ── Counsel-report parsing (grids stand in for parsed .xlsx sheets) ────

test("classifyReportName distinguishes the two reports by filename", () => {
  assert.equal(
    classifyReportName("ACME CORP - Docket Report 07172026.xlsx"),
    "docket"
  )
  assert.equal(
    classifyReportName("ACME CORP - Properties Report 07172026.xlsx"),
    "properties"
  )
  // Separator/case drift between counsel's export runs must not matter.
  assert.equal(
    classifyReportName("ACME_Docket_Report_-_07272026.xlsx"),
    "docket"
  )
  assert.equal(classifyReportName("DOCKETREPORT.xlsx"), "docket")
  assert.equal(classifyReportName("DOCKET.xlsx"), "docket")
  assert.equal(
    classifyReportName("docket-properties-combined.xlsx"),
    "properties"
  )
  assert.equal(classifyReportName("random-attachment.xlsx"), null)
  assert.equal(classifyReportName("Docket Report.pdf"), null)
})

test("reportDateFromName reads the MMDDYYYY filename token", () => {
  assert.equal(
    reportDateFromName("ACME - Properties Report 07172026.xlsx"),
    "2026-07-17"
  )
  assert.equal(
    reportDateFromName("ACME_Docket_Report_-_07272026.xlsx"),
    "2026-07-27"
  )
  assert.equal(reportDateFromName("Docket 2026-07-27.xlsx"), "2026-07-27")
  assert.equal(reportDateFromName("no-date.xlsx"), null)
})

const PROPS_HEADER = [
  "Image",
  "Mark Name",
  "Country",
  "Application #",
  "File Date",
  "Registration #",
  "Registration Date",
  "Status",
  "Owner Name",
  "Classes Combined",
]
const propsRow = (
  mark: string,
  country: string,
  app: string,
  status = "REGISTERED",
  owner = "ACME Corporation"
) => ["", mark, country, app, "2020-01-15", "", "", status, owner, "009, 042"]

test("properties report: parses rows and flags lapse instructions", () => {
  const grid = [
    PROPS_HEADER,
    ...Array.from({ length: 60 }, (_, i) =>
      propsRow(`MARK ${i}`, "UNITED STATES", `9${i}`.padStart(8, "0"))
    ),
    propsRow("OLD MARK", "JAPAN", "2020123456", "ALLOW TO LAPSE"),
  ]
  const { entries } = parsePropertiesReport(grid, {
    ownerNames: ["ACME Corporation"],
  })
  assert.equal(entries.length, 61)
  const lapsed = entries.find((e) => e.mark === "OLD MARK")
  assert.ok(lapsed)
  assert.equal(lapsed.office, "JP")
  assert.equal(lapsed.lapseInstructed, true)
})

test("properties report: refuses another company's portfolio", () => {
  const grid = [
    PROPS_HEADER,
    ...Array.from({ length: 60 }, (_, i) =>
      propsRow(
        `MARK ${i}`,
        "UNITED STATES",
        `9${i}`.padStart(8, "0"),
        "REGISTERED",
        "Someone Else Inc."
      )
    ),
  ]
  assert.throws(
    () => parsePropertiesReport(grid, { ownerNames: ["ACME Corporation"] }),
    /another client/
  )
})

test("properties report: refuses a renamed/reformatted header", () => {
  const grid = [["Mark", "Country"], propsRow("X", "UNITED STATES", "90000001")]
  assert.throws(
    () => parsePropertiesReport(grid, { ownerNames: ["ACME Corporation"] }),
    /header row is missing/
  )
})

const DOCKET_HEADER = [
  "Current Due Date",
  "Action Name",
  "Reference #",
  "Title",
  "Client Reference",
  "Country ID",
  "Reg/Serial",
]

test("docket report: parses actions below the criteria preamble", () => {
  const grid = [
    ["ACME CORPORATION"],
    ["Client: 123456"],
    DOCKET_HEADER,
    [
      "2026-08-24",
      "STATEMENT OF USE",
      "T1234US00",
      "MARK A",
      "",
      "US",
      "91/234,567",
    ],
    ["2026-11-29", "RENEWAL", "T5678US00", "MARK B", "", "US", "7,654,321"],
  ]
  const { actions } = parseDocketReport(grid, {
    clientNumber: "123456",
    allowEmpty: false,
  })
  assert.equal(actions.length, 2)
  assert.equal(actions[0].dueDate, "2026-08-24")
  assert.equal(actions[0].number, "91234567")
})

test("docket report: refuses a report exported for the wrong client", () => {
  const grid = [
    ["Client: 999999"],
    DOCKET_HEADER,
    [
      "2026-08-24",
      "STATEMENT OF USE",
      "T1234US00",
      "MARK A",
      "",
      "US",
      "91/234,567",
    ],
  ]
  assert.throws(
    () =>
      parseDocketReport(grid, { clientNumber: "123456", allowEmpty: false }),
    /client/
  )
})

test("docket report: unparseable due dates fail loudly, not silently", () => {
  const grid = [
    DOCKET_HEADER,
    [
      "08/24/2026",
      "STATEMENT OF USE",
      "T1234US00",
      "MARK A",
      "",
      "US",
      "91/234,567",
    ],
  ]
  assert.throws(
    () => parseDocketReport(grid, { clientNumber: null, allowEmpty: false }),
    /did not parse/
  )
})
