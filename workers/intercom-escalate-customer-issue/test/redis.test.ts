import assert from "node:assert/strict"
import test from "node:test"
import {
  mappingIdentity,
  operationIdentity,
  receiptProofHash,
} from "../src/canonical.js"
import {
  CAS_SCRIPT,
  RedisOperationStore,
  RELEASE_SCRIPT,
  RENEW_SCRIPT,
} from "../src/redis.js"
import { escalateCustomerIssue } from "../src/orchestrator.js"
import type {
  DurableOperation,
  ReceiptProof,
  StoredReceipt,
} from "../src/types.js"
import { inputFor, packet, setup } from "./helpers.js"

function operation(): DurableOperation {
  const value = packet()
  const input = inputFor(value)
  const identity = operationIdentity(input)
  return {
    version: 1,
    operationId: identity.operationId,
    marker: identity.marker,
    propertyKey: identity.propertyKey,
    mappingId: "icm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    mappingGeneration: null,
    policy: {
      jiraProjectKey: "ENG",
      jiraIssueTypeId: "10001",
      intercomTeamId: "team_engineering",
      intercomTagId: "tag_escalated",
    },
    input,
    packet: value,
    createdAt: "2026-07-03T12:00:00.000Z",
    updatedAt: "2026-07-03T12:00:00.000Z",
    sourceGuardFingerprint: null,
    jiraMode: null,
    jiraState: "pending",
    jiraDisposition: "not_sent",
    jiraAttempts: 0,
    jiraIssueId: null,
    jiraIssueKey: null,
    issueCreated: false,
    issueEnriched: false,
    tagState: "pending",
    routeState: "pending",
    noteState: "pending",
    intercomNotePartId: null,
    receiptProofHash: null,
    receiptWritten: false,
    completedAt: null,
  }
}

function receiptProof(): ReceiptProof {
  const value = packet()
  const input = inputFor(value)
  const operationId = operationIdentity(input).operationId
  const receipt: StoredReceipt = {
    version: 1,
    operationId,
    proofHash: "0".repeat(64),
    status: "escalated",
    approvalPageId: input.approvalPageId,
    approvalRevision: input.approvalRevision,
    approvalFingerprint: input.approvalFingerprint,
    mappingId: mappingIdentity("workspace_123", "conversation", "conv_123"),
    mappingGeneration: 1,
    intercomTeamId: "team_engineering",
    intercomTagId: "tag_escalated",
    sourceKind: "conversation",
    sourceId: "conv_123",
    jiraProjectKey: "ENG",
    jiraIssueTypeId: "10001",
    jiraIssueId: "10042",
    jiraIssueKey: "ENG-42",
    jiraUrl: "https://example.atlassian.net/browse/ENG-42",
    issueCreated: true,
    issueEnriched: false,
    tagged: true,
    routed: true,
    internalNotePartId: "part_note",
    customerVisibleReplySent: false,
    completedAt: "2026-07-03T12:00:10.000Z",
  }
  receipt.proofHash = receiptProofHash(receipt)
  return { version: 1, operationId, proofHash: receipt.proofHash, receipt }
}

function redisHarness(): {
  store: RedisOperationStore
  commands: (string | number)[][]
  values: Map<string, string>
} {
  const commands: (string | number)[][] = []
  const values = new Map<string, string>()
  const fetchFn = async (
    _url: string | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const command = JSON.parse(String(init?.body)) as (string | number)[]
    commands.push(command)
    let result: unknown = null
    if (command[0] === "GET") result = values.get(String(command[1])) ?? null
    if (command[0] === "SET") {
      const key = String(command[1])
      const nx = command.includes("NX")
      if (nx && values.has(key)) result = null
      else {
        values.set(key, String(command[2]))
        result = "OK"
      }
    }
    if (command[0] === "EVAL") {
      const script = command[1]
      const key = String(command[3])
      if (script === CAS_SCRIPT) {
        if (values.get(key) === command[4]) {
          values.set(key, String(command[5]))
          result = 1
        } else result = 0
      } else if (script === RENEW_SCRIPT) {
        result = values.get(key) === command[4] ? 1 : 0
      } else if (script === RELEASE_SCRIPT) {
        if (values.get(key) === command[4]) {
          values.delete(key)
          result = 1
        } else result = 0
      }
    }
    return new Response(JSON.stringify({ result }), { status: 200 })
  }
  return {
    store: new RedisOperationStore({
      baseUrl: "https://redis.example.com",
      token: "secret",
      timeoutMs: 1000,
      fetchFn,
    }),
    commands,
    values,
  }
}

test("Redis operation first creation is atomic SET NX with TTL", async () => {
  const { store, commands } = redisHarness()
  const record = operation()
  assert.equal(await store.createOperation(record, 86400), true)
  assert.equal(await store.createOperation(record, 86400), false)
  assert.deepEqual(commands[0].slice(0, 2), [
    "SET",
    `intercom-jira:v1:operation:${record.operationId}`,
  ])
  assert.deepEqual(commands[0].slice(-3), ["NX", "EX", 86400])
})

