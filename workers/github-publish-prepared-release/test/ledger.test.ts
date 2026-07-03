import assert from "node:assert/strict"
import test from "node:test"

import {
  RedisOperationLedger,
  RELEASE_SCRIPT,
  RENEW_SCRIPT,
  type LedgerIdentity,
} from "../src/ledger.js"
import { sha256 } from "../src/policy.js"
import type { OperationState } from "../src/types.js"
import { makeReleaseRecord, RELEASE_ID, REPOSITORY_ID } from "./fixtures.js"

function identity(
  operation: string,
  resource = `repository:${REPOSITORY_ID}:release:${RELEASE_ID}`
): LedgerIdentity {
  const digest = sha256(operation)
  return {
    operationId: `ghrel_${digest.slice(0, 24)}`,
    idempotencyKey: `github-release:${digest}`,
    inputFingerprint: digest,
    resourceKey: resource,
  }
}

function state(id: LedgerIdentity): OperationState {
  return {
    version: 1,
    operationId: id.operationId,
    idempotencyKey: id.idempotencyKey,
    inputFingerprint: id.inputFingerprint,
    stage: "claimed",
    release: null,
    receipt: null,
    receiptJson: null,
    updatedAt: "2026-07-03T12:00:00Z",
  }
}

function publishedState(id: LedgerIdentity): OperationState {
  const release = makeReleaseRecord()
  return {
    ...state(id),
    stage: "published",
    release,
    receiptJson: JSON.stringify({
      version: 1,
      operationId: id.operationId,
      idempotencyKey: id.idempotencyKey,
      repository: release.repository,
      repositoryId: release.repositoryId,
      releaseId: release.releaseId,
      releaseUrl: release.url,
      tag: release.tag,
      targetCommit: release.targetCommit,
      nameSha256: release.nameSha256,
      bodySha256: release.bodySha256,
      publishedAt: release.publishedAt,
    }),
  }
}

function completedState(id: LedgerIdentity): OperationState {
  const published = publishedState(id)
  const release = published.release!
  return {
    ...published,
    stage: "completed",
    receipt: {
      ok: true,
      status: "completed",
      operationId: id.operationId,
      idempotencyKey: id.idempotencyKey,
      changed: true,
      replay: false,
      published: true,
      records: [
        {
          system: "github",
          kind: "release",
          id: String(release.releaseId),
          url: release.url,
          action: "published",
        },
        {
          system: "notion",
          kind: "release_packet",
          id: "550e8400e29b41d4a716446655440000",
          url: "https://www.notion.so/550e8400e29b41d4a716446655440000",
          action: "receipt_written",
        },
      ],
      steps: [],
      warnings: [],
      retryable: false,
      resumeToken: null,
      repair: null,
    },
  }
}

