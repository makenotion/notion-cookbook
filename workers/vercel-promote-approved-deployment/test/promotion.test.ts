import assert from "node:assert/strict"
import { test } from "node:test"
import { approvalFingerprint, operationIdentity } from "../src/approval.js"
import { parseTargetPolicies } from "../src/config.js"
import {
  assertPromotionResultSemantics,
  promoteApprovedDeployment,
} from "../src/promote.js"
import { validateOperationRecord } from "../src/redis.js"
import type {
  ApprovalPacket,
  NotionClientLike,
  OperationRecord,
  PromoteInput,
  PromotionResult,
  RedisOperationStoreLike,
  RuntimeDependencies,
  TargetPolicy,
  VercelCheckDefinition,
  VercelCheckRun,
  VercelClientLike,
  VercelDeployment,
  VercelProject,
  WorkerConfig,
} from "../src/types.js"
import {
  isDefinitePromotionRejectionStatus,
  SafetyError,
  VercelHttpError,
} from "../src/types.js"
import worker from "../src/index.js"

const PAGE_ID = "11111111-1111-4111-8111-111111111111"
const NOW_MS = Date.parse("2026-07-03T14:00:00.000Z")

const policy: TargetPolicy = {
  teamId: "team_acme",
  projectId: "prj_checkout",
  productionDomains: ["app.example.com", "www.example.com"],
  deploymentChecks: [{ id: "check_integration", name: "Integration tests" }],
  healthPaths: ["/healthz"],
}

const packet: ApprovalPacket = {
  approvalStatus: "Approved",
  approvalRevision: "release-42.7",
  teamId: policy.teamId,
  projectId: policy.projectId,
  deploymentId: "dpl_candidate",
  gitSha: "a".repeat(40),
  gitBranch: "main",
  expectedCurrentDeploymentId: "dpl_previous",
}

const input: PromoteInput = {
  approvalPageId: PAGE_ID,
  approvalRevision: packet.approvalRevision,
  approvalFingerprint: approvalFingerprint(packet),
  teamId: packet.teamId,
  projectId: packet.projectId,
  deploymentId: packet.deploymentId,
  expectedGitSha: packet.gitSha,
  expectedGitBranch: packet.gitBranch,
  expectedCurrentDeploymentId: packet.expectedCurrentDeploymentId,
}

function richText(value: string) {
  return {
    type: "rich_text",
    rich_text: value ? [{ plain_text: value }] : [],
  }
}

class FakeNotion implements NotionClientLike {
  receipt = ""
  revision = packet.approvalRevision
  fingerprint = input.approvalFingerprint
  status = "Approved"
  updateFailures = 0
  dropWrites = false
  updates = 0
  lastEdited = "2026-07-03T13:59:00.000Z"
  afterUpdate: (() => void) | null = null
  retrieves = 0
  receiptOnRetrieve: { call: number; text: string } | null = null

  pages: NotionClientLike["pages"]

  constructor() {
    this.pages = {
      retrieve: async ({ page_id }) => {
        assert.equal(page_id, PAGE_ID)
        this.retrieves++
        if (this.receiptOnRetrieve?.call === this.retrieves) {
          this.receipt = this.receiptOnRetrieve.text
          this.receiptOnRetrieve = null
        }
        return {
          object: "page",
          id: PAGE_ID,
          archived: false,
          in_trash: false,
          last_edited_time: this.lastEdited,
          properties: {
            "Approval status": {
              type: "status",
              status: { name: this.status },
            },
            "Approval revision": richText(this.revision),
            "Vercel team ID": richText(packet.teamId),
            "Vercel project ID": richText(packet.projectId),
            "Vercel deployment ID": richText(packet.deploymentId),
            "Git SHA": richText(packet.gitSha),
            "Git branch": richText(packet.gitBranch),
            "Expected current deployment ID": richText(
              packet.expectedCurrentDeploymentId
            ),
            "Approval fingerprint": richText(this.fingerprint),
            "Promotion receipt": richText(this.receipt),
          },
        }
      },
      update: async ({ page_id, properties }) => {
        assert.equal(page_id, PAGE_ID)
        this.updates++
        if (this.updateFailures-- > 0) throw new Error("mock Notion outage")
        assert.deepEqual(Object.keys(properties), ["Promotion receipt"])
        const property = properties["Promotion receipt"] as {
          rich_text: { text: { content: string } }[]
        }
        if (!this.dropWrites) this.receipt = property.rich_text[0].text.content
        // Real Notion edits last_edited_time; the explicit Approval revision is stable.
        this.lastEdited = "2026-07-03T14:00:05.000Z"
        this.afterUpdate?.()
        return { object: "page", id: PAGE_ID }
      },
    }
  }
}

class MemoryStore implements RedisOperationStoreLike {
  operations = new Map<string, OperationRecord>()
  leaseHeld = false
  leaseToken: string | null = null
  lastTtl: number | null | undefined
  events: string[] = []
  acquireError: Error | null = null
  getError: Error | null = null
  putFailures = new Map<OperationRecord["state"], number>()
  putFailureWhen: ((record: OperationRecord) => boolean) | null = null

  async acquireLease(_key: string, token: string): Promise<boolean> {
    this.events.push("acquire")
    if (this.acquireError) throw this.acquireError
    if (this.leaseHeld) return false
    this.leaseHeld = true
    this.leaseToken = token
    return true
  }

  async renewLease(_key: string, token: string): Promise<boolean> {
    this.events.push("renew")
    return this.leaseHeld && this.leaseToken === token
  }

  async releaseLease(_key: string, token: string): Promise<boolean> {
    this.events.push("release")
    if (!this.leaseHeld || this.leaseToken !== token) return false
    this.leaseHeld = false
    this.leaseToken = null
    return true
  }

  async getOperation(operationId: string): Promise<OperationRecord | null> {
    if (this.getError) throw this.getError
    const value = this.operations.get(operationId)
    return value
      ? structuredClone(validateOperationRecord(value, operationId))
      : null
  }

  async putOperation(
    record: OperationRecord,
    ttlSeconds: number | null
  ): Promise<void> {
    this.events.push(`put:${record.state}`)
    this.lastTtl = ttlSeconds
    const failures = this.putFailures.get(record.state) ?? 0
    if (failures > 0) {
      this.putFailures.set(record.state, failures - 1)
      throw new SafetyError(
        "COORDINATION_UNAVAILABLE",
        "The durable operation record could not be saved."
      )
    }
    if (this.putFailureWhen?.(record)) {
      this.putFailureWhen = null
      throw new SafetyError(
        "COORDINATION_UNAVAILABLE",
        "The durable operation record could not be saved."
      )
    }
    this.operations.set(
      record.operationId,
      structuredClone(validateOperationRecord(record, record.operationId))
    )
  }
}

type MutationMode =
  | "accepted"
  | "lost_success"
  | "409"
  | "400"
  | "401"
  | "403"
  | "429"
  | "500"
  | "200"
  | "302"
  | "408"
  | "404"
  | "conflict"
  | "partial"

