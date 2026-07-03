import assert from "node:assert/strict"
import { test } from "node:test"
import { RedisOperationStore } from "../src/redis.js"
import type { OperationRecord } from "../src/types.js"

interface Entry {
  value: string
  expiresAt: number | null
}

function redisHarness() {
  let now = 1_000
  const entries = new Map<string, Entry>()
  const read = (key: string): Entry | null => {
    const entry = entries.get(key)
    if (!entry) return null
    if (entry.expiresAt !== null && entry.expiresAt <= now) {
      entries.delete(key)
      return null
    }
    return entry
  }
  const fetchImpl = (async (
    _url: string | URL | Request,
    init?: RequestInit
  ) => {
    const command = JSON.parse(String(init?.body)) as (string | number)[]
    const name = String(command[0]).toUpperCase()
    let result: unknown
    if (name === "SET") {
      const key = String(command[1])
      const value = String(command[2])
      const nx = command.includes("NX")
      if (nx && read(key)) {
        result = null
      } else {
        const pxIndex = command.indexOf("PX")
        const expiresAt =
          pxIndex >= 0 ? now + Number(command[pxIndex + 1]) : null
        entries.set(key, { value, expiresAt })
        result = "OK"
      }
    } else if (name === "GET") {
      result = read(String(command[1]))?.value ?? null
    } else if (name === "EVAL") {
      const script = String(command[1])
      const key = String(command[3])
      const token = String(command[4])
      const entry = read(key)
      if (!entry || entry.value !== token) {
        result = 0
      } else if (script.includes("pexpire")) {
        entry.expiresAt = now + Number(command[5])
        result = 1
      } else {
        entries.delete(key)
        result = 1
      }
    } else {
      return new Response(JSON.stringify({ error: "unsupported" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response(JSON.stringify({ result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
  const store = new RedisOperationStore({
    baseUrl: "https://redis.example.com",
    token: "redis-secret",
    fetchImpl,
  })
  return {
    store,
    writeRaw: (operationId: string, value: unknown) => {
      entries.set(`vercel-promotion:operation:${operationId}`, {
        value: JSON.stringify(value),
        expiresAt: null,
      })
    },
    advance: (milliseconds: number) => {
      now += milliseconds
    },
  }
}

function operation(operationId: string): OperationRecord {
  return {
    version: 1,
    operationId,
    state: "prepared",
    input: {
      approvalPageId: "123e4567-e89b-42d3-a456-426614174000",
      approvalRevision: "release-42",
      approvalFingerprint: "a".repeat(64),
      teamId: "team_acme",
      projectId: "prj_storefront",
      deploymentId: "dpl_candidate",
      expectedGitSha: "b".repeat(40),
      expectedGitBranch: "main",
      expectedCurrentDeploymentId: "dpl_previous",
    },
    policy: {
      teamId: "team_acme",
      projectId: "prj_storefront",
      productionDomains: ["example.com"],
      deploymentChecks: [{ id: "check_tests", name: "Tests" }],
      healthPaths: ["/healthz"],
    },
    createdAt: "2026-07-03T14:00:00.000Z",
    updatedAt: "2026-07-03T14:00:00.000Z",
    mutationStartedAt: null,
    promotionAcceptedAt: null,
    mutationAttempts: 0,
    lastMutationStatus: null,
    lastIssue: null,
    result: null,
  }
}

test("SET NX PX lease acquisition contends and expires", async () => {
  const { store, advance } = redisHarness()
  assert.equal(await store.acquireLease("lease", "owner-a", 1_000), true)
  assert.equal(await store.acquireLease("lease", "owner-b", 1_000), false)
  advance(1_001)
  assert.equal(await store.acquireLease("lease", "owner-b", 1_000), true)
})

test("lease renew and release are token checked", async () => {
  const { store, advance } = redisHarness()
  await store.acquireLease("lease", "owner-a", 1_000)
  assert.equal(await store.renewLease("lease", "owner-b", 5_000), false)
  assert.equal(await store.releaseLease("lease", "owner-b"), false)
  assert.equal(await store.renewLease("lease", "owner-a", 5_000), true)
  advance(1_500)
  assert.equal(await store.acquireLease("lease", "owner-b", 1_000), false)
  assert.equal(await store.releaseLease("lease", "owner-a"), true)
  assert.equal(await store.acquireLease("lease", "owner-b", 1_000), true)
  assert.equal(await store.releaseLease("lease", "owner-a"), false)
})

test("in-flight records expire but completed records are persistent", async () => {
  const { store, advance } = redisHarness()
  const transient = operation(`vpa_${"1".repeat(32)}`)
  await store.putOperation(transient, 1)
  assert.equal(
    (await store.getOperation(transient.operationId))?.operationId,
    transient.operationId
  )
  advance(1_001)
  assert.equal(await store.getOperation(transient.operationId), null)

  const crossedBoundary = operation(`vpa_${"2".repeat(32)}`)
  crossedBoundary.state = "mutation_unknown"
  crossedBoundary.mutationStartedAt = crossedBoundary.createdAt
  crossedBoundary.mutationAttempts = 1
  await store.putOperation(crossedBoundary, null)
  advance(365 * 24 * 60 * 60 * 1_000)
  assert.equal(
    (await store.getOperation(crossedBoundary.operationId))?.state,
    "mutation_unknown"
  )
})

test("durable records reject unknown and malformed nested state", async () => {
  const { store, writeRaw } = redisHarness()
  const cases: OperationRecord[] = []

  const unknownInput = operation(`vpa_${"3".repeat(32)}`)
  ;(unknownInput.input as unknown as Record<string, unknown>).unexpected = true
  cases.push(unknownInput)

  const malformedPolicy = operation(`vpa_${"4".repeat(32)}`)
  malformedPolicy.policy.productionDomains = ["HTTPS://EXAMPLE.COM"]
  cases.push(malformedPolicy)

  const unknownState = operation(`vpa_${"5".repeat(32)}`)
  unknownState.state = "promoting" as OperationRecord["state"]
  cases.push(unknownState)

  const forgedResult = operation(`vpa_${"6".repeat(32)}`)
  forgedResult.result = {
    operationId: forgedResult.operationId,
  } as OperationRecord["result"]
  cases.push(forgedResult)

  for (const record of cases) {
    writeRaw(record.operationId, record)
    await assert.rejects(
      () => store.getOperation(record.operationId),
      (error: unknown) =>
        error instanceof Error &&
        error.name === "SafetyError" &&
        "code" in error &&
        error.code === "COORDINATION_CORRUPT"
    )
  }
})

test("invalid records fail closed before Redis persistence", async () => {
  const { store } = redisHarness()
  const record = operation(`vpa_${"7".repeat(32)}`)
  record.input.projectId = `${record.input.projectId}${"x".repeat(200)}`
  await assert.rejects(
    () => store.putOperation(record, 60),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "COORDINATION_CORRUPT"
  )
})

test("Redis failures are phase-neutral and never disclose endpoint or token", async () => {
  const cases: Array<{ fetchImpl: typeof fetch; expected: RegExp }> = [
    {
      fetchImpl: (async () => {
        throw new Error("transport secret")
      }) as typeof fetch,
      expected: /service is unavailable/,
    },
    {
      fetchImpl: (async () =>
        new Response("no", { status: 503 })) as typeof fetch,
      expected: /HTTP 503/,
    },
    {
      fetchImpl: (async () =>
        new Response("not-json", { status: 200 })) as typeof fetch,
      expected: /invalid JSON/,
    },
    {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "provider secret" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
      expected: /command failed/,
    },
  ]

  for (const { fetchImpl, expected } of cases) {
    const store = new RedisOperationStore({
      baseUrl: "https://secret-host.example.com",
      token: "super-secret-token",
      fetchImpl,
    })
    await assert.rejects(
      () => store.acquireLease("lease", "owner", 1_000),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.doesNotMatch(
          message,
          /secret-host|super-secret-token|provider secret|transport secret/
        )
        assert.doesNotMatch(message, /promotion was attempted/i)
        assert.match(message, expected)
        return true
      }
    )
  }
})