function redisFake(options: { throwAfterFirstClaim?: boolean } = {}) {
  const values = new Map<string, string>()
  const commands: string[][] = []
  let threw = false
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const command = JSON.parse(String(init?.body)) as string[]
    commands.push(command)
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer redis-secret"
    )
    const [name, ...args] = command
    let result: unknown
    if (name === "GET") {
      result = values.get(args[0]) ?? null
    } else if (name === "PTTL") {
      result = values.has(args[0]) ? 120_000 : -2
    } else if (name === "SET") {
      const [key, value] = args
      const nx = args.includes("NX")
      if (nx && values.has(key)) result = null
      else {
        values.set(key, value)
        result = "OK"
      }
      if (nx && options.throwAfterFirstClaim && !threw) {
        threw = true
        throw new Error("response lost")
      }
    } else if (name === "EVAL") {
      const [script, _keyCount, key, token] = args
      if (script === RENEW_SCRIPT) {
        result = values.get(key) === token ? 1 : 0
      } else if (script === RELEASE_SCRIPT) {
        if (values.get(key) === token) {
          values.delete(key)
          result = 1
        } else result = 0
      } else throw new Error("unexpected script")
    } else throw new Error(`unexpected command ${name}`)
    return new Response(JSON.stringify({ result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }
  return { fetch, values, commands }
}

function ledger(fetch: typeof globalThis.fetch): RedisOperationLedger {
  return new RedisOperationLedger({
    url: "https://redis.example.test",
    token: "redis-secret",
    requestTimeoutMs: 1_000,
    leaseTtlMs: 120_000,
    fetch,
  })
}

test("distinct approvals contend on one resource lease but keep independent state", async () => {
  const fake = redisFake()
  const store = ledger(fake.fetch)
  const first = identity("approval-a")
  const second = identity("approval-b")

  assert.deepEqual(await store.acquireLease(first, "token-a"), {
    acquired: true,
    retryAfterSeconds: null,
  })
  assert.deepEqual(await store.acquireLease(second, "token-b"), {
    acquired: false,
    retryAfterSeconds: 120,
  })

  await store.putState(first, state(first))
  await store.putState(second, state(second))
  assert.equal((await store.readState(first))?.operationId, first.operationId)
  assert.equal((await store.readState(second))?.operationId, second.operationId)

  const leaseCommands = fake.commands.filter((command) =>
    command.some((part) => part.endsWith(":lease"))
  )
  const leaseKeys = new Set(
    leaseCommands.flatMap((command) =>
      command.filter((part) => part.endsWith(":lease"))
    )
  )
  assert.equal(leaseKeys.size, 1)
})

test("renew and release require the exact lease owner token", async () => {
  const fake = redisFake()
  const store = ledger(fake.fetch)
  const first = identity("one")
  const second = identity("two")
  await store.acquireLease(first, "owner")

  assert.equal(await store.renewLease(second, "intruder"), false)
  await store.releaseLease(second, "intruder")
  assert.equal((await store.acquireLease(second, "next")).acquired, false)

  assert.equal(await store.renewLease(first, "owner"), true)
  await store.releaseLease(first, "owner")
  assert.equal((await store.acquireLease(second, "next")).acquired, true)

  assert.ok(fake.commands.some((command) => command[1] === RENEW_SCRIPT))
  assert.ok(fake.commands.some((command) => command[1] === RELEASE_SCRIPT))
})

test("expired resource lease can be claimed by another approval", async () => {
  const fake = redisFake()
  const store = ledger(fake.fetch)
  const first = identity("first")
  const second = identity("second")
  await store.acquireLease(first, "old-owner")
  for (const key of fake.values.keys()) {
    if (key.endsWith(":lease")) fake.values.delete(key)
  }
  assert.equal((await store.acquireLease(second, "new-owner")).acquired, true)
})

test("ambiguous SET NX response is reconciled by exact token ownership", async () => {
  const fake = redisFake({ throwAfterFirstClaim: true })
  const claim = await ledger(fake.fetch).acquireLease(
    identity("ambiguous"),
    "owner"
  )
  assert.deepEqual(claim, { acquired: true, retryAfterSeconds: null })
  assert.equal(fake.commands[0][0], "SET")
  assert.equal(fake.commands[1][0], "GET")
})

test("rejects corrupt nested release checkpoints before persistence", async () => {
  const fake = redisFake()
  const store = ledger(fake.fetch)
  const id = identity("bad-release")
  const corrupt = publishedState(id)
  corrupt.release = {
    ...corrupt.release!,
    url: "https://attacker.example/release",
  }

  await assert.rejects(store.putState(id, corrupt), /invalid identity or URL/)
  assert.equal(fake.commands.length, 0)
})

test("rejects corrupt canonical receipts loaded from Redis", async () => {
  const fake = redisFake()
  const store = ledger(fake.fetch)
  const id = identity("bad-receipt")
  const corrupt = completedState(id)
  corrupt.receipt = {
    ...corrupt.receipt!,
    records: [
      {
        ...corrupt.receipt!.records[0],
        url: "https://github.com/example/wrong-release",
      },
    ],
  }
  fake.values.set(
    `notion-cookbook:github-release:v1:${id.idempotencyKey}:state`,
    JSON.stringify(corrupt)
  )

  await assert.rejects(
    store.readState(id),
    /canonical receipt has inconsistent semantics/
  )
})

test("rejects unknown durable fields instead of trusting partial shapes", async () => {
  const fake = redisFake()
  const store = ledger(fake.fetch)
  const id = identity("extra-field")
  fake.values.set(
    `notion-cookbook:github-release:v1:${id.idempotencyKey}:state`,
    JSON.stringify({ ...state(id), injected: true })
  )

  await assert.rejects(store.readState(id), /unsupported fields/)
})
