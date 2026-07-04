import assert from "node:assert/strict"
import test from "node:test"

import {
  NotionPlanError,
  NotionPlanStore,
  type NotionClientLike,
} from "../src/notion.js"
import { config, inputFixture, PAGE_ID } from "./fixtures.js"

function textProperty(content: string) {
  return {
    type: "rich_text",
    rich_text: content
      ? [{ type: "text", plain_text: content, text: { content } }]
      : [],
  }
}

function page(
  options: {
    approval?: string
    revision?: string
    planHash?: string
    receipt?: string
    receiptType?: string
  } = {}
) {
  const input = inputFixture()
  return {
    id: PAGE_ID,
    url: `https://www.notion.so/${PAGE_ID}`,
    archived: false,
    in_trash: false,
    properties: {
      "Approval status": {
        type: "status",
        status: { name: options.approval ?? "Approved" },
      },
      "Approval revision": textProperty(
        options.revision ?? input.approvalRevision
      ),
      "Approved plan hash": textProperty(options.planHash ?? input.planHash),
      "Jira publication receipt":
        options.receiptType === "number"
          ? { type: "number", number: 1 }
          : textProperty(options.receipt ?? ""),
    },
  }
}

function clientWithPage(initial = page()) {
  let current = structuredClone(initial)
  const updates: Array<Record<string, unknown>> = []
  const client: NotionClientLike = {
    pages: {
      retrieve: async () => structuredClone(current),
      update: async ({ properties }) => {
        updates.push(properties)
        const receipt = properties[config.receiptProperty] as {
          rich_text: Array<{ text: { content: string } }>
        }
        ;(current.properties as Record<string, unknown>)[
          config.receiptProperty
        ] = textProperty(
          receipt.rich_text.map((item) => item.text.content).join("")
        )
        return structuredClone(current)
      },
    },
  }
  return { client, updates, getPage: () => current }
}

test("verifies exact page identity, approval, revision, hash, and empty receipt", async () => {
  const { client } = clientWithPage()
  const store = new NotionPlanStore(client, config)
  const input = inputFixture()
  const snapshot = await store.verify(input)
  assert.equal(snapshot.pageId, PAGE_ID)
  assert.equal(snapshot.receiptJson, "")
})

test("stale status, revision, hash, and mistyped receipt fail closed", async () => {
  for (const [value, expected] of [
    [page({ approval: "Draft" }), /not currently approved/],
    [page({ revision: "revision-6" }), /revision is stale/],
    [page({ planHash: "f".repeat(64) }), /plan hash is stale/],
    [page({ receiptType: "number" }), /missing a configured typed property/],
  ] as const) {
    const { client } = clientWithPage(value)
    const store = new NotionPlanStore(client, config)
    await assert.rejects(() => store.verify(inputFixture()), expected)
  }
})

test("approval, revision/hash, and receipt properties enforce their exact Notion roles", async () => {
  const cases = [
    ["Approval status", textProperty("Approved")],
    [
      "Approval revision",
      {
        type: "title",
        title: [{ plain_text: inputFixture().approvalRevision }],
      },
    ],
    [
      "Approved plan hash",
      { type: "title", title: [{ plain_text: inputFixture().planHash }] },
    ],
    [
      "Jira publication receipt",
      { type: "title", title: [{ plain_text: "" }] },
    ],
  ] as const
  for (const [name, property] of cases) {
    const mistyped = page()
    ;(mistyped.properties as Record<string, unknown>)[name] = property
    const { client } = clientWithPage(mistyped)
    await assert.rejects(
      () => new NotionPlanStore(client, config).verify(inputFixture()),
      /missing a configured typed property/
    )
  }
})

test("initial claim verification can require an empty receipt", async () => {
  const { client } = clientWithPage(page({ receipt: "already occupied" }))
  await assert.rejects(
    () =>
      new NotionPlanStore(client, config).verify(inputFixture(), {
        requireEmptyReceipt: true,
      }),
    /must be empty before the initial claim/
  )
})

test("writes and exactly reads back a canonical receipt in UTF-8-safe chunks", async () => {
  const { client, updates } = clientWithPage()
  const store = new NotionPlanStore(client, config)
  const receipt = JSON.stringify({ value: "🧭".repeat(1_000) })
  const result = await store.writeReceipt(inputFixture(), receipt)

  assert.equal(result.changed, true)
  const property = updates[0][config.receiptProperty] as {
    rich_text: Array<{ text: { content: string } }>
  }
  assert(property.rich_text.length > 1)
  assert(
    property.rich_text.every(
      (item) => Buffer.byteLength(item.text.content, "utf8") <= 1_800
    )
  )
  assert.equal(
    property.rich_text.map((item) => item.text.content).join(""),
    receipt
  )
})

test("exact completed receipt is an idempotent no-op; a different receipt conflicts", async () => {
  const receipt = JSON.stringify({ operationId: "jplan_test" })
  const same = clientWithPage(page({ receipt }))
  const sameResult = await new NotionPlanStore(
    same.client,
    config
  ).writeReceipt(inputFixture(), receipt)
  assert.equal(sameResult.changed, false)
  assert.equal(same.updates.length, 0)

  const different = clientWithPage(page({ receipt: "other" }))
  await assert.rejects(
    () =>
      new NotionPlanStore(different.client, config).writeReceipt(
        inputFixture(),
        receipt
      ),
    /already contains a different value/
  )
})

test("ambiguous Notion update is reconciled by exact read-back", async () => {
  let current = page()
  let updates = 0
  const client: NotionClientLike = {
    pages: {
      retrieve: async () => structuredClone(current),
      update: async ({ properties }) => {
        updates += 1
        const receipt = properties[config.receiptProperty] as {
          rich_text: Array<{ text: { content: string } }>
        }
        current = page({
          receipt: receipt.rich_text.map((item) => item.text.content).join(""),
        })
        throw new Error("lost response containing a secret")
      },
    },
  }
  const result = await new NotionPlanStore(client, config).writeReceipt(
    inputFixture(),
    "canonical"
  )
  assert.equal(result.changed, true)
  assert.equal(updates, 1)
})

test("failed writeback is redacted and retryability follows status", async () => {
  const client: NotionClientLike = {
    pages: {
      retrieve: async () => page(),
      update: async () => {
        throw { status: 503, body: "secret body" }
      },
    },
  }
  await assert.rejects(
    () =>
      new NotionPlanStore(client, config).writeReceipt(
        inputFixture(),
        "canonical"
      ),
    (error: unknown) => {
      assert(error instanceof NotionPlanError)
      assert.equal(error.retryable, true)
      assert.doesNotMatch(error.message, /secret body/)
      return true
    }
  )
})

test("receipt writeback preserves audit after approval is later revoked", async () => {
  const { client, updates } = clientWithPage(page({ approval: "Revoked" }))
  const store = new NotionPlanStore(client, config)
  await assert.rejects(
    () => store.verify(inputFixture()),
    /not currently approved/
  )
  const result = await store.writeReceipt(inputFixture(), "audit receipt")
  assert.equal(result.changed, true)
  assert.equal(updates.length, 1)
})