class FakeVercel implements VercelClientLike {
  state: "previous" | "target" | "other" | "partial" = "previous"
  mode: MutationMode = "accepted"
  promotionCalls = 0
  projectReads = 0
  healthCalls = 0
  healthFails = false
  healthFailsAfter: number | null = null
  stateAfterHealthCall: { call: number; state: FakeVercel["state"] } | null =
    null
  checkConclusion = "succeeded"
  checkCompletedAt = NOW_MS - 1_000
  deploymentCreatedAt = NOW_MS - 60_000
  deploymentTeamId = policy.teamId
  readFailure: VercelHttpError | null = null
  beforePromotion: (() => Promise<void>) | null = null
  extraProductionDomain: string | null = null
  extraProductionDomainOnPromotion: string | null = null
  missingProductionDomain: string | null = null
  duplicateProductionDomain: string | null = null
  overCapAliasInventory = false
  overCapAliasInventoryOnPromotion = false
  aliasDeploymentId: string | null = null
  aliasDeploymentIdOnPromotion: string | null = null
  deploymentUrl = "checkout-abc.vercel.app"
  deploymentUrlOnPromotion: string | null = null
  deploymentGitSha = input.expectedGitSha
  deploymentGitBranch = input.expectedGitBranch
  checkDefinitionReads = 0
  checkRunReads = 0

  private currentIds(): string[] {
    if (this.state === "target") return [input.deploymentId, input.deploymentId]
    if (this.state === "other") return ["dpl_other", "dpl_other"]
    if (this.state === "partial")
      return [input.deploymentId, input.expectedCurrentDeploymentId]
    return [
      input.expectedCurrentDeploymentId,
      input.expectedCurrentDeploymentId,
    ]
  }

  async getProject(): Promise<VercelProject> {
    this.projectReads++
    if (this.readFailure) throw this.readFailure
    const ids = this.currentIds()
    const aliases = policy.productionDomains
      .map((domain, index) => ({
        domain,
        target: "PRODUCTION",
        deployment: { id: ids[index] },
      }))
      .filter((alias) => alias.domain !== this.missingProductionDomain)
    if (this.duplicateProductionDomain) {
      const duplicate = aliases.find(
        (alias) => alias.domain === this.duplicateProductionDomain
      )
      if (duplicate) aliases.push(structuredClone(duplicate))
    }
    if (this.extraProductionDomain) {
      aliases.push({
        domain: this.extraProductionDomain,
        target: "PRODUCTION",
        deployment: { id: ids[0] },
      })
    }
    if (this.overCapAliasInventory) {
      while (aliases.length <= 100) {
        aliases.push({
          domain: `overflow-${aliases.length}.example.com`,
          target: "PRODUCTION",
          deployment: { id: ids[0] },
        })
      }
    }
    if (this.aliasDeploymentId && aliases[0]) {
      aliases[0].deployment = { id: this.aliasDeploymentId }
    }
    return {
      id: policy.projectId,
      accountId: policy.teamId,
      autoAssignCustomDomains: true,
      alias: aliases,
    }
  }

  async getDeployment(): Promise<VercelDeployment> {
    return {
      id: input.deploymentId,
      projectId: input.projectId,
      teamId: this.deploymentTeamId,
      target: "production",
      readyState: "READY",
      readySubstate: this.state === "target" ? "PROMOTED" : "STAGED",
      url: this.deploymentUrl,
      checksState: "completed",
      checksConclusion: "succeeded",
      createdAt: this.deploymentCreatedAt,
      readyAt: this.deploymentCreatedAt + 1_000,
      gitSource: { sha: this.deploymentGitSha, ref: this.deploymentGitBranch },
    }
  }

  async getCheckDefinitions(): Promise<VercelCheckDefinition[]> {
    this.checkDefinitionReads++
    return [
      {
        id: policy.deploymentChecks[0].id,
        name: policy.deploymentChecks[0].name!,
        projectId: input.projectId,
        targets: ["production"],
      },
    ]
  }

  async getCheckRuns(): Promise<VercelCheckRun[]> {
    this.checkRunReads++
    return [
      {
        id: "run_1",
        checkId: policy.deploymentChecks[0].id,
        name: policy.deploymentChecks[0].name!,
        deploymentId: input.deploymentId,
        projectId: input.projectId,
        status: "completed",
        conclusion: this.checkConclusion,
        completedAt: this.checkCompletedAt,
      },
    ]
  }

  async requestPromotion(): Promise<{ status: number }> {
    this.promotionCalls++
    await this.beforePromotion?.()
    if (this.mode === "accepted") {
      this.state = "target"
      this.extraProductionDomain = this.extraProductionDomainOnPromotion
      this.overCapAliasInventory = this.overCapAliasInventoryOnPromotion
      this.aliasDeploymentId = this.aliasDeploymentIdOnPromotion
      this.deploymentUrl = this.deploymentUrlOnPromotion ?? this.deploymentUrl
      return { status: 202 }
    }
    if (this.mode === "lost_success") {
      this.state = "target"
      throw new VercelHttpError("lost response", { ambiguous: true })
    }
    if (this.mode === "conflict") {
      this.state = "other"
      throw new VercelHttpError("reset", { ambiguous: true })
    }
    if (this.mode === "partial") {
      this.state = "partial"
      throw new VercelHttpError("reset", { ambiguous: true })
    }
    const status = Number(this.mode)
    throw new VercelHttpError(`HTTP ${status}`, {
      status,
      ambiguous: !isDefinitePromotionRejectionStatus(status),
      retryAfterMs: status === 429 ? 12_000 : null,
    })
  }

  async checkHealth(): Promise<void> {
    this.healthCalls++
    if (
      this.stateAfterHealthCall &&
      this.healthCalls === this.stateAfterHealthCall.call
    ) {
      this.state = this.stateAfterHealthCall.state
    }
    if (
      this.healthFails ||
      (this.healthFailsAfter !== null &&
        this.healthCalls > this.healthFailsAfter)
    )
      throw new Error("health failed")
  }
}

interface Fixture {
  config: WorkerConfig
  notion: FakeNotion
  store: MemoryStore
  vercel: FakeVercel
  dependencies: RuntimeDependencies
  invoke: () => Promise<PromotionResult>
}

function fixture(): Fixture {
  let clock = NOW_MS
  const notion = new FakeNotion()
  const store = new MemoryStore()
  const vercel = new FakeVercel()
  const config: WorkerConfig = {
    vercelToken: "not-used-by-mock",
    redisUrl: "https://redis.example.com",
    redisToken: "not-used-by-mock",
    protectionBypassSecret: null,
    receiptProperty: "Promotion receipt",
    pollTimeoutMs: 2,
    pollIntervalMs: 1,
    pollMaxAttempts: 30,
    leaseTtlMs: 120_000,
    operationTtlSeconds: 604_800,
    requestTimeoutMs: 10_000,
    healthTimeoutMs: 5_000,
    checkMaxAgeMs: 3_600_000,
    targets: [policy],
  }
  const dependencies: RuntimeDependencies = {
    notion,
    store,
    vercel,
    now: () => new Date(clock),
    sleep: async (milliseconds) => {
      clock += milliseconds
    },
    randomToken: () => `lease-${clock}`,
  }
  return {
    config,
    notion,
    store,
    vercel,
    dependencies,
    invoke: () => promoteApprovedDeployment(input, config, dependencies),
  }
}

