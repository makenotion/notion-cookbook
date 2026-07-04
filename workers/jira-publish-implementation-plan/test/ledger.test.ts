import assert from "node:assert/strict"
import test from "node:test"

import {
  ACQUIRE_SCRIPT,
  CLAIM_SCRIPT,
  LedgerError,
  PUT_STATE_SCRIPT,
  RedisOperationLedger,
  RELEASE_SCRIPT,
  RENEW_SCRIPT,
} from "../src/ledger.js"
import {
  buildIdentity,
  nodeMarker,
  normalizePageId,
  stableNodeOrder,
} from "../src/policy.js"
import type { OperationState } from "../src/types.js"
import { inputFixture, providerPolicyFingerprint } from "./fixtures.js"

function setup() {
  const input = inputFixture()
  const built = buildIdentity(input, providerPolicyFingerprint)
  const identity = {
    operationId: built.operationId,
    idempotencyKey: built.idempotencyKey,
    publicationKey: built.publicationKey,
    providerPolicyFingerprint,
  }
  const state: OperationState = {
    version: 2,
    operationId: identity.operationId,
    idempotencyKey: identity.idempotencyKey,
    planHash: input.planHash,
    sourcePageId: normalizePageId(input.approvalPageId),
    approvalRevision: input.approvalRevision,
    projectKey: input.projectKey,
    providerPolicyFingerprint,
    stage: "claimed",
    nodes: stableNodeOrder(input.nodes).map((node) => ({
      nodeKey: node.nodeKey,
      issueId: null,
      issueKey: null,
      url: null,
      marker: nodeMarker(identity.operationId, node.nodeKey),
      status: "pending",
      attempt: 0,
      requestDisposition: "not_sent",
    })),
    dependencies: input.dependencies.map((dependency) => ({
      ...dependency,
      status: "pending",
      attempt: 0,
      requestDisposition: "not_sent",
    })),
    receipt: null,
    receiptJson: null,
    startedAt: "2026-07-03T12:00:00.000Z",
    updatedAt: "2026-07-03T12:00:00.000Z",
  }
  return { input, identity, state }
}

function receiptStageState(state: OperationState): OperationState {
  const nodes = state.nodes.map((node, index) => ({
    ...node,
    issueId: String(20_001 + index),
    issueKey: `ENG-${index + 1}`,
    url: `https://example.atlassian.net/browse/ENG-${index + 1}`,
    status: "existing" as const,
    requestDisposition: "accepted" as const,
  }))
  const dependencies = state.dependencies.map((dependency) => ({
    ...dependency,
    status: "existing" as const,
    requestDisposition: "accepted" as const,
  }))
  const receipt = {
    ok: true,
    status: "completed" as const,
    operationId: state.operationId,
    idempotencyKey: state.idempotencyKey,
    changed: true,
    replay: false,
    projectKey: state.projectKey,
    planHash: state.planHash,
    approvalPageId: state.sourcePageId,
    approvalRevision: state.approvalRevision,
    providerPolicyFingerprint: state.providerPolicyFingerprint,
    startedAt: state.startedAt,
    completedAt: "2026-07-03T12:01:00.000Z",
    nodes: nodes.map((node) => ({
      nodeKey: node.nodeKey,
      issueId: node.issueId,
      issueKey: node.issueKey,
      url: node.url,
      action: "existing" as const,
    })),
    dependencies: dependencies.map((dependency) => ({
      blockerNodeKey: dependency.blockerNodeKey,
      blockedNodeKey: dependency.blockedNodeKey,
      action: "existing" as const,
    })),
    notionReceiptWritten: true,
    steps: [],
    warnings: [],
    retryable: false,
    retryAfterSeconds: null,
    repair: null,
  }
  return {
    ...state,
    stage: "writing_receipt",
    nodes,
    dependencies,
    receipt,
    receiptJson: JSON.stringify(receipt),
    updatedAt: "2026-07-03T12:01:00.000Z",
  }
}

class RedisHarness {
  values = new Map<string, string>()
  commands: string[][] = []
  ttl = 120_000
  throwAfterClaim = false
  throwAfterPut = false

