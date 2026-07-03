import assert from "node:assert/strict"
import test from "node:test"

import Ajv from "ajv"
import { getSchema } from "@notionhq/workers/schema-builder"

import type { RuntimeConfig } from "../src/config.js"
import {
  GitHubApiError,
  GitHubPreconditionError,
  GitHubPublishedPostconditionError,
  type VerifiedRelease,
} from "../src/github.js"
import {
  LedgerError,
  type LedgerIdentity,
  type LeaseClaim,
  type OperationLedger,
} from "../src/ledger.js"
import { NotionPacketError } from "../src/notion.js"
import {
  type GitHubOperations,
  type NotionPacketOperations,
  PublishPreparedReleaseOrchestrator,
} from "../src/orchestrator.js"
import { buildIdentity } from "../src/policy.js"
import { publishReceiptSchema } from "../src/schemas.js"
import type {
  OperationState,
  PublishPreparedReleaseInput,
  PublishReceipt,
  ReceiptStatus,
} from "../src/types.js"
import {
  makeInput,
  makeReleaseRecord,
  PAGE_ID,
  REPOSITORY,
  REPOSITORY_ID,
} from "./fixtures.js"

const CONFIG: RuntimeConfig = {
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

class FakeLedger implements OperationLedger {
  state: OperationState | null = null
  acquired = true
  retryAfterSeconds: number | null = null
  failRead = false
  failPutAt = 0
  failRenewAt = 0
  putCalls = 0
  renewCalls = 0
  releaseCalls = 0

  constructor(private readonly events?: string[]) {}

  async readState(_identity: LedgerIdentity): Promise<OperationState | null> {
    this.events?.push("ledger.read")
    if (this.failRead)
      throw new LedgerError("Redis operation ledger is unavailable")
    return this.state
  }

  async acquireLease(
    _identity: LedgerIdentity,
    _token: string
  ): Promise<LeaseClaim> {
    this.events?.push("ledger.acquire")
    return {
      acquired: this.acquired,
      retryAfterSeconds: this.retryAfterSeconds,
    }
  }

  async renewLease(
    _identity: LedgerIdentity,
    _token: string
  ): Promise<boolean> {
    this.events?.push("ledger.renew")
    this.renewCalls++
    if (this.renewCalls === this.failRenewAt) return false
    return this.acquired
  }

  async putState(
    _identity: LedgerIdentity,
    state: OperationState
  ): Promise<void> {
    this.events?.push(`ledger.put:${state.stage}`)
    this.putCalls++
    if (this.putCalls === this.failPutAt) {
      throw new LedgerError("Redis operation state write was not confirmed")
    }
    this.state = structuredClone(state)
  }

  async releaseLease(_identity: LedgerIdentity, _token: string): Promise<void> {
    this.events?.push("ledger.release")
    this.releaseCalls++
  }
}

class FakeGitHub implements GitHubOperations {
  published = false
  verifyCalls = 0
  publishCalls = 0
  failVerifyAt = 0
  ambiguousPublish = false
  publishedPostconditionFailure = false
  postPatchPreconditionFailure = false
  verifyOptions: Array<
    | {
        verifyGates: boolean
        verifyLatest?: boolean
        expectedPublishedRecord?: ReturnType<typeof makeReleaseRecord> | null
      }
    | undefined
  > = []

  constructor(private readonly events?: string[]) {}

  async verifyPreparedRelease(
    _input: PublishPreparedReleaseInput,
    expectedRepositoryId: number,
    options?: {
      verifyGates: boolean
      verifyLatest?: boolean
      expectedPublishedRecord?: ReturnType<typeof makeReleaseRecord> | null
    }
  ): Promise<VerifiedRelease> {
    this.verifyCalls++
    this.events?.push(`github.verify:${this.verifyCalls}`)
    this.verifyOptions.push(options)
    assert.equal(expectedRepositoryId, REPOSITORY_ID)
    if (this.verifyCalls === this.failVerifyAt) {
      throw new GitHubPreconditionError("provider precondition changed")
    }
    return {
      state: this.published ? "published" : "draft",
      record: makeReleaseRecord({
        publishedAt: this.published ? "2026-07-03T12:00:00Z" : "",
      }),
    }
  }

  async publishAndReconcile(): Promise<{
    release: VerifiedRelease
    reconciledAfterAmbiguousResponse: boolean
  }> {
    this.publishCalls++
    this.events?.push("github.publish")
    if (this.ambiguousPublish) {
      throw new GitHubApiError("terminal read-back unavailable", {
        retryable: true,
        ambiguousMutation: true,
      })
    }
    if (this.postPatchPreconditionFailure) {
      throw new GitHubPreconditionError(
        "post-PATCH provider checkpoint changed"
      )
    }
    this.published = true
    if (this.publishedPostconditionFailure) {
      throw new GitHubPublishedPostconditionError(
        "Release is published but is not the repository's observable latest release",
        makeReleaseRecord(),
        true
      )
    }
    return {
      release: { state: "published", record: makeReleaseRecord() },
      reconciledAfterAmbiguousResponse: false,
    }
  }
}

class FakeNotion implements NotionPacketOperations {
  verifyCalls = 0
  writeCalls = 0
  receipt = ""
  verifyError: Error | null = null
  writeError: Error | null = null
  writeOptions: Array<{ requireApproved?: boolean } | undefined> = []

  constructor(private readonly events?: string[]) {}

  async verify(): Promise<unknown> {
    this.verifyCalls++
    this.events?.push(`notion.verify:${this.verifyCalls}`)
    if (this.verifyError) throw this.verifyError
    return {}
  }

  async writeReceipt(
    _input: PublishPreparedReleaseInput,
    receiptJson: string,
    options?: { requireApproved?: boolean }
  ): Promise<{ changed: boolean; pageId: string; url: string }> {
    this.writeCalls++
    this.events?.push("notion.write")
    this.writeOptions.push(options)
    if (this.writeError) throw this.writeError
    const changed = this.receipt !== receiptJson
    this.receipt = receiptJson
    return {
      changed,
      pageId: PAGE_ID.replaceAll("-", ""),
      url: `https://www.notion.so/${PAGE_ID.replaceAll("-", "")}`,
    }
  }
}

function setup(
  options: {
    ledger?: FakeLedger
    github?: FakeGitHub
    notion?: FakeNotion
    events?: string[]
  } = {}
) {
  const ledger = options.ledger ?? new FakeLedger(options.events)
  const github = options.github ?? new FakeGitHub(options.events)
  const notion = options.notion ?? new FakeNotion(options.events)
  const orchestrator = new PublishPreparedReleaseOrchestrator({
    config: CONFIG,
    ledger,
    github,
    notion,
    now: () => "2026-07-03T12:00:00Z",
    leaseToken: () => "lease-owner-token",
  })
  return { orchestrator, ledger, github, notion }
}

test("successful execution rechecks approval/provider, publishes once, and records receipt", async () => {
  const input = makeInput()
  const { orchestrator, ledger, github, notion } = setup()
  const result = await orchestrator.execute(input)
  assert.equal(result.status, "completed")
  assert.equal(result.published, true)
  assert.equal(result.changed, true)
  assert.equal(github.verifyCalls, 2)
  assert.equal(github.publishCalls, 1)
  assert.equal(notion.verifyCalls, 2)
  assert.equal(notion.writeCalls, 1)
  assert.equal(ledger.state?.stage, "completed")
  assert.match(notion.receipt, /"releaseId":987654/)
  assert.deepEqual(notion.writeOptions, [{ requireApproved: false }])
})

test("success preserves the cross-system ordering contract", async () => {
  const events: string[] = []
  const { orchestrator } = setup({ events })
  const result = await orchestrator.execute(makeInput())
  assert.equal(result.status, "completed")
  assert.deepEqual(events, [
    "ledger.read",
    "ledger.acquire",
    "ledger.read",
    "ledger.put:claimed",
    "notion.verify:1",
    "github.verify:1",
    "ledger.renew",
    "notion.verify:2",
    "github.verify:2",
    "ledger.renew",
    "github.publish",
    "ledger.put:published",
    "notion.write",
    "ledger.put:completed",
    "ledger.release",
  ])
})

test("completed replay returns canonical no-op without provider or Notion calls", async () => {
  const input = makeInput()
  const dependencies = setup()
  assert.equal(
    (await dependencies.orchestrator.execute(input)).status,
    "completed"
  )
  const verifyCalls = dependencies.github.verifyCalls
  const notionCalls = dependencies.notion.verifyCalls
  const replay = await dependencies.orchestrator.execute(input)
  assert.equal(replay.status, "no_op")
  assert.equal(replay.changed, false)
  assert.equal(replay.replay, true)
  assert.equal(dependencies.github.verifyCalls, verifyCalls)
  assert.equal(dependencies.notion.verifyCalls, notionCalls)
})

test("concurrent invocation returns a retryable conflict before any provider read", async () => {
  const ledger = new FakeLedger()
  ledger.acquired = false
  ledger.retryAfterSeconds = 90
  const { orchestrator, github, notion } = setup({ ledger })
  const result = await orchestrator.execute(makeInput())
  assert.equal(result.status, "conflict")
  assert.equal(result.retryable, true)
  assert.match(result.repair ?? "", /90 seconds/)
  assert.equal(github.verifyCalls, 0)
  assert.equal(notion.verifyCalls, 0)
})

test("stale approval and changed final provider state produce zero publication writes", async () => {
  const staleNotion = new FakeNotion()
  staleNotion.verifyError = new NotionPacketError(
    "Release packet approval revision is stale",
    {
      kind: "conflict",
    }
  )
  const stale = setup({ notion: staleNotion })
  assert.equal(
    (await stale.orchestrator.execute(makeInput())).status,
    "conflict"
  )
  assert.equal(stale.github.publishCalls, 0)

  const changedGitHub = new FakeGitHub()
  changedGitHub.failVerifyAt = 2
  const changed = setup({ github: changedGitHub })
  assert.equal(
    (await changed.orchestrator.execute(makeInput())).status,
    "conflict"
  )
  assert.equal(changedGitHub.publishCalls, 0)
})

test("lost resource lease after final reads prevents publication", async () => {
  const ledger = new FakeLedger()
  ledger.failRenewAt = 2
  const { orchestrator, github } = setup({ ledger })
  const result = await orchestrator.execute(makeInput())
  assert.equal(result.status, "conflict")
  assert.equal(github.verifyCalls, 2)
  assert.equal(github.publishCalls, 0)
  assert.match(result.repair ?? "", /no publication was attempted/)
})

test("published durable state resumes only Notion receipt writeback", async () => {
  const input = makeInput()
  const identity = buildIdentity(input, REPOSITORY_ID)
  const ledger = new FakeLedger()
  ledger.state = {
    version: 1,
    operationId: identity.operationId,
    idempotencyKey: identity.idempotencyKey,
    inputFingerprint: identity.inputFingerprint,
    stage: "published",
    release: makeReleaseRecord(),
    receipt: null,
    receiptJson: '{"durable":true}',
    updatedAt: "2026-07-03T12:00:00Z",
  }
  const github = new FakeGitHub()
  github.published = true
  const notion = new FakeNotion()
  notion.verifyError = new NotionPacketError(
    "Release packet is not currently approved",
    { kind: "conflict" }
  )
  const { orchestrator } = setup({ ledger, github, notion })
  const result = await orchestrator.execute(input)
  assert.ok(result.status === "completed" || result.status === "no_op")
  assert.equal(result.replay, true)
  assert.equal(github.publishCalls, 0)
  assert.equal(notion.writeCalls, 1)
  assert.equal(notion.verifyCalls, 0)
  assert.deepEqual(notion.writeOptions, [{ requireApproved: false }])
  assert.deepEqual(github.verifyOptions, [
    {
      verifyGates: false,
      verifyLatest: false,
      expectedPublishedRecord: makeReleaseRecord(),
    },
  ])
  assert.equal(ledger.state?.stage, "completed")
})

test("Redis outage immediately after publication reports published partial failure accurately", async () => {
  const ledger = new FakeLedger()
  ledger.failPutAt = 2 // claimed succeeds; published checkpoint fails
  const { orchestrator, github, notion } = setup({ ledger })
  const result = await orchestrator.execute(makeInput())
  assert.equal(github.publishCalls, 1)
  assert.equal(result.status, "partial_failure")
  assert.equal(result.published, true)
  assert.equal(result.changed, true)
  assert.equal(result.records[0]?.system, "github")
  assert.equal(result.retryable, true)
  assert.equal(notion.writeCalls, 0)
})

test("final ledger outage preserves both completed external records", async () => {
  const ledger = new FakeLedger()
  ledger.failPutAt = 3 // claimed, published, then completed transition
  const { orchestrator, notion } = setup({ ledger })
  const result = await orchestrator.execute(makeInput())
  assert.equal(result.status, "partial_failure")
  assert.equal(result.published, true)
  assert.equal(result.records.length, 2)
  assert.equal(result.records[0].system, "github")
  assert.equal(result.records[1].system, "notion")
  assert.equal(notion.writeCalls, 1)
  assert.match(result.repair ?? "", /GitHub and Notion are complete/)
})

test("Notion writeback failure returns a safe receipt-only resume", async () => {
  const notion = new FakeNotion()
  notion.writeError = new NotionPacketError(
    "Notion receipt write failed (HTTP 503)",
    {
      kind: "unavailable",
      retryable: true,
    }
  )
  const { orchestrator, ledger, github } = setup({ notion })
  const result = await orchestrator.execute(makeInput())
  assert.equal(result.status, "partial_failure")
  assert.equal(result.published, true)
  assert.equal(result.retryable, true)
  assert.ok(result.resumeToken)
  assert.equal(github.publishCalls, 1)
  assert.equal(ledger.state?.stage, "published")
})

test("ambiguous publication returns exact-release reconciliation repair", async () => {
  const github = new FakeGitHub()
  github.ambiguousPublish = true
  const result = await setup({ github }).orchestrator.execute(makeInput())
  assert.equal(result.status, "ambiguous")
  assert.equal(result.published, false)
  assert.equal(result.retryable, true)
  assert.match(result.repair ?? "", /exact release ID/)
})

test("post-PATCH precondition drift can never be returned as an unpublished conflict", async () => {
  const github = new FakeGitHub()
  github.postPatchPreconditionFailure = true
  const result = await setup({ github }).orchestrator.execute(makeInput())
  assert.equal(github.publishCalls, 1)
  assert.equal(result.status, "ambiguous")
  assert.equal(result.published, false)
  assert.equal(result.retryable, true)
  assert.match(result.repair ?? "", /exact release ID/)
})

test("published release with failed latest policy remains accurately published", async () => {
  const github = new FakeGitHub()
  github.publishedPostconditionFailure = true
  const result = await setup({ github }).orchestrator.execute(makeInput())
  assert.equal(result.status, "partial_failure")
  assert.equal(result.published, true)
  assert.equal(result.changed, true)
  assert.equal(result.records[0]?.action, "published")
  assert.match(result.steps[1]?.detail ?? "", /not.*observable latest release/)
})

test("every terminal result family validates against the strict output schema", async () => {
  const receipts: PublishReceipt[] = []

  const success = setup()
  receipts.push(await success.orchestrator.execute(makeInput()))
  receipts.push(await success.orchestrator.execute(makeInput()))

  const invalid = makeInput()
  invalid.approvalFingerprint = "f".repeat(64)
  receipts.push(await setup().orchestrator.execute(invalid))

  const unavailableLedger = new FakeLedger()
  unavailableLedger.failRead = true
  receipts.push(
    await setup({ ledger: unavailableLedger }).orchestrator.execute(makeInput())
  )

  const partialLedger = new FakeLedger()
  partialLedger.failPutAt = 2
  receipts.push(
    await setup({ ledger: partialLedger }).orchestrator.execute(makeInput())
  )

  const ambiguousGitHub = new FakeGitHub()
  ambiguousGitHub.ambiguousPublish = true
  receipts.push(
    await setup({ github: ambiguousGitHub }).orchestrator.execute(makeInput())
  )

  const statuses = new Set(receipts.map((receipt) => receipt.status))
  for (const expected of [
    "completed",
    "no_op",
    "conflict",
    "blocked",
    "partial_failure",
    "ambiguous",
  ] satisfies ReceiptStatus[]) {
    assert.ok(statuses.has(expected), `missing ${expected}`)
  }

  const validate = new Ajv().compile(getSchema(publishReceiptSchema))
  for (const receipt of receipts) {
    assert.equal(validate(receipt), true, JSON.stringify(validate.errors))
  }
  assert.equal(validate({ ...receipts[0], unexpected: true }), false)
})