test("policy parser requires stable check descriptors and bounded fixed paths", () => {
  const parsed = parseTargetPolicies(JSON.stringify([policy]))
  assert.deepEqual(parsed, [policy])
  assert.throws(
    () =>
      parseTargetPolicies(
        JSON.stringify([{ ...policy, deploymentChecks: ["Integration tests"] }])
      ),
    /object with id/
  )
  assert.throws(
    () =>
      parseTargetPolicies(
        JSON.stringify([{ ...policy, healthPaths: ["https://evil.example/"] }])
      ),
    /path-only/
  )
  assert.throws(
    () =>
      parseTargetPolicies(
        JSON.stringify([
          {
            ...policy,
            productionDomains: Array.from(
              { length: 21 },
              (_, index) => `d${index}.example.com`
            ),
          },
        ])
      ),
    /1–20/
  )
  assert.throws(
    () =>
      parseTargetPolicies(
        JSON.stringify([
          {
            ...policy,
            deploymentChecks: Array.from({ length: 21 }, (_, index) => ({
              id: `check_${index}`,
              name: `Check ${index}`,
            })),
          },
        ])
      ),
    /1–20/
  )
  assert.throws(
    () =>
      parseTargetPolicies(
        JSON.stringify([{ ...policy, healthPaths: ["/%2e%2e/admin"] }])
      ),
    /path-only/
  )
})

test("happy path verifies twice, issues one POST, persists a permanent receipt", async () => {
  const f = fixture()
  const result = await f.invoke()
  assert.equal(result.status, "completed")
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.equal(result.receiptWritten, true)
  assert.equal(f.vercel.promotionCalls, 1)
  assert.equal(f.notion.updates, 1)
  assert.equal(f.vercel.projectReads, 6)
  assert.equal(f.store.lastTtl, null)
  assert.equal(JSON.parse(f.notion.receipt).operationId, result.operationId)
  const deploymentRecord = result.records.find(
    (record) => record.kind === "deployment"
  )
  assert.deepEqual(deploymentRecord, {
    kind: "deployment",
    system: "vercel",
    id: input.deploymentId,
    url: "https://checkout-abc.vercel.app",
    action: "promoted",
    state: "completed",
  })
  assert.ok(
    result.records.every(
      (record) =>
        record.system &&
        record.action &&
        (record.url !== null || record.kind === "deployment")
    )
  )
  assertPromotionResultSemantics(result)
  validateOperationRecord([...f.store.operations.values()][0])
})

test("explicit approval revision survives receipt changing last_edited_time", async () => {
  const f = fixture()
  const first = await f.invoke()
  assert.equal(first.status, "completed")
  const second = await f.invoke()
  assert.equal(second.status, "no_op")
  assert.equal(second.replay, true)
  assert.equal(f.vercel.promotionCalls, 1)
})

test("approval revision or fingerprint mismatch blocks before Vercel POST", async () => {
  for (const mutate of [
    (f: Fixture) => (f.notion.revision = "release-42.8"),
    (f: Fixture) => (f.notion.fingerprint = "b".repeat(64)),
  ]) {
    const f = fixture()
    mutate(f)
    const result = await f.invoke()
    assert.equal(result.status, "blocked")
    assert.equal(result.preconditionsVerified, false)
    assert.equal(result.changed, false)
    assert.equal(f.vercel.promotionCalls, 0)
  }
})

test("fresh promotion requires an empty receipt on both preflight reads", async () => {
  const initiallyOccupied = fixture()
  initiallyOccupied.notion.receipt = "operator-owned content"
  const initial = await initiallyOccupied.invoke()
  assert.equal(initial.status, "blocked")
  assert.match(initial.message, /RECEIPT_OCCUPIED/)
  assert.equal(initiallyOccupied.vercel.promotionCalls, 0)

  const changedBetweenReads = fixture()
  // Reconstruction reads once, the first mutation preflight reads second,
  // and the immediately-before-POST preflight reads third.
  changedBetweenReads.notion.receiptOnRetrieve = {
    call: 3,
    text: "appeared-between-preflights",
  }
  const changed = await changedBetweenReads.invoke()
  assert.equal(changed.status, "blocked")
  assert.match(changed.message, /APPROVAL_RECEIPT_NOT_EMPTY/)
  assert.equal(changedBetweenReads.vercel.promotionCalls, 0)
})

test("malicious or oversized Notion approval text is bounded and never echoed", async () => {
  const sentinel = "INJECT_DO_NOT_ECHO"
  for (const mutate of [
    (f: Fixture) => (f.notion.status = sentinel.repeat(100)),
    (f: Fixture) => (f.notion.revision = sentinel.repeat(100)),
  ]) {
    const f = fixture()
    mutate(f)
    const result = await f.invoke()
    assert.equal(result.status, "blocked")
    assert.equal(result.preconditionsVerified, false)
    assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel))
    assert.equal(f.vercel.promotionCalls, 0)
  }
})

test("allowlist, exact deployment ownership, current identity, health, and checks fail closed", async () => {
  const unlisted = fixture()
  unlisted.config.targets = []
  const unlistedResult = await unlisted.invoke()
  assert.equal(unlistedResult.status, "blocked")
  assert.match(unlistedResult.message, /TARGET_NOT_ALLOWLISTED/)
  assert.equal(unlistedResult.preconditionsVerified, false)
  assert.equal(unlisted.vercel.promotionCalls, 0)

  const cases: ((f: Fixture) => void)[] = [
    (f) => (f.vercel.deploymentTeamId = "team_other"),
    (f) => (f.vercel.state = "other"),
    (f) => (f.vercel.healthFails = true),
    (f) => (f.vercel.checkConclusion = "failed"),
  ]
  for (const mutate of cases) {
    const f = fixture()
    mutate(f)
    const result = await f.invoke()
    assert.equal(result.status, "blocked")
    assert.equal(f.vercel.promotionCalls, 0)
  }
})

