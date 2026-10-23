import assert from "node:assert/strict"
import { test } from "node:test"
import {
  imageUrl,
  MAX_ROWS,
  nextLimit,
  queryOptions,
  stageProperty,
  stagesFor,
  titleProperty,
} from "../blocks/shared/model.ts"
import { performAction } from "../blocks/shared/actions.ts"

test("query sends name and Stage filters to the host before limiting, with supported sorts", () => {
  assert.deepEqual(
    queryOptions(
      {
        search: "  archive ",
        stage: "Done",
        sort: "rating",
        descending: true,
        limit: 1200,
      },
      "select"
    ),
    {
      limit: 999,
      sorts: [{ key: "rating", direction: "descending" }],
      filter: {
        and: [
          { key: "name", title: { contains: "archive" } },
          { key: "stage", select: { equals: "Done" } },
        ],
      },
    }
  )
  assert.deepEqual(
    queryOptions(
      {
        search: "",
        stage: "Review",
        sort: "due",
        descending: false,
        limit: 100,
      },
      "status"
    ).filter,
    { and: [{ key: "stage", status: { equals: "Review" } }] }
  )
})

test("load more stops exactly at the SDK cap", () => {
  let limit = 100
  for (let i = 0; i < 20; i++) limit = nextLimit(limit)
  assert.equal(limit, MAX_ROWS)
  assert.equal(nextLimit(900), 999)
})

test("board uses schema options even for empty columns and preserves a no-stage column", () => {
  assert.deepEqual(
    stagesFor(
      {
        name: "Stage",
        type: "select",
        options: [{ id: "a", name: "Review", color: "purple" }],
      },
      []
    ),
    [
      { name: "Review", color: "purple" },
      { name: "", color: "default" },
    ]
  )
  assert.deepEqual(stageProperty("Review", "status"), {
    stage: { type: "status", status: { name: "Review" } },
  })
  assert.deepEqual(stageProperty("", "select"), {
    stage: { type: "select", select: null },
  })
})

test("plain title writes preserve literal text", () => {
  assert.deepEqual(titleProperty("<script> & notes"), {
    name: {
      type: "title",
      title: [{ type: "text", text: { content: "<script> & notes" } }],
    },
  })
})

test("Files display accepts HTTP(S) only without guessing structured or executable values", () => {
  assert.equal(
    imageUrl("https://example.com/cover.png"),
    "https://example.com/cover.png"
  )
  for (const value of [
    "javascript:alert(1)",
    "data:image/svg+xml,test",
    "file:///etc/passwd",
    "Cover,https://example.com/cover.png",
    true,
    ["https://example.com"],
  ])
    assert.equal(imageUrl(value), undefined)
})

test("write and navigation errors surface both SDK error results and rejected requests", async () => {
  assert.equal(
    await performAction(async () => ({
      status: "error",
      error: { message: "Read only" },
    })),
    "Read only"
  )
  assert.equal(
    await performAction(async () => {
      throw new Error("Offline")
    }),
    "Offline"
  )
  assert.equal(
    await performAction(async () => ({ status: "success" })),
    undefined
  )
})