test("Redis operation updates use exact-value Lua compare-and-set", async () => {
  const { store, commands } = redisHarness()
  const previous = operation()
  await store.createOperation(previous, 86400)
  const next = {
    ...previous,
    updatedAt: "2026-07-03T12:00:01.000Z",
    mappingGeneration: 1,
    jiraMode: "create" as const,
  }
  assert.equal(await store.saveOperation(previous, next, 86400), true)
  assert.equal(
    await store.saveOperation(
      previous,
      { ...next, updatedAt: "2026-07-03T12:00:02.000Z" },
      86400
    ),
    false
  )
  assert.equal(commands[1][1], CAS_SCRIPT)
  assert.equal(
    (await store.getOperation(previous.operationId))?.jiraMode,
    "create"
  )
})

test("strict Redis validator accepts orchestrator terminal, fenced, and rejected records", async () => {
  const terminal = setup()
  await escalateCustomerIssue(terminal.input, terminal.config, terminal.deps)

  const fenced = setup()
  fenced.jira.ambiguousCreate = true
  fenced.jira.mutateOnAmbiguous = false
  await escalateCustomerIssue(fenced.input, fenced.config, fenced.deps)

  const rejected = setup()
  rejected.jira.definiteStatus = 400
  await escalateCustomerIssue(rejected.input, rejected.config, rejected.deps)

  for (const fixture of [terminal, fenced, rejected]) {
    const record = fixture.store.operations.get(
      operationIdentity(fixture.input).operationId
    )
    assert.ok(record)
    const { store } = redisHarness()
    assert.equal(await store.createOperation(record, 86_400), true)
  }
})

test("Redis source mapping is permanent and atomically first-created", async () => {
  const { store, commands, values } = redisHarness()
  const record = operation()
  const mappingId = mappingIdentity("workspace_123", "conversation", "conv_123")
  const mapping = {
    version: 1 as const,
    mappingId,
    workspaceId: "workspace_123",
    sourceKind: "conversation" as const,
    sourceId: "conv_123",
    generation: 1,
    state: "claiming" as const,
    ownerOperationId: record.operationId,
    intendedIssueKey: null,
    jiraIssueId: null,
    jiraIssueKey: null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
  assert.equal(await store.createMapping(mapping), true)
  assert.equal(await store.createMapping(mapping), false)
  const command = commands[0]
  assert.deepEqual(command.slice(-1), ["NX"])
  assert.equal(command.includes("EX"), false)
  values.set(
    `intercom-jira:v1:mapping:${mappingId}`,
    JSON.stringify({ ...mapping, extra: true })
  )
  await assert.rejects(store.getMapping(mappingId), /failed validation/)
  values.set(
    `intercom-jira:v1:mapping:${mappingId}`,
    JSON.stringify({ ...mapping, generation: 0 })
  )
  await assert.rejects(store.getMapping(mappingId), /failed validation/)
})

test("Redis receipt proof is permanent, strict, and atomically first-created", async () => {
  const { store, commands } = redisHarness()
  const proof = receiptProof()
  assert.equal(await store.createReceiptProof(proof), true)
  assert.equal(await store.createReceiptProof(proof), false)
  assert.deepEqual(await store.getReceiptProof(proof.operationId), proof)
  const command = commands[0]
  assert.deepEqual(command.slice(-1), ["NX"])
  assert.equal(command.includes("EX"), false)
})

test("Redis lease renew and release are token-checked Lua operations", async () => {
  const { store, commands } = redisHarness()
  assert.equal(await store.acquireLease("lease", "owner", 120000), true)
  assert.equal(await store.renewLease("lease", "other", 120000), false)
  assert.equal(await store.renewLease("lease", "owner", 120000), true)
  await store.releaseLease("lease", "other")
  assert.equal(await store.acquireLease("lease", "new-owner", 120000), false)
  await store.releaseLease("lease", "owner")
  assert.equal(await store.acquireLease("lease", "new-owner", 120000), true)
  assert.ok(commands.some((command) => command[1] === RENEW_SCRIPT))
  assert.ok(commands.some((command) => command[1] === RELEASE_SCRIPT))
})

test("Redis rejects structurally invalid durable records", async () => {
  const { store, values } = redisHarness()
  const record = operation()
  const key = `intercom-jira:v1:operation:${record.operationId}`
  for (const invalid of [
    { ...record, jiraAttempts: 999 },
    { ...record, marker: "notion-int-000000000000000000000000" },
    { ...record, mappingGeneration: 0 },
    { ...record, extra: true },
    {
      ...record,
      jiraMode: "create",
      jiraState: "complete",
      jiraDisposition: "outcome_unknown",
      jiraIssueId: "10042",
      jiraIssueKey: "ENG-42",
      issueCreated: true,
    },
    { ...record, updatedAt: "2026-07-03T11:59:59.000Z" },
    { ...record, receiptWritten: true },
  ]) {
    values.set(key, JSON.stringify(invalid))
    await assert.rejects(store.getOperation(record.operationId), /validation/)
  }
})

test("Redis rejects receipt proof extras and broken exactly-one result invariant", async () => {
  const { store, values } = redisHarness()
  const proof = receiptProof()
  const key = `intercom-jira:v1:receipt-proof:${proof.operationId}`
  values.set(key, JSON.stringify({ ...proof, extra: true }))
  await assert.rejects(store.getReceiptProof(proof.operationId), /proof/)

  const invalid = structuredClone(proof)
  invalid.receipt.issueEnriched = true
  invalid.receipt.proofHash = receiptProofHash(invalid.receipt)
  invalid.proofHash = invalid.receipt.proofHash
  values.set(key, JSON.stringify(invalid))
  await assert.rejects(store.getReceiptProof(proof.operationId), /proof/)
})