test("extra, missing, or duplicate production aliases block with zero POSTs", async () => {
  const cases: { mutate: (f: Fixture) => void; domains: string[] }[] = [
    {
      mutate: (f) => (f.vercel.extraProductionDomain = "admin.example.com"),
      domains: ["admin.example.com", "app.example.com", "www.example.com"],
    },
    {
      mutate: (f) => (f.vercel.missingProductionDomain = "www.example.com"),
      domains: ["app.example.com", "www.example.com"],
    },
    {
      mutate: (f) => (f.vercel.duplicateProductionDomain = "app.example.com"),
      domains: ["app.example.com", "www.example.com"],
    },
  ]
  for (const { mutate, domains } of cases) {
    const f = fixture()
    mutate(f)
    const result = await f.invoke()
    assert.equal(result.status, "blocked")
    assert.match(result.message, /PROJECT_ALIAS_SET_MISMATCH/)
    assert.equal(f.vercel.promotionCalls, 0)
    assert.equal(f.notion.updates, 0)
    assert.deepEqual(result.productionDomains, domains)
    assert.deepEqual(
      result.records
        .filter((record) => record.kind === "production_domain")
        .map((record) => record.id),
      result.productionDomains
    )
  }
})

test("production alias-set drift after POST is partial and receipts every domain", async () => {
  const f = fixture()
  f.vercel.extraProductionDomainOnPromotion = "admin.example.com"
  const result = await f.invoke()
  assert.equal(result.status, "partial_failure")
  assert.equal(result.changed, true)
  assert.equal(f.vercel.promotionCalls, 1)
  assert.deepEqual(result.productionDomains, [
    "admin.example.com",
    "app.example.com",
    "www.example.com",
  ])
  assert.deepEqual(
    result.records
      .filter((record) => record.kind === "production_domain")
      .map((record) => record.id),
    result.productionDomains
  )
  assert.equal(
    result.records.find((record) => record.id === "admin.example.com")?.state,
    "target"
  )
  validateOperationRecord([...f.store.operations.values()][0])
})

test("over-cap alias inventory blocks preflight without retaining provider aliases", async () => {
  const f = fixture()
  f.vercel.overCapAliasInventory = true
  const result = await f.invoke()
  assert.equal(result.status, "blocked")
  assert.match(result.message, /PROJECT_ALIAS_INVENTORY_TOO_LARGE/)
  assert.deepEqual(result.productionDomains, policy.productionDomains)
  assert.doesNotMatch(JSON.stringify(result), /overflow-/)
  assert.equal(f.vercel.promotionCalls, 0)
  assert.equal(f.notion.updates, 0)
})

test("over-cap alias inventory after POST stays bounded and ambiguous", async () => {
  const f = fixture()
  f.vercel.overCapAliasInventoryOnPromotion = true
  const result = await f.invoke()
  assert.equal(result.status, "ambiguous")
  assert.match(result.message, /supported 100 project aliases/)
  assert.deepEqual(result.productionDomains, policy.productionDomains)
  assert.doesNotMatch(JSON.stringify(result), /overflow-/)
  assert.equal(f.vercel.promotionCalls, 1)
  validateOperationRecord([...f.store.operations.values()][0])
})

test("a stale successful check run blocks with zero writes", async () => {
  const f = fixture()
  f.vercel.deploymentCreatedAt = NOW_MS - 3 * 3_600_000
  f.vercel.checkCompletedAt = NOW_MS - 90 * 60_000
  const result = await f.invoke()
  assert.equal(result.status, "blocked")
  assert.match(result.message, /DEPLOYMENT_CHECK_FAILED/)
  assert.equal(f.vercel.promotionCalls, 0)
  assert.equal(f.notion.updates, 0)
})

test("provider 404 and pre-mutation timeout block with zero POSTs", async () => {
  for (const failure of [
    new VercelHttpError("not found", { status: 404 }),
    new VercelHttpError("read timed out"),
  ]) {
    const f = fixture()
    f.vercel.readFailure = failure
    const result = await f.invoke()
    assert.equal(result.status, "blocked")
    assert.equal(result.promotionRequested, false)
    assert.equal(f.vercel.promotionCalls, 0)
    assert.equal(f.notion.updates, 0)
  }
})

test("malformed provider deployment IDs and hostnames are bounded before receipts", async () => {
  const sentinel = "provider-value-must-not-echo"
  const cases: ((f: Fixture) => void)[] = [
    (f) => (f.vercel.aliasDeploymentId = `dpl_${sentinel.repeat(20)}`),
    (f) => (f.vercel.deploymentUrl = `${sentinel}..vercel.app`),
  ]
  for (const mutate of cases) {
    const f = fixture()
    mutate(f)
    const result = await f.invoke()
    assert.equal(result.status, "blocked")
    assert.equal(result.promotionRequested, false)
    assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel))
    assert.equal(f.vercel.promotionCalls, 0)
  }
})

test("malformed provider IDs and hostnames after POST stay bounded and never retry", async () => {
  const sentinel = "post-mutation-provider-value-must-not-echo"
  const cases: ((f: Fixture) => void)[] = [
    (f) =>
      (f.vercel.aliasDeploymentIdOnPromotion = `dpl_${sentinel.repeat(20)}`),
    (f) => (f.vercel.deploymentUrlOnPromotion = `${sentinel}..vercel.app`),
  ]
  for (const mutate of cases) {
    const f = fixture()
    mutate(f)
    const result = await f.invoke()
    assert.equal(result.status, "ambiguous")
    assert.equal(result.promotionRequested, true)
    assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel))
    assert.equal(f.vercel.promotionCalls, 1)
    const replay = await f.invoke()
    assert.equal(replay.status, "ambiguous")
    assert.equal(f.vercel.promotionCalls, 1)
  }
})

test("malformed, oversized, and malicious inputs return typed blocked receipts before coordination", async () => {
  const f = fixture()
  const oversizedIdSentinel = "OVERSIZED_PROVIDER_ID_DO_NOT_ECHO"
  for (const invalid of [
    { ...input, approvalPageId: "https://www.notion.so/page" },
    { ...input, projectId: "../prj_checkout" },
    { ...input, expectedGitBranch: "x".repeat(257) },
    { ...input, approvalFingerprint: "ABC" },
    {
      ...input,
      teamId: `team_${oversizedIdSentinel.repeat(10)}`,
      projectId: `prj_${oversizedIdSentinel.repeat(10)}`,
      deploymentId: `dpl_${oversizedIdSentinel.repeat(10)}`,
      expectedCurrentDeploymentId: `dpl_${oversizedIdSentinel.repeat(10)}`,
    },
  ] as PromoteInput[]) {
    const result = await promoteApprovedDeployment(
      invalid,
      f.config,
      f.dependencies
    )
    assert.equal(result.status, "blocked")
    assert.equal(result.ok, false)
    assert.equal(result.preconditionsVerified, false)
    assert.equal(result.promotionRequested, false)
    assert.match(result.message, /INVALID_INPUT/)
    assert.doesNotMatch(JSON.stringify(result), /\.\.\/|x{257}|ABC/)
    assert.doesNotMatch(
      JSON.stringify(result),
      /OVERSIZED_PROVIDER_ID_DO_NOT_ECHO/
    )
  }
  assert.equal(f.vercel.projectReads, 0)
  assert.equal(f.vercel.promotionCalls, 0)
})

