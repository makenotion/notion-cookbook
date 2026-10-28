import assert from "node:assert/strict"
import test from "node:test"
import {
  boundingBox,
  circleHitsPolyline,
  samplePolyline,
  snapTo45,
} from "../blocks/whiteboard/src/geometry"
import {
  autoLabel,
  encodePoints,
  parsePoints,
} from "../blocks/whiteboard/src/model"
import { validateWhiteboardBindings } from "../blocks/whiteboard/src/schema"

test("point serialization rejects malformed values and rounds coordinates", () => {
  assert.deepEqual(parsePoints('[[1,2],[3,"bad"],[4,5]]'), [
    [1, 2],
    [4, 5],
  ])
  assert.deepEqual(parsePoints("not json"), [])
  assert.equal(
    encodePoints([
      [1.2, 2.8],
      [3.6, 4.4],
    ]),
    "[[1,3],[4,4]]"
  )
})

test("geometry helpers sample, bound, hit-test, and snap strokes", () => {
  const sampled = samplePolyline(
    [
      [0, 0],
      [1, 0],
      [5, 0],
    ],
    2.5
  )

  assert.deepEqual(sampled, [
    [0, 0],
    [5, 0],
  ])
  assert.deepEqual(boundingBox(sampled), {
    x: 0,
    y: 0,
    width: 5,
    height: 0,
  })
  assert.equal(circleHitsPolyline([2, 1], 1, sampled), true)
  const [x, y] = snapTo45(4, 1)
  assert.ok(Math.abs(x - Math.hypot(4, 1)) < 0.0001)
  assert.ok(Math.abs(y) < 0.0001)
  assert.equal(autoLabel("arrow"), "Arrow")
})

test("whiteboard setup reports required fields without mappings", () => {
  assert.deepEqual(
    validateWhiteboardBindings({ title: "title-id", type: undefined }),
    [
      { property: "Type", message: "Map this field to a Select property." },
      { property: "Color", message: "Map this field to a Select property." },
      { property: "X", message: "Map this field to a Number property." },
      { property: "Y", message: "Map this field to a Number property." },
      { property: "Width", message: "Map this field to a Number property." },
      { property: "Height", message: "Map this field to a Number property." },
      {
        property: "Points",
        message: "Map this field to a Rich text property.",
      },
      {
        property: "Stroke width",
        message: "Map this field to a Number property.",
      },
      { property: "Z", message: "Map this field to a Number property." },
    ]
  )
})

test("whiteboard setup accepts all required property bindings", () => {
  assert.deepEqual(
    validateWhiteboardBindings({
      title: "title-id",
      type: "type-id",
      color: "color-id",
      x: "x-id",
      y: "y-id",
      width: "width-id",
      height: "height-id",
      points: "points-id",
      strokeWidth: "stroke-width-id",
      z: "z-id",
    }),
    []
  )
})
