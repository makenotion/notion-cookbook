import assert from "node:assert/strict"
import { test } from "node:test"

import { normalizeUuid, pageIdFromUrl } from "./uuid.ts"

test("normalizeUuid accepts dashed UUIDs", () => {
  assert.equal(
    normalizeUuid("  F04E1A2B-3C4D-4E5F-8A9B-0C1D2E3F4A5B "),
    "f04e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b"
  )
})

test("normalizeUuid converts compact UUIDs", () => {
  assert.equal(
    normalizeUuid("f04e1a2b3c4d4e5f8a9b0c1d2e3f4a5b"),
    "f04e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b"
  )
})

test("normalizeUuid rejects non-UUIDs", () => {
  for (const value of [
    "",
    "abc",
    "f04e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5",
    "g04e1a2b3c4d4e5f8a9b0c1d2e3f4a5b",
    "f04e1a2b3c4d-4e5f-8a9b-0c1d2e3f4a5b",
  ]) {
    assert.equal(normalizeUuid(value), null, value)
  }
})

test("pageIdFromUrl reads the trailing page ID", () => {
  assert.equal(
    pageIdFromUrl(
      "https://www.notion.so/Some-row-f04e1a2b3c4d4e5f8a9b0c1d2e3f4a5b?pvs=4"
    ),
    "f04e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b"
  )
  assert.equal(pageIdFromUrl(null), null)
  assert.equal(pageIdFromUrl("https://www.notion.so/no-id"), null)
})