test("lost success reconciles to completed without a second POST", async () => {
  const f = fixture()
  f.vercel.mode = "lost_success"
  const result = await f.invoke()
  assert.equal(result.status, "completed")
  assert.equal(f.vercel.promotionCalls, 1)
  const stored = [...f.store.operations.values()][0]
  assert.equal(stored.promotionAcceptedAt, null)
  validateOperationRecord(stored)
})

test("converged 409 and 5xx complete through strict durable validation", async () => {
  for (const mode of ["409", "500"] as const) {
    const f = fixture()
    f.vercel.mode = mode
    f.vercel.beforePromotion = async () => {
      f.vercel.state = "target"
    }
    const result = await f.invoke()
    assert.equal(result.status, "completed")
    assert.equal(f.vercel.promotionCalls, 1)
    const stored = [...f.store.operations.values()][0]
    assert.equal(stored.lastMutationStatus, Number(mode))
    assert.equal(stored.promotionAcceptedAt, null)
    validateOperationRecord(stored)
  }
})

test("unexpected mutation statuses reconcile and can never re-arm POST", async () => {
  for (const mode of ["200", "302", "404", "408"] as const) {
    const f = fixture()
    f.vercel.mode = mode
    const result = await f.invoke()
    assert.equal(result.status, "ambiguous")
    assert.equal(f.vercel.promotionCalls, 1)
    const stored = [...f.store.operations.values()][0]
    assert.equal(stored.state, "mutation_unknown")
    assert.equal(stored.lastMutationStatus, Number(mode))

    const replay = await f.invoke()
    assert.equal(replay.status, "ambiguous")
    assert.equal(f.vercel.promotionCalls, 1)
  }
})

test("target-current plus final health failure is a changed partial incident and never re-promotes", async () => {
  const f = fixture()
  // The two pre-mutation health passes succeed. Every post-promotion health
  // pass fails while production remains routed to the approved deployment.
  f.vercel.healthFailsAfter = 2
  const partial = await f.invoke()
  assert.equal(partial.status, "partial_failure")
  assert.equal(partial.changed, true)
  assert.equal(partial.currentDeploymentId, input.deploymentId)
  assert.equal(partial.receiptWritten, false)
  assert.match(partial.repairInstruction!, /Do not promote again/)
  assert.equal(f.vercel.promotionCalls, 1)

  f.vercel.healthFailsAfter = null
  const repaired = await f.invoke()
  assert.equal(repaired.status, "completed")
  assert.equal(repaired.receiptWritten, true)
  assert.equal(f.vercel.promotionCalls, 1)
})

test("a final provider re-observation catches drift after health without a second POST", async () => {
  const f = fixture()
  f.vercel.stateAfterHealthCall = { call: 3, state: "other" }
  const result = await f.invoke()
  assert.equal(result.status, "partial_failure")
  assert.equal(result.changed, true)
  assert.equal(result.currentDeploymentId, "dpl_other")
  assert.match(result.message, /final provider observation changed/)
  assert.equal(f.vercel.promotionCalls, 1)
  assert.equal(f.notion.updates, 0)
})

test("provider drift after receipt readback remains a changed partial incident", async () => {
  const f = fixture()
  f.notion.afterUpdate = () => {
    f.vercel.state = "other"
  }
  const partial = await f.invoke()
  assert.equal(partial.status, "partial_failure")
  assert.equal(partial.changed, true)
  assert.equal(partial.receiptWritten, true)
  assert.equal(partial.currentDeploymentId, "dpl_other")
  assert.match(partial.message, /receipt is recorded, but production changed/)
  assert.equal(f.vercel.promotionCalls, 1)

  const stillDrifted = await f.invoke()
  assert.equal(stillDrifted.status, "conflict")
  assert.equal(stillDrifted.receiptWritten, true)
  assert.equal(stillDrifted.currentDeploymentId, "dpl_other")
  assert.equal(f.vercel.promotionCalls, 1)

  f.vercel.state = "target"
  const repaired = await f.invoke()
  assert.equal(repaired.status, "completed")
  assert.equal(repaired.receiptWritten, true)
  assert.equal(f.vercel.promotionCalls, 1)
})

test("receipt proof survives provider drift plus Redis persistence failure", async () => {
  const f = fixture()
  f.notion.afterUpdate = () => {
    f.vercel.state = "other"
  }
  f.store.putFailureWhen = (record) =>
    record.state === "mutation_unknown" &&
    record.result?.receiptWritten === true

  const partial = await f.invoke()
  assert.equal(partial.status, "partial_failure")
  assert.equal(partial.receiptWritten, true)
  assert.equal(partial.currentDeploymentId, "dpl_other")
  assert.match(partial.message, /durable drift state could not be saved/)
  assert.equal(f.vercel.promotionCalls, 1)
  assert.equal([...f.store.operations.values()][0].state, "receipt_pending")

  const replay = await f.invoke()
  assert.equal(replay.status, "conflict")
  assert.equal(replay.receiptWritten, true)
  assert.equal(replay.currentDeploymentId, "dpl_other")
  assert.equal(f.vercel.promotionCalls, 1)
})

test("receipt-pending resume preserves canonical receipt through provider read failure", async () => {
  const f = fixture()
  f.notion.afterUpdate = () => {
    f.vercel.state = "other"
  }
  f.store.putFailureWhen = (record) =>
    record.state === "mutation_unknown" &&
    record.result?.receiptWritten === true
  const first = await f.invoke()
  assert.equal(first.receiptWritten, true)
  assert.equal([...f.store.operations.values()][0].state, "receipt_pending")

  f.vercel.readFailure = new VercelHttpError("provider unavailable")
  const replay = await f.invoke()
  assert.equal(replay.status, "ambiguous")
  assert.equal(replay.receiptWritten, true)
  assert.equal(replay.retryable, true)
  assert.equal(replay.resumeToken, replay.operationId)
  assert.match(replay.repairInstruction!, /reconcile before any mutation/)
  assert.equal(f.vercel.promotionCalls, 1)
})

test("receipt-pending resume preserves canonical receipt through post-read lease loss", async () => {
  const f = fixture()
  f.notion.afterUpdate = () => {
    f.vercel.state = "other"
  }
  f.store.putFailureWhen = (record) =>
    record.state === "mutation_unknown" &&
    record.result?.receiptWritten === true
  const first = await f.invoke()
  assert.equal(first.receiptWritten, true)
  assert.equal([...f.store.operations.values()][0].state, "receipt_pending")

  const originalRenew = f.store.renewLease.bind(f.store)
  let renewCalls = 0
  f.store.renewLease = async (key, token) => {
    renewCalls++
    if (renewCalls >= 2) return false
    return originalRenew(key, token)
  }
  const projectReadsBeforeReplay = f.vercel.projectReads
  const replay = await f.invoke()
  assert.equal(replay.status, "ambiguous")
  assert.equal(replay.receiptWritten, true)
  assert.equal(replay.retryable, true)
  assert.equal(replay.resumeToken, replay.operationId)
  assert.match(
    replay.repairInstruction!,
    /canonical Notion receipt is confirmed/
  )
  assert.equal(f.vercel.projectReads, projectReadsBeforeReplay)
  assert.equal(f.vercel.promotionCalls, 1)
})

