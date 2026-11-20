import assert from "node:assert/strict"
import test from "node:test"
import { nextGridIndex } from "../blocks/icon-picker/src/selection"

test("arrows move by column or row in the eight-column grid", () => {
  assert.equal(nextGridIndex("ArrowRight", 2, 20), 3)
  assert.equal(nextGridIndex("ArrowLeft", 2, 20), 1)
  assert.equal(nextGridIndex("ArrowDown", 2, 20), 10)
  assert.equal(nextGridIndex("ArrowUp", 10, 20), 2)
})

test("arrows stop at the edges and the incomplete last row", () => {
  assert.equal(nextGridIndex("ArrowLeft", 0, 10), 0)
  assert.equal(nextGridIndex("ArrowUp", 3, 10), 0)
  assert.equal(nextGridIndex("ArrowRight", 9, 10), 9)
  assert.equal(nextGridIndex("ArrowDown", 6, 10), 9)
})

test("Home and End reach the first and last result", () => {
  assert.equal(nextGridIndex("Home", 7, 13), 0)
  assert.equal(nextGridIndex("End", 7, 13), 12)
})

test("Tab and selection keys retain native button behavior", () => {
  assert.equal(nextGridIndex("Tab", 2, 13), undefined)
  assert.equal(nextGridIndex("Enter", 2, 13), undefined)
  assert.equal(nextGridIndex(" ", 2, 13), undefined)
})

test("an empty result list has no focus target", () => {
  assert.equal(nextGridIndex("Home", 0, 0), undefined)
})
