// Offline tests for the patent-portfolio sync worker.
// Run from this directory with `npm test` — no network or credentials needed.

import assert from "node:assert/strict"
import { test } from "node:test"

import { DERIVATION_VERSION, fingerprint } from "./src/engine/fingerprint.js"
import type { SourceSnapshots } from "./src/engine/resilience.js"
import { packSnapshots, unpackSnapshots } from "./src/engine/state.js"

// Change detection: the delta re-emits a row only when its fingerprint
// changes, so the hash must be stable, independent of object key order, and
// sensitive to real value changes.
test("fingerprint is stable and independent of object key order", () => {
  const a = fingerprint({ b: 1, a: 2, nested: { y: 1, x: 2 } })
  const b = fingerprint({ a: 2, b: 1, nested: { x: 2, y: 1 } })
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{16}$/)
})

test("fingerprint changes when a value changes", () => {
  assert.notEqual(
    fingerprint({ status: "Pending" }),
    fingerprint({ status: "Granted" })
  )
})

test("DERIVATION_VERSION is a non-empty part of the fingerprint contract", () => {
  // Bumping it forces a one-time full re-emit when a derivation rule changes
  // but its raw inputs do not.
  assert.ok(DERIVATION_VERSION.length > 0)
})

// State discipline: snapshots are stored gzip+base64 to stay under the
// sync-state size cap, and a corrupt blob must degrade to "no snapshots"
// rather than crash the cycle.
test("snapshots survive a gzip+base64 round-trip", () => {
  const snapshots: SourceSnapshots = {
    uspto: {
      data: [{ applicationNumber: "US1", title: "A" }],
      lastSuccessAt: "2026-07-01T00:00:00Z",
    },
    epo: { data: [], lastSuccessAt: "2026-07-01T00:00:00Z" },
  }
  const packed = packSnapshots(snapshots)
  assert.equal(typeof packed, "string")
  assert.deepEqual(unpackSnapshots(packed, undefined), snapshots)
})

test("a corrupt snapshot blob degrades to empty instead of throwing", () => {
  assert.deepEqual(unpackSnapshots("!!not-gzip-base64!!", undefined), {})
})

test("unpack falls back to legacy plain snapshots when nothing is packed", () => {
  const legacy: SourceSnapshots = {
    uspto: { data: [], lastSuccessAt: "2026-07-01T00:00:00Z" },
  }
  assert.deepEqual(unpackSnapshots(undefined, legacy), legacy)
})