test("conflict persistence failure remains terminal and never says to resume", async () => {
  const f = fixture()
  f.notion.afterUpdate = () => {
    f.vercel.state = "other"
  }
  const first = await f.invoke()
  assert.equal(first.status, "partial_failure")
  assert.equal(first.receiptWritten, true)
  f.store.putFailureWhen = (record) =>
    record.state === "mutation_unknown" && record.result?.status === "conflict"

  const conflict = await f.invoke()
  assert.equal(conflict.status, "conflict")
  assert.equal(conflict.receiptWritten, true)
  assert.equal(conflict.retryable, false)
  assert.equal(conflict.resumeToken, null)
  assert.match(conflict.repairInstruction!, /^Do not resume or reuse/)
  assert.doesNotMatch(conflict.repairInstruction!, /resume this exact/i)
  assert.match(conflict.repairInstruction!, /new approval/i)
  assert.equal(f.vercel.promotionCalls, 1)
})

test("409 and 5xx reconcile and remain ambiguous without retrying POST", async () => {
  for (const mode of ["409", "500"] as const) {
    const f = fixture()
    f.vercel.mode = mode
    const result = await f.invoke()
    assert.equal(result.status, "ambiguous")
    assert.equal(result.retryable, true)
    assert.equal(result.resumeToken, result.operationId)
    assert.equal(f.vercel.promotionCalls, 1)
    assert.equal(f.store.lastTtl, null)
    const again = await f.invoke()
    assert.equal(again.status, "ambiguous")
    assert.equal(f.vercel.promotionCalls, 1)
  }
})

test("reconciliation stops at the hard poll-attempt cap", async () => {
  const f = fixture()
  f.config.pollTimeoutMs = 90_000
  f.config.pollIntervalMs = 1
  f.config.pollMaxAttempts = 3
  f.vercel.mode = "409"
  const result = await f.invoke()
  assert.equal(result.status, "ambiguous")
  assert.equal(f.vercel.promotionCalls, 1)
  // One replay reconstruction, two preflights, and three reconciliation reads.
  assert.equal(f.vercel.projectReads, 6)
})

test("400, 401, and 403 are definite blocked responses with no reconciliation", async () => {
  for (const mode of ["400", "401", "403"] as const) {
    const f = fixture()
    f.vercel.mode = mode
    const readsBefore = f.vercel.projectReads
    const result = await f.invoke()
    assert.equal(result.status, "blocked")
    assert.equal(result.preconditionsVerified, true)
    assert.equal(result.retryable, false)
    assert.equal(result.retryAfterMs, null)
    assert.equal(f.vercel.promotionCalls, 1)
    assert.deepEqual(
      result.steps.map((step) => step.state),
      ["completed", "completed", "blocked", "skipped", "skipped"]
    )
    assert.equal(
      result.records.find((record) => record.kind === "approval")?.state,
      "verified"
    )
    // Initial replay reconstruction + two preflight reads; no post-rejection read.
    assert.equal(f.vercel.projectReads - readsBefore, 3)
  }
})

test("429 is definitely blocked with bounded Retry-After metadata", async () => {
  const f = fixture()
  f.vercel.mode = "429"
  const result = await f.invoke()
  assert.equal(result.status, "blocked")
  assert.equal(result.preconditionsVerified, true)
  assert.equal(result.retryable, true)
  assert.equal(result.retryAfterMs, 12_000)
  assert.equal(result.resumeToken, result.operationId)
  assert.equal(f.vercel.promotionCalls, 1)
  validateOperationRecord([...f.store.operations.values()][0])
  assert.deepEqual(
    result.steps.map((step) => step.state),
    ["completed", "completed", "blocked", "skipped", "skipped"]
  )
})

test("definite rejection remains truthful when prepared persistence fails", async () => {
  const f = fixture()
  f.vercel.mode = "429"
  f.store.putFailureWhen = (record) =>
    record.state === "prepared" &&
    record.mutationAttempts === 1 &&
    record.lastMutationStatus === 429

  const result = await f.invoke()
  assert.equal(result.status, "blocked")
  assert.equal(result.preconditionsVerified, true)
  assert.equal(result.promotionRequested, true)
  assert.equal(result.retryable, true)
  assert.equal(result.retryAfterMs, 12_000)
  assert.equal(result.resumeToken, result.operationId)
  assert.match(result.message, /definite rejection was observed/)
  assert.equal(f.vercel.promotionCalls, 1)
  assert.equal([...f.store.operations.values()][0].state, "mutation_started")

  const replay = await f.invoke()
  assert.equal(replay.status, "ambiguous")
  assert.equal(f.vercel.promotionCalls, 1)
})

test("unsafe prepared records with accepted or uncertain outcomes fail closed", async () => {
  for (const status of [202, 409, 500]) {
    const f = fixture()
    f.vercel.mode = "401"
    const rejected = await f.invoke()
    assert.equal(rejected.status, "blocked")
    const [operationId, stored] = [...f.store.operations.entries()][0]
    stored.lastMutationStatus = status
    stored.lastIssue = `PROMOTION_HTTP_${status}`
    stored.promotionAcceptedAt = status === 202 ? stored.updatedAt : null
    f.store.operations.set(operationId, stored)
    f.vercel.projectReads = 0
    f.vercel.promotionCalls = 0

    const result = await f.invoke()
    assert.equal(result.status, "blocked")
    assert.match(result.message, /COORDINATION_CORRUPT/)
    assert.equal(f.vercel.projectReads, 0)
    assert.equal(f.vercel.promotionCalls, 0)
  }
})

test("conflict and split aliases return distinct terminal families", async () => {
  for (const [mode, expected] of [
    ["conflict", "conflict"],
    ["partial", "partial_failure"],
  ] as const) {
    const f = fixture()
    f.vercel.mode = mode
    const result = await f.invoke()
    assert.equal(result.status, expected)
    assert.equal(f.vercel.promotionCalls, 1)
    assertPromotionResultSemantics(result)
  }
})

test("receipt-only resume never reissues the promotion", async () => {
  const f = fixture()
  f.notion.updateFailures = 1
  const partial = await f.invoke()
  assert.equal(partial.status, "partial_failure")
  assert.equal(partial.currentDeploymentId, input.deploymentId)
  assert.equal(f.vercel.promotionCalls, 1)
  validateOperationRecord([...f.store.operations.values()][0])
  const resumed = await f.invoke()
  assert.equal(resumed.status, "completed")
  assert.equal(resumed.receiptWritten, true)
  assert.equal(f.vercel.promotionCalls, 1)
})

