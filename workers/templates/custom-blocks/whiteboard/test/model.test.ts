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
import { validateWhiteboardSchema } from "../blocks/whiteboard/src/schema"
import type { NotionPropertySchema } from "@notionhq/custom-blocks"

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

test("whiteboard schema validation reports wrong types and missing select options", () => {
  const schemas: Record<string, NotionPropertySchema> = {
    title: { name: "Title", type: "title" },
    type: {
      name: "Type",
      type: "select",
      options: [{ id: "sticky", name: "sticky" }],
    },
    color: { name: "Color", type: "rich_text" },
    x: { name: "X", type: "number" },
    y: { name: "Y", type: "number" },
    width: { name: "Width", type: "number" },
    height: { name: "Height", type: "number" },
    points: { name: "Points", type: "rich_text" },
    strokeWidth: { name: "Stroke width", type: "number" },
    z: { name: "Z", type: "number" },
  }

  assert.deepEqual(validateWhiteboardSchema(schemas), [
    {
      property: "Type",
      message: "Add the missing Select options: stroke, line, arrow.",
    },
    {
      property: "Color",
      message: "Map this field to a Select property instead of Rich text.",
    },
  ])
})

test("whiteboard schema validation accepts the required property mapping", () => {
  const option = (name: string) => ({ id: name, name })
  const schemas: Record<string, NotionPropertySchema> = {
    title: { name: "Title", type: "title" },
    type: {
      name: "Type",
      type: "select",
      options: ["sticky", "stroke", "line", "arrow"].map(option),
    },
    color: {
      name: "Color",
      type: "select",
      options: ["yellow", "blue", "pink", "green", "purple", "red", "gray"].map(
        option
      ),
    },
    x: { name: "X", type: "number" },
    y: { name: "Y", type: "number" },
    width: { name: "Width", type: "number" },
    height: { name: "Height", type: "number" },
    points: { name: "Points", type: "rich_text" },
    strokeWidth: { name: "Stroke width", type: "number" },
    z: { name: "Z", type: "number" },
  }

  assert.deepEqual(validateWhiteboardSchema(schemas), [])
})