  fetch = async (
    _url: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const command = JSON.parse(String(init?.body)) as string[]
    this.commands.push(command)
    let result: unknown = null
    if (command[0] === "EVAL" && command[1] === CLAIM_SCRIPT) {
      const claimKey = command[3]
      const stateKey = command[4]
      const owner = this.values.get(claimKey)
      const state = this.values.get(stateKey)
      if (owner && owner !== command[5]) result = "CONFLICT"
      else if (owner && !state) result = "CORRUPT"
      else if (owner) result = "REPLAY"
      else if (state) result = "CORRUPT"
      else {
        this.values.set(claimKey, command[5])
        this.values.set(stateKey, command[6])
        result = "CLAIMED"
      }
      if (this.throwAfterClaim) {
        this.throwAfterClaim = false
        throw new Error("lost HTTP response")
      }
    } else if (command[0] === "EVAL" && command[1] === ACQUIRE_SCRIPT) {
      const leaseKey = command[3]
      const epochKey = command[4]
      if (this.values.has(leaseKey)) result = [0, this.ttl]
      else {
        const epoch = Number(this.values.get(epochKey) ?? "0") + 1
        this.values.set(epochKey, String(epoch))
        this.values.set(leaseKey, `${epoch}:${command[5]}`)
        result = [1, epoch]
      }
    } else if (command[0] === "EVAL" && command[1] === PUT_STATE_SCRIPT) {
      const ownerMatches = this.values.get(command[3]) === command[6]
      const leaseMatches = this.values.get(command[4]) === command[7]
      const stateMatches = this.values.get(command[5]) === command[8]
      if (!ownerMatches) result = "OWNER"
      else if (!leaseMatches) result = "LEASE"
      else if (!stateMatches) result = "STALE"
      else {
        this.values.set(command[5], command[9])
        result = "OK"
      }
      if (this.throwAfterPut) {
        this.throwAfterPut = false
        throw new Error("lost CAS response")
      }
    } else if (command[0] === "GET") {
      result = this.values.get(command[1]) ?? null
    } else if (command[0] === "SET" && command[3] === "NX") {
      if (!this.values.has(command[1])) {
        this.values.set(command[1], command[2])
        result = "OK"
      }
    } else if (command[0] === "SET") {
      this.values.set(command[1], command[2])
      result = "OK"
    } else if (command[0] === "PTTL") {
      result = this.ttl
    } else if (command[0] === "EVAL" && command[1] === RENEW_SCRIPT) {
      result = this.values.get(command[3]) === command[4] ? 1 : 0
    } else if (command[0] === "EVAL" && command[1] === RELEASE_SCRIPT) {
      if (this.values.get(command[3]) === command[4]) {
        this.values.delete(command[3])
        result = 1
      } else result = 0
    } else {
      throw new Error(`unsupported command ${command[0]}`)
    }
    return new Response(JSON.stringify({ result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
}

function ledger(harness: RedisHarness) {
  return new RedisOperationLedger({
    url: "https://example.upstash.io",
    token: "fake-redis-token-for-tests",
    requestTimeoutMs: 50,
    leaseTtlMs: 120_000,
    fetch: harness.fetch,
  })
}

test("one Lua command atomically claims the source publication and initializes state", async () => {
  const harness = new RedisHarness()
  const client = ledger(harness)
  const { identity, state } = setup()

  assert.equal(await client.claimPublication(identity, state), "claimed")
  assert.equal(await client.claimPublication(identity, state), "replay")
  assert.equal(harness.commands[0][0], "EVAL")
  assert.equal(harness.commands[0][1], CLAIM_SCRIPT)
  assert.equal(harness.commands[0][2], "2")
  assert.equal((await client.readState(identity))?.planHash, state.planHash)
})

test("a different idempotency key cannot take the same source publication", async () => {
  const harness = new RedisHarness()
  const client = ledger(harness)
  const { identity, state } = setup()
  await client.claimPublication(identity, state)
  const different = {
    ...identity,
    operationId: "jplan_" + "b".repeat(24),
    idempotencyKey: "jira-plan:" + "b".repeat(64),
  }
  const differentState = {
    ...state,
    operationId: different.operationId,
    idempotencyKey: different.idempotencyKey,
  }
  assert.equal(
    await client.claimPublication(different, differentState),
    "conflict"
  )
})

test("ambiguous atomic claim is reconciled from both owner and state keys", async () => {
  const harness = new RedisHarness()
  harness.throwAfterClaim = true
  const client = ledger(harness)
  const { identity, state } = setup()
  assert.equal(await client.claimPublication(identity, state), "replay")
  assert.equal(
    (await client.readState(identity))?.operationId,
    identity.operationId
  )
})

test("a permanent owner with missing state fails closed instead of reinitializing fences", async () => {
  const harness = new RedisHarness()
  const client = ledger(harness)
  const { identity, state } = setup()
  await client.claimPublication(identity, state)
  const stateKey = [...harness.values.keys()].find((key) =>
    key.endsWith(":state")
  ) as string
  harness.values.delete(stateKey)

  await assert.rejects(
    () => client.claimPublication(identity, state),
    /state was not confirmed/
  )
  assert.equal(harness.values.has(stateKey), false)
})

test("lease operations are token checked and report bounded contention", async () => {
  const harness = new RedisHarness()
  const client = ledger(harness)
  const { identity, state } = setup()
  await client.claimPublication(identity, state)
  assert.deepEqual(await client.acquireLease(identity, "token-one"), {
    acquired: true,
    retryAfterSeconds: null,
    fencingEpoch: 1,
  })
  assert.deepEqual(await client.acquireLease(identity, "token-two"), {
    acquired: false,
    retryAfterSeconds: 120,
    fencingEpoch: null,
  })
  const lease = { token: "token-one", fencingEpoch: 1 }
  assert.equal(
    await client.renewLease(identity, { token: "wrong", fencingEpoch: 1 }),
    false
  )
  assert.equal(await client.renewLease(identity, lease), true)
  await client.releaseLease(identity, { token: "wrong", fencingEpoch: 1 })
  assert.equal(await client.renewLease(identity, lease), true)
  await client.releaseLease(identity, lease)
  assert.equal(await client.renewLease(identity, lease), false)
})

test("state CAS read-backs exact bytes after an ambiguous response", async () => {
  const harness = new RedisHarness()
  harness.throwAfterPut = true
  const client = ledger(harness)
  const { identity, state } = setup()
  await client.claimPublication(identity, state)
  const acquired = await client.acquireLease(identity, "token-one")
  const updated = { ...state, stage: "publishing_nodes" as const }
  await client.putState(identity, state, updated, {
    token: "token-one",
    fencingEpoch: acquired.fencingEpoch as number,
  })
  assert.equal((await client.readState(identity))?.stage, "publishing_nodes")
})

test("an expired lease epoch cannot save after a new owner acquires the lease", async () => {
  const harness = new RedisHarness()
  const client = ledger(harness)
  const { identity, state } = setup()
  await client.claimPublication(identity, state)
  const first = await client.acquireLease(identity, "old-owner")
  const leaseKey = [...harness.values.keys()].find((key) =>
    key.endsWith(":lease")
  ) as string
  harness.values.delete(leaseKey)
  const second = await client.acquireLease(identity, "new-owner")
  assert.equal(first.fencingEpoch, 1)
  assert.equal(second.fencingEpoch, 2)

  const updated = { ...state, stage: "publishing_nodes" as const }
  await assert.rejects(
    () =>
      client.putState(identity, state, updated, {
        token: "old-owner",
        fencingEpoch: 1,
      }),
    /lease is stale/
  )
  assert.equal((await client.readState(identity))?.stage, "claimed")

  await client.putState(identity, state, updated, {
    token: "new-owner",
    fencingEpoch: 2,
  })
  assert.equal((await client.readState(identity))?.stage, "publishing_nodes")
})

test("corrupt, foreign, and impossible durable checkpoints fail closed", async () => {
  const harness = new RedisHarness()
  const client = ledger(harness)
  const { identity, state } = setup()
  await client.claimPublication(identity, state)
  const stateKey = [...harness.values.keys()].find((key) =>
    key.endsWith(":state")
  ) as string

  harness.values.set(
    stateKey,
    JSON.stringify({ ...state, extra: "unsupported" })
  )
  await assert.rejects(() => client.readState(identity), LedgerError)

  const impossible = structuredClone(state)
  impossible.nodes[0].status = "created"
  harness.values.set(stateKey, JSON.stringify(impossible))
  await assert.rejects(
    () => client.readState(identity),
    /inconsistent identity/
  )

  harness.values.set(
    stateKey,
    JSON.stringify({ ...state, idempotencyKey: "jira-plan:" + "f".repeat(64) })
  )
  await assert.rejects(() => client.readState(identity), LedgerError)
})

test("receipt-stage state requires every Jira checkpoint to be accepted", async () => {
  const harness = new RedisHarness()
  const client = ledger(harness)
  const { identity, state } = setup()
  await client.claimPublication(identity, state)
  const stateKey = [...harness.values.keys()].find((key) =>
    key.endsWith(":state")
  ) as string

  const unfinishedDependency = receiptStageState(state)
  unfinishedDependency.dependencies[0] = {
    ...unfinishedDependency.dependencies[0],
    status: "pending",
    requestDisposition: "not_sent",
  }
  harness.values.set(stateKey, JSON.stringify(unfinishedDependency))
  await assert.rejects(
    () => client.readState(identity),
    /contains unfinished Jira work/
  )

  const unfinishedNode = receiptStageState(state)
  unfinishedNode.nodes[0] = {
    ...unfinishedNode.nodes[0],
    issueId: null,
    issueKey: null,
    url: null,
    status: "unknown",
    attempt: 1,
    requestDisposition: "outcome_unknown",
  }
  harness.values.set(stateKey, JSON.stringify(unfinishedNode))
  await assert.rejects(
    () => client.readState(identity),
    /contains unfinished Jira work/
  )
})

test("Redis provider bodies and bearer token are never exposed", async () => {
  const client = new RedisOperationLedger({
    url: "https://example.upstash.io",
    token: "fake-redis-token-for-tests",
    requestTimeoutMs: 50,
    leaseTtlMs: 120_000,
    fetch: async () =>
      new Response('{"error":"fake-redis-token-for-tests internal detail"}', {
        status: 503,
      }),
  })
  const { identity } = setup()
  await assert.rejects(
    () => client.readState(identity),
    (error: unknown) => {
      assert(error instanceof LedgerError)
      assert.doesNotMatch(
        error.message,
        /fake-redis-token-for-tests|internal detail/
      )
      return true
    }
  )
})

test("oversized Redis responses are rejected before parsing", async () => {
  const client = new RedisOperationLedger({
    url: "https://example.upstash.io",
    token: "fake-redis-token-for-tests",
    requestTimeoutMs: 50,
    leaseTtlMs: 120_000,
    fetch: async () =>
      new Response("x", {
        status: 200,
        headers: { "content-length": "256001" },
      }),
  })
  const { identity } = setup()
  await assert.rejects(
    () => client.readState(identity),
    /exceeded the fixed body limit/
  )
})