test("receipt writeback is read after write and resumes when Notion drops it", async () => {
  const f = fixture()
  f.notion.dropWrites = true
  const partial = await f.invoke()
  assert.equal(partial.status, "partial_failure")
  assert.match(partial.message, /RECEIPT_READBACK_FAILED/)
  assert.equal(f.vercel.promotionCalls, 1)
  f.notion.dropWrites = false
  const repaired = await f.invoke()
  assert.equal(repaired.status, "completed")
  assert.equal(f.vercel.promotionCalls, 1)
  assert.equal(JSON.parse(f.notion.receipt).operationId, repaired.operationId)
})

test("final complete persistence failure preserves confirmed receipt evidence", async () => {
  const f = fixture()
  f.store.putFailures.set("complete", 1)
  const partial = await f.invoke()
  assert.equal(partial.status, "partial_failure")
  assert.equal(partial.receiptWritten, true)
  assert.equal(partial.currentDeploymentId, input.deploymentId)
  assert.equal(partial.changed, true)
  assert.match(partial.repairInstruction!, /Do not promote again/)
  assert.match(partial.message, /final durable record/)
  assert.equal(f.vercel.promotionCalls, 1)
  assert.notEqual(f.notion.receipt, "")
  assert.equal([...f.store.operations.values()][0].state, "receipt_pending")

  const repaired = await f.invoke()
  assert.equal(repaired.status, "completed")
  assert.equal(repaired.receiptWritten, true)
  assert.equal(f.vercel.promotionCalls, 1)
})

test("completed replay reconstruction survives operation-record loss with zero POSTs", async () => {
  const f = fixture()
  const first = await f.invoke()
  assert.equal(first.status, "completed")
  f.store.operations.clear()
  f.vercel.promotionCalls = 0
  f.vercel.checkConclusion = "failed"
  f.vercel.checkDefinitionReads = 0
  f.vercel.checkRunReads = 0
  const replay = await f.invoke()
  assert.equal(replay.status, "no_op")
  assert.equal(replay.changed, false)
  assert.equal(replay.replay, true)
  assert.equal(f.vercel.promotionCalls, 0)
  assert.equal(f.store.lastTtl, null)
  assert.equal(f.vercel.checkDefinitionReads, 0)
  assert.equal(f.vercel.checkRunReads, 0)
})

test("record-loss reconstruction revalidates immutable Git identity", async () => {
  const f = fixture()
  const first = await f.invoke()
  assert.equal(first.status, "completed")
  f.store.operations.clear()
  f.vercel.promotionCalls = 0
  f.vercel.deploymentGitSha = "c".repeat(40)

  const result = await f.invoke()
  assert.equal(result.status, "blocked")
  assert.match(result.message, /GIT_IDENTITY_MISMATCH/)
  assert.equal(f.vercel.promotionCalls, 0)
})

test("record-loss reconstruction without a receipt requires fresh checks", async () => {
  const f = fixture()
  const first = await f.invoke()
  assert.equal(first.status, "completed")
  f.store.operations.clear()
  f.notion.receipt = ""
  f.vercel.promotionCalls = 0
  f.vercel.checkConclusion = "failed"
  f.vercel.checkDefinitionReads = 0
  f.vercel.checkRunReads = 0
  const updates = f.notion.updates

  const result = await f.invoke()
  assert.equal(result.status, "blocked")
  assert.match(result.message, /DEPLOYMENT_CHECK_FAILED/)
  assert.equal(f.vercel.promotionCalls, 0)
  assert.equal(f.notion.updates, updates)
  assert.equal(f.vercel.checkDefinitionReads, 1)
  assert.equal(f.vercel.checkRunReads, 1)
})

test("stored receipts must match the exact canonical representation", async () => {
  const f = fixture()
  const first = await f.invoke()
  assert.equal(first.status, "completed")
  const receipt = JSON.parse(f.notion.receipt) as Record<string, unknown>
  f.notion.receipt = JSON.stringify({ ...receipt, untrusted: true })
  const replay = await f.invoke()
  assert.equal(replay.status, "partial_failure")
  assert.equal(replay.receiptWritten, false)
  assert.match(replay.message, /RECEIPT_OCCUPIED/)
  assert.equal(f.vercel.promotionCalls, 1)
})

test("completed replay reports live rollback instead of fabricating the historical target", async () => {
  const f = fixture()
  const first = await f.invoke()
  assert.equal(first.status, "completed")

  f.vercel.state = "previous"
  const replay = await f.invoke()
  assert.equal(replay.status, "conflict")
  assert.equal(replay.currentDeploymentId, input.expectedCurrentDeploymentId)
  assert.equal(replay.receiptWritten, true)
  assert.equal(replay.replay, false)
  assert.match(replay.repairInstruction!, /Do not reuse the completed approval/)
  assert.equal(f.vercel.promotionCalls, 1)
})

test("completed replay restores a removed receipt only after live provider verification", async () => {
  const f = fixture()
  const first = await f.invoke()
  assert.equal(first.status, "completed")
  assert.equal(f.notion.updates, 1)

  f.notion.receipt = ""
  const repaired = await f.invoke()
  assert.equal(repaired.status, "completed")
  assert.equal(repaired.receiptWritten, true)
  assert.equal(repaired.replay, false)
  assert.equal(f.notion.updates, 2)
  assert.equal(f.vercel.promotionCalls, 1)

  const replay = await f.invoke()
  assert.equal(replay.status, "no_op")
  assert.equal(replay.receiptWritten, true)
  assert.equal(f.vercel.promotionCalls, 1)
})

test("project-wide lease contention returns blocked before external reads", async () => {
  const f = fixture()
  f.store.leaseHeld = true
  f.store.leaseToken = "another-owner"
  const result = await f.invoke()
  assert.equal(result.status, "blocked")
  assert.equal(result.retryable, true)
  assert.equal(f.vercel.projectReads, 0)
  assert.equal(f.vercel.promotionCalls, 0)
})

test("lease acquisition failures return a typed blocked receipt", async () => {
  const f = fixture()
  f.store.acquireError = new SafetyError(
    "COORDINATION_UNAVAILABLE",
    "The Redis coordination service is unavailable; no promotion was attempted."
  )
  const result = await f.invoke()
  assert.equal(result.status, "blocked")
  assert.equal(result.preconditionsVerified, false)
  assert.equal(result.promotionRequested, false)
  assert.equal(result.retryable, true)
  assert.match(result.message, /COORDINATION_UNAVAILABLE/)
  assert.equal(f.vercel.projectReads, 0)
  assert.equal(f.vercel.promotionCalls, 0)
})

test("malformed durable state fails closed before any provider read or POST", async () => {
  const f = fixture()
  f.store.getError = new SafetyError(
    "COORDINATION_CORRUPT",
    "The durable operation record failed strict validation."
  )
  const result = await f.invoke()
  assert.equal(result.status, "blocked")
  assert.match(result.message, /COORDINATION_CORRUPT/)
  assert.equal(f.vercel.projectReads, 0)
  assert.equal(f.vercel.promotionCalls, 0)
})

