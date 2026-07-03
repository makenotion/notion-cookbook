import assert from "node:assert/strict"
import test from "node:test"

import type { RuntimeConfig } from "../src/config.js"
import {
  NotionPacketError,
  NotionPacketStore,
  type NotionClientLike,
} from "../src/notion.js"
import { makeInput, PAGE_ID, REPOSITORY, REPOSITORY_ID } from "./fixtures.js"

const config: RuntimeConfig = {
  allowedRepositories: new Map([[REPOSITORY, REPOSITORY_ID]]),
  redisUrl: "https://redis.example.test",
  redisToken: "secret",
  approvalStatusProperty: "Approval status",
  approvedStatus: "Approved",
  approvalRevisionProperty: "Approval revision",
  approvalFingerprintProperty: "Approval fingerprint",
  receiptProperty: "Release receipt",
  githubRequestTimeoutMs: 8_000,
  notionRequestTimeoutMs: 10_000,
  redisRequestTimeoutMs: 3_000,
  leaseTtlMs: 120_000,
}

function text(content: string) {
  return {
    type: "rich_text",
    rich_text: content
      ? [{ type: "text", plain_text: content, text: { content } }]
      : [],
  }
}

function notionFake(
  options: {
    staleRevision?: boolean
    updateMode?: "ok" | "timeout-after" | "fail" | "hang"
    status?: string
    pageId?: string
    overwriteAfterUpdate?: string
    hangRetrieve?: boolean
  } = {},
  runtimeConfig: RuntimeConfig = config
) {
  const input = makeInput()
  let receipt = ""
  let updates = 0
  let reads = 0
  const page = () => ({
    id: options.pageId ?? PAGE_ID,
    url: `https://www.notion.so/${PAGE_ID.replaceAll("-", "")}`,
    archived: false,
    in_trash: false,
    properties: {
      "Approval status": {
        type: "status",
        status: { name: options.status ?? "Approved" },
      },
      "Approval revision": text(
        options.staleRevision ? "old-approval" : input.approvalRevision
      ),
      "Approval fingerprint": text(input.approvalFingerprint),
      "Release receipt": text(receipt),
    },
  })
  const notion: NotionClientLike = {
    pages: {
      retrieve: async () => {
        reads++
        if (options.hangRetrieve) return await new Promise<never>(() => {})
        return page()
      },
      update: async (args) => {
        updates++
        const property = args.properties["Release receipt"] as {
          rich_text: Array<{ text: { content: string } }>
        }
        if (options.updateMode === "hang") {
          return await new Promise<never>(() => {})
        }
        if (options.updateMode !== "fail")
          receipt = property.rich_text[0].text.content
        if (options.overwriteAfterUpdate !== undefined) {
          receipt = options.overwriteAfterUpdate
        }
        if (
          options.updateMode === "timeout-after" ||
          options.updateMode === "fail"
        ) {
          throw Object.assign(new Error("provider detail SECRET"), {
            status: 503,
          })
        }
        return page()
      },
    },
  }
  return {
    store: new NotionPacketStore(notion, runtimeConfig),
    input,
    updates: () => updates,
    reads: () => reads,
    setReceipt: (value: string) => {
      receipt = value
    },
  }
}

test("verifies explicit status, revision, and canonical fingerprint properties", async () => {
  const fake = notionFake()
  const snapshot = await fake.store.verify(fake.input)
  assert.equal(snapshot.pageId, PAGE_ID.replaceAll("-", ""))

  const stale = notionFake({ staleRevision: true })
  await assert.rejects(
    stale.store.verify(stale.input),
    /approval revision is stale/
  )
})

test("writes the receipt once and makes a matching replay a no-op", async () => {
  const fake = notionFake()
  const receipt = '{"operationId":"ghrel_test"}'
  assert.equal(
    (await fake.store.writeReceipt(fake.input, receipt)).changed,
    true
  )
  assert.equal(
    (await fake.store.writeReceipt(fake.input, receipt)).changed,
    false
  )
  assert.equal(fake.updates(), 1)
  assert.equal(fake.reads(), 3)
})

test("reconciles an ambiguous Notion write by read-back instead of retry", async () => {
  const fake = notionFake({ updateMode: "timeout-after" })
  const result = await fake.store.writeReceipt(
    fake.input,
    '{"releaseId":987654}'
  )
  assert.equal(result.changed, true)
  assert.equal(fake.updates(), 1)
})

test("failed Notion write is redacted and retryable when read-back does not match", async () => {
  const fake = notionFake({ updateMode: "fail" })
  await assert.rejects(
    fake.store.writeReceipt(fake.input, '{"releaseId":987654}'),
    (error: unknown) => {
      assert.ok(error instanceof NotionPacketError)
      assert.equal(error.retryable, true)
      assert.equal(error.message.includes("SECRET"), false)
      return true
    }
  )
  assert.equal(fake.updates(), 1)
})

test("does not overwrite a different existing receipt", async () => {
  const fake = notionFake()
  fake.setReceipt('{"operationId":"someone-else"}')
  await assert.rejects(
    fake.store.writeReceipt(fake.input, '{"operationId":"ours"}'),
    /already contains a different value/
  )
  assert.equal(fake.updates(), 0)
})

test("receipt-only recovery accepts a workflow status transition but keeps immutable bindings", async () => {
  const fake = notionFake({ status: "Published" })
  const result = await fake.store.writeReceipt(
    fake.input,
    '{"releaseId":987654}',
    { requireApproved: false }
  )
  assert.equal(result.changed, true)
  assert.equal(fake.updates(), 1)
})

test("successful update is not claimed when a competing writer wins read-back", async () => {
  const fake = notionFake({ overwriteAfterUpdate: '{"owner":"other"}' })
  await assert.rejects(
    fake.store.writeReceipt(fake.input, '{"owner":"ours"}'),
    /changed before authoritative read-back/
  )
  assert.equal(fake.updates(), 1)
  assert.equal(fake.reads(), 2)
})

test("Notion reads and mutation bodies are covered by fixed retryable timeouts", async () => {
  const fastConfig = { ...config, notionRequestTimeoutMs: 5 }
  const hangingRead = notionFake({ hangRetrieve: true }, fastConfig)
  await assert.rejects(
    hangingRead.store.verify(hangingRead.input),
    (error: unknown) => error instanceof NotionPacketError && error.retryable
  )

  const hangingWrite = notionFake({ updateMode: "hang" }, fastConfig)
  await assert.rejects(
    hangingWrite.store.writeReceipt(hangingWrite.input, '{"releaseId":987654}'),
    (error: unknown) => error instanceof NotionPacketError && error.retryable
  )
  assert.equal(hangingWrite.updates(), 1)
})

test("rejects a Notion response for a different valid page ID", async () => {
  const fake = notionFake({ pageId: "650e8400-e29b-41d4-a716-446655440000" })
  await assert.rejects(
    fake.store.verify(fake.input),
    /different release packet/
  )
})

test("expired Notion authentication returns a typed redacted boundary error", async () => {
  const notion: NotionClientLike = {
    pages: {
      retrieve: async () => {
        throw Object.assign(new Error("secret response"), { status: 401 })
      },
      update: async () => ({}),
    },
  }
  await assert.rejects(
    new NotionPacketStore(notion, config).verify(makeInput()),
    (error: unknown) => {
      assert.ok(error instanceof NotionPacketError)
      assert.equal(error.retryable, false)
      assert.equal(error.message, "Notion approval read failed (HTTP 401)")
      return true
    }
  )
})