test("a stored legacy failed state is rejected before provider reads or POST", async () => {
  const f = fixture()
  const { operationId } = operationIdentity(input)
  const stored: OperationRecord = {
    version: 1,
    operationId,
    state: "failed" as OperationRecord["state"],
    input: structuredClone(input),
    policy: structuredClone(policy),
    createdAt: new Date(NOW_MS).toISOString(),
    updatedAt: new Date(NOW_MS).toISOString(),
    mutationStartedAt: null,
    promotionAcceptedAt: null,
    mutationAttempts: 0,
    lastMutationStatus: null,
    lastIssue: null,
    result: null,
  }
  f.store.operations.set(operationId, stored)

  const result = await f.invoke()
  assert.equal(result.status, "blocked")
  assert.match(result.message, /COORDINATION_CORRUPT/)
  assert.equal(result.promotionRequested, false)
  assert.equal(f.vercel.projectReads, 0)
  assert.equal(f.vercel.promotionCalls, 0)
})

test("stored receipts reject non-canonical deployment hostnames", async () => {
  const f = fixture()
  const completed = await f.invoke()
  assert.equal(completed.status, "completed")
  const [operationId, stored] = [...f.store.operations.entries()][0]
  assert.ok(stored.result)
  stored.result.deploymentUrl = "https://checkout-abc.vercel.app"
  f.store.operations.set(operationId, stored)
  f.vercel.projectReads = 0
  f.vercel.promotionCalls = 0

  const result = await f.invoke()
  assert.equal(result.status, "blocked")
  assert.match(result.message, /COORDINATION_CORRUPT/)
  assert.equal(f.vercel.projectReads, 0)
  assert.equal(f.vercel.promotionCalls, 0)
})

test("lease TTL must exceed the worst uninterrupted bounded preflight", async () => {
  const f = fixture()
  f.config.leaseTtlMs = 65_000
  const result = await f.invoke()
  assert.equal(result.status, "blocked")
  assert.match(result.message, /LEASE_TTL_MS must exceed 65000 ms/)
  assert.equal(f.store.events.length, 0)
  assert.equal(f.vercel.projectReads, 0)
  assert.equal(f.vercel.promotionCalls, 0)
})

test("mutation_started is followed by a fresh lease fence that blocks an overlapping caller", async () => {
  const f = fixture()
  let overlapping: PromotionResult | null = null
  f.vercel.beforePromotion = async () => {
    assert.equal(f.store.events.at(-1), "renew")
    overlapping = await f.invoke()
  }

  const result = await f.invoke()
  assert.equal(result.status, "completed")
  assert.equal(overlapping?.status, "blocked")
  assert.equal(overlapping?.promotionRequested, false)
  assert.equal(f.vercel.promotionCalls, 1)
  const mutationPut = f.store.events.indexOf("put:mutation_started")
  assert.ok(mutationPut >= 0)
  assert.equal(f.store.events[mutationPut + 1], "renew")
})

test("all six public statuses satisfy the common receipt semantics", async () => {
  const results: PromotionResult[] = []

  const completed = fixture()
  results.push(await completed.invoke())
  results.push(await completed.invoke())

  const blocked = fixture()
  blocked.store.leaseHeld = true
  blocked.store.leaseToken = "other"
  results.push(await blocked.invoke())

  for (const mode of ["conflict", "partial", "409"] as const) {
    const f = fixture()
    f.vercel.mode = mode
    results.push(await f.invoke())
  }

  assert.deepEqual(
    results.map((result) => result.status),
    [
      "completed",
      "no_op",
      "blocked",
      "conflict",
      "partial_failure",
      "ambiguous",
    ]
  )
  for (const result of results) assertPromotionResultSemantics(result)
})

test("registered tool has strict input/output schemas and the full receipt family", () => {
  const capability = worker.capabilities.find(
    (candidate) => candidate.key === "promoteApprovedDeployment"
  )
  assert.ok(capability)
  assert.deepEqual(capability.config.hints, { readOnlyHint: false })
  const inputSchema = capability.config.schema as unknown as {
    additionalProperties: boolean
    required: string[]
  }
  const outputSchema = capability.config.outputSchema as unknown as {
    additionalProperties: boolean
    required: string[]
    properties: { status: { enum: string[] } }
  }
  assert.equal(inputSchema.additionalProperties, false)
  assert.equal(outputSchema.additionalProperties, false)
  assert.deepEqual([...outputSchema.properties.status.enum].sort(), [
    "ambiguous",
    "blocked",
    "completed",
    "conflict",
    "no_op",
    "partial_failure",
  ])
  for (const field of [
    "ok",
    "idempotencyKey",
    "changed",
    "replay",
    "preconditionsVerified",
    "records",
    "steps",
    "warnings",
    "retryable",
    "resumeToken",
    "repairInstruction",
  ]) {
    assert.ok(
      outputSchema.required.includes(field),
      `${field} must be required`
    )
  }
  const recordSchema = (
    outputSchema as unknown as {
      properties: {
        records: {
          items: { required: string[]; additionalProperties: boolean }
        }
      }
    }
  ).properties.records.items
  assert.equal(recordSchema.additionalProperties, false)
  assert.deepEqual([...recordSchema.required].sort(), [
    "action",
    "id",
    "kind",
    "state",
    "system",
    "url",
  ])
})

test("registered tool execution bounds oversized provider IDs without echoing them", async () => {
  const names = [
    "VERCEL_ACCESS_TOKEN",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "VERCEL_PROMOTION_TARGETS_JSON",
    "VERCEL_PROMOTION_LEASE_TTL_MS",
  ] as const
  const previous = Object.fromEntries(
    names.map((name) => [name, process.env[name]])
  )
  process.env.VERCEL_ACCESS_TOKEN = "test-token"
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example.com"
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token"
  process.env.VERCEL_PROMOTION_TARGETS_JSON = JSON.stringify([policy])
  delete process.env.VERCEL_PROMOTION_LEASE_TTL_MS
  try {
    const sentinel = "REGISTERED_TOOL_OVERSIZED_ID"
    const result = (await worker.run(
      "promoteApprovedDeployment",
      { ...input, projectId: `prj_${sentinel.repeat(20)}` },
      { concreteOutput: true }
    )) as PromotionResult
    assert.equal(result.status, "blocked")
    assert.equal(result.preconditionsVerified, false)
    assert.equal(result.promotionRequested, false)
    assert.match(result.message, /INVALID_INPUT/)
    assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel))
    assertPromotionResultSemantics(result)
  } finally {
    for (const name of names) {
      const value = previous[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test("operation identity changes with approval revision and is stable otherwise", () => {
  const first = operationIdentity(input)
  assert.deepEqual(first, operationIdentity({ ...input }))
  assert.notEqual(
    first.operationId,
    operationIdentity({ ...input, approvalRevision: "release-42.8" })
      .operationId
  )
  assert.doesNotMatch(first.operationId, /team_|prj_|dpl_/)
})
