import assert from "node:assert/strict"
import { test } from "node:test"
import {
  approvalFingerprint,
  canonicalPromotionIncidentJson,
  promotionIncidentReceiptHash,
  rollbackApprovalFingerprint,
  rollbackOperationIdentity,
} from "../src/approval.js"
import { loadConfig, validateRollbackInput } from "../src/config.js"
import { rollbackApprovedDeployment } from "../src/rollback.js"
import {
  validateOperationRecord,
  validateRollbackMutationClaim,
  validateRollbackOperationRecord,
} from "../src/redis.js"
import type {
  ApprovalPacket,
  NotionClientLike,
  OperationRecord,
  PromotionResult,
  RollbackApprovalPacket,
  RollbackInput,
  RollbackMutationClaim,
  RollbackOperationRecord,
  RollbackRedisOperationStoreLike,
  RollbackRuntimeDependencies,
  RollbackVercelClientLike,
  TargetPolicy,
  VercelDeployment,
  VercelProject,
  WorkerConfig,
} from "../src/types.js"
import { HealthCheckFailure, VercelHttpError } from "../src/types.js"
import worker from "../src/index.js"

const PROMOTION_PAGE = "11111111-1111-4111-8111-111111111111"
const ROLLBACK_PAGE = "22222222-2222-4222-8222-222222222222"
const NOW = "2026-07-03T15:00:00.000Z"

const policy: TargetPolicy = {
  teamId: "team_acme",
  projectId: "prj_checkout",
  productionDomains: ["app.example.com", "www.example.com"],
  deploymentChecks: [{ id: "check_integration", name: "Integration tests" }],
  healthPaths: ["/healthz"],
}

const promotionPacket: ApprovalPacket = {
  approvalStatus: "Approved",
  approvalRevision: "release-42",
  teamId: policy.teamId,
  projectId: policy.projectId,
  deploymentId: "dpl_candidate",
  gitSha: "a".repeat(40),
  gitBranch: "main",
  expectedCurrentDeploymentId: "dpl_previous",
}

function promotionResult(operationId: string): PromotionResult {
  const result: PromotionResult = {
    ok: false,
    operationId,
    idempotencyKey: operationId,
    status: "rollback_recommended",
    changed: true,
    replay: false,
    preconditionsVerified: true,
    promotionRequested: true,
    receiptWritten: true,
    records: [
      {
        kind: "approval",
        system: "notion",
        id: PROMOTION_PAGE,
        url: null,
        action: "receipt_written",
        state: "verified",
      },
      {
        kind: "project",
        system: "vercel",
        id: policy.projectId,
        url: null,
        action: "verified",
        state: "current:dpl_candidate",
      },
      {
        kind: "deployment",
        system: "vercel",
        id: "dpl_candidate",
        url: "https://candidate.vercel.app",
        action: "observed",
        state: "rollback_recommended",
      },
      {
        kind: "production_domain",
        system: "vercel",
        id: "app.example.com",
        url: "https://app.example.com",
        action: "routed",
        state: "target",
      },
      {
        kind: "production_domain",
        system: "vercel",
        id: "www.example.com",
        url: "https://www.example.com",
        action: "routed",
        state: "target",
      },
    ],
    steps: [
      { name: "approval", state: "completed" },
      { name: "preflight", state: "completed" },
      { name: "promotion", state: "completed" },
      { name: "reconciliation", state: "failed" },
      { name: "receipt", state: "skipped" },
    ],
    warnings: ["Post-promotion health failed."],
    retryable: false,
    retryAfterMs: null,
    resumeToken: null,
    repairInstruction: "Obtain fresh rollback approval.",
    teamId: policy.teamId,
    projectId: policy.projectId,
    deploymentId: "dpl_candidate",
    deploymentUrl: "candidate.vercel.app",
    previousDeploymentId: "dpl_previous",
    currentDeploymentId: "dpl_candidate",
    gitSha: promotionPacket.gitSha,
    gitBranch: promotionPacket.gitBranch,
    approvalPageId: PROMOTION_PAGE,
    approvalRevision: promotionPacket.approvalRevision,
    approvalFingerprint: approvalFingerprint(promotionPacket),
    checkIds: ["check_integration"],
    checkNames: ["Integration tests"],
    healthPaths: ["/healthz"],
    productionDomains: [...policy.productionDomains],
    aliasState: policy.productionDomains.map((domain) => ({
      domain,
      deploymentId: "dpl_candidate",
    })),
    healthFailure: { path: "/healthz", outcome: "http_status", status: 503 },
    rollbackRequested: false,
    incidentReceiptHash: "0".repeat(64),
    freshApprovalInstruction:
      "Create a separately fingerprinted rollback approval.",
    rollbackTargetGitSha: "b".repeat(40),
    rollbackTargetGitBranch: "main",
    residualRaceWarning:
      "Vercel exposes no provider compare-and-swap precondition.",
    startedAt: "2026-07-03T14:59:00.000Z",
    completedAt: NOW,
    message:
      "Candidate is current but health failed; no rollback was requested.",
  }
  result.incidentReceiptHash = promotionIncidentReceiptHash(result)
  return result
}

function promotionRecord(): OperationRecord {
  const operationId = `vpa_${"1".repeat(32)}`
  return {
    version: 1,
    operationId,
    state: "mutation_unknown",
    input: {
      approvalPageId: PROMOTION_PAGE,
      approvalRevision: promotionPacket.approvalRevision,
      approvalFingerprint: approvalFingerprint(promotionPacket),
      teamId: policy.teamId,
      projectId: policy.projectId,
      deploymentId: "dpl_candidate",
      expectedGitSha: promotionPacket.gitSha,
      expectedGitBranch: promotionPacket.gitBranch,
      expectedCurrentDeploymentId: "dpl_previous",
    },
    policy: structuredClone(policy),
    createdAt: "2026-07-03T14:59:00.000Z",
    updatedAt: NOW,
    mutationStartedAt: "2026-07-03T14:59:30.000Z",
    promotionAcceptedAt: "2026-07-03T14:59:31.000Z",
    mutationAttempts: 1,
    lastMutationStatus: 202,
    lastIssue: "POST_PROMOTION_HEALTH_FAILED",
    result: promotionResult(operationId),
  }
}

function richText(value: string) {
  return { type: "rich_text", rich_text: value ? [{ plain_text: value }] : [] }
}

class FakeNotion implements NotionClientLike {
  rollbackReceipt = ""
  rollbackPageId = ROLLBACK_PAGE
  rollbackStatus = "Approved"
  updates = 0
  failUpdates = false
  failAfterAppliedUpdate = false
  promotion: OperationRecord
  rollbackPacket: RollbackApprovalPacket
  pages: NotionClientLike["pages"]

  constructor(
    promotion: OperationRecord,
    rollbackPacket: RollbackApprovalPacket
  ) {
    this.promotion = promotion
    this.rollbackPacket = rollbackPacket
    this.pages = {
      retrieve: async ({ page_id }) => {
        if (page_id === PROMOTION_PAGE) {
          return {
            object: "page",
            id: PROMOTION_PAGE,
            archived: false,
            in_trash: false,
            last_edited_time: NOW,
            properties: {
              "Approval status": {
                type: "status",
                status: { name: "Approved" },
              },
              "Approval revision": richText(promotion.input.approvalRevision),
              "Vercel team ID": richText(promotion.input.teamId),
              "Vercel project ID": richText(promotion.input.projectId),
              "Vercel deployment ID": richText(promotion.input.deploymentId),
              "Git SHA": richText(promotion.input.expectedGitSha),
              "Git branch": richText(promotion.input.expectedGitBranch),
              "Expected current deployment ID": richText(
                promotion.input.expectedCurrentDeploymentId
              ),
              "Approval fingerprint": richText(
                promotion.input.approvalFingerprint
              ),
              "Promotion incident": richText(
                canonicalPromotionIncidentJson(promotion.result!)
              ),
            },
          }
        }
        assert.equal(page_id, this.rollbackPageId)
        const p = this.rollbackPacket
        return {
          object: "page",
          id: this.rollbackPageId,
          archived: false,
          in_trash: false,
          last_edited_time: NOW,
          properties: {
            "Rollback approval status": {
              type: "status",
              status: { name: this.rollbackStatus },
            },
            "Rollback approval revision": richText(p.approvalRevision),
            "Original promotion operation ID": richText(
              p.originalPromotionOperationId
            ),
            "Promotion incident page ID": richText(p.promotionIncidentPageId),
            "Original incident receipt hash": richText(
              p.originalIncidentReceiptHash
            ),
            "Rollback Vercel team ID": richText(p.teamId),
            "Rollback Vercel project ID": richText(p.projectId),
            "Rollback candidate deployment ID": richText(
              p.candidateDeploymentId
            ),
            "Rollback target deployment ID": richText(p.rollbackDeploymentId),
            "Rollback approval fingerprint": richText(
              rollbackApprovalFingerprint(p)
            ),
            "Rollback receipt": richText(this.rollbackReceipt),
          },
        }
      },
      update: async ({ page_id, properties }) => {
        assert.equal(page_id, this.rollbackPageId)
        this.updates++
        if (this.failUpdates) throw new Error("notion unavailable")
        assert.deepEqual(Object.keys(properties), ["Rollback receipt"])
        const value = properties["Rollback receipt"] as {
          rich_text: Array<{ text: { content: string } }>
        }
        this.rollbackReceipt = value.rich_text[0].text.content
        if (this.failAfterAppliedUpdate) {
          this.failAfterAppliedUpdate = false
          throw new Error("notion response lost after applied update")
        }
        return { object: "page", id: page_id }
      },
    }
  }
}

class MemoryStore implements RollbackRedisOperationStoreLike {
  promotion: OperationRecord
  rollbacks = new Map<string, RollbackOperationRecord>()
  claims = new Map<string, RollbackMutationClaim>()
  lease: string | null = null
  putStates: string[] = []
  failStateOnce: RollbackOperationRecord["state"] | null = null
  failRenewAfterRollbackStarted = false
  failNextRenew = false
  failSentClaimOnce = false

  constructor(promotion: OperationRecord) {
    this.promotion = promotion
  }
  async acquireLease(_key: string, token: string): Promise<boolean> {
    if (this.lease) return false
    this.lease = token
    return true
  }
  async renewLease(_key: string, token: string): Promise<boolean> {
    if (this.failNextRenew) {
      this.failNextRenew = false
      this.lease = null
      return false
    }
    return this.lease === token
  }
  async releaseLease(_key: string, token: string): Promise<boolean> {
    if (this.lease !== token) return false
    this.lease = null
    return true
  }
  async getOperation(operationId: string): Promise<OperationRecord | null> {
    return operationId === this.promotion.operationId
      ? structuredClone(this.promotion)
      : null
  }
  async putOperation(): Promise<void> {
    throw new Error("not used")
  }
  async getRollbackOperation(
    operationId: string
  ): Promise<RollbackOperationRecord | null> {
    const record = this.rollbacks.get(operationId)
    return record
      ? structuredClone(validateRollbackOperationRecord(record, operationId))
      : null
  }
  async putRollbackOperation(record: RollbackOperationRecord): Promise<void> {
    this.putStates.push(record.state)
    if (this.failStateOnce === record.state) {
      this.failStateOnce = null
      throw new Error("redis unavailable")
    }
    this.rollbacks.set(
      record.operationId,
      structuredClone(
        validateRollbackOperationRecord(record, record.operationId)
      )
    )
    if (
      this.failRenewAfterRollbackStarted &&
      record.state === "rollback_started"
    ) {
      this.failRenewAfterRollbackStarted = false
      this.failNextRenew = true
    }
  }
  async getRollbackMutationClaim(
    claimId: string
  ): Promise<RollbackMutationClaim | null> {
    const claim = this.claims.get(claimId)
    return claim
      ? structuredClone(validateRollbackMutationClaim(claim, claimId))
      : null
  }
  async putRollbackMutationClaim(claim: RollbackMutationClaim): Promise<void> {
    if (this.failSentClaimOnce && claim.state === "sent") {
      this.failSentClaimOnce = false
      throw new Error("claim unavailable")
    }
    this.claims.set(
      claim.claimId,
      structuredClone(validateRollbackMutationClaim(claim, claim.claimId))
    )
  }
}

type ProviderMode = "accepted" | "lost" | number

class FakeVercel implements RollbackVercelClientLike {
  state: "candidate" | "target" | "split" | "third" = "candidate"
  mode: ProviderMode = "accepted"
  rollbackCalls = 0
  projectCalls = 0
  failProjectAfter: number | null = null
  targetHealthy = true
  healthCalls = 0
  healthFailsAfter: number | null = null
  afterHealth: ((call: number) => void) | null = null
  targetGitSha = "b".repeat(40)
  rollingRelease: unknown | null = { rollingRelease: null }
  rollingError: Error | null = null

  async getProject(): Promise<VercelProject> {
    this.projectCalls++
    if (
      this.failProjectAfter !== null &&
      this.projectCalls > this.failProjectAfter
    ) {
      throw new VercelHttpError("project read unavailable", { status: 503 })
    }
    const ids =
      this.state === "target"
        ? ["dpl_previous", "dpl_previous"]
        : this.state === "split"
          ? ["dpl_candidate", "dpl_previous"]
          : this.state === "third"
            ? ["dpl_third", "dpl_third"]
            : ["dpl_candidate", "dpl_candidate"]
    return {
      id: policy.projectId,
      accountId: policy.teamId,
      alias: policy.productionDomains.map((domain, index) => ({
        domain,
        target: "PRODUCTION",
        deployment: { id: ids[index] },
      })),
    }
  }
  async getDeployment(
    _teamId: string,
    deploymentId: string
  ): Promise<VercelDeployment> {
    if (deploymentId === "dpl_candidate") {
      return {
        id: deploymentId,
        projectId: policy.projectId,
        teamId: policy.teamId,
        target: "production",
        readyState: "READY",
        readySubstate: "PROMOTED",
        url: "candidate.vercel.app",
        gitSource: { sha: "a".repeat(40), ref: "main" },
      }
    }
    return {
      id: deploymentId,
      projectId: policy.projectId,
      teamId: policy.teamId,
      target: "production",
      readyState: "READY",
      readySubstate: "PROMOTED",
      url: "previous.vercel.app",
      gitSource: { sha: this.targetGitSha, ref: "main" },
    }
  }
  async getCheckDefinitions() {
    return []
  }
  async getCheckRuns() {
    return []
  }
  async requestPromotion(): Promise<{ status: number }> {
    throw new Error("not used")
  }
  async getRollingRelease(): Promise<unknown | null> {
    if (this.rollingError) throw this.rollingError
    return this.rollingRelease
  }
  async checkHealth(): Promise<void> {
    this.healthCalls++
    this.afterHealth?.(this.healthCalls)
    if (
      !this.targetHealthy ||
      (this.healthFailsAfter !== null &&
        this.healthCalls > this.healthFailsAfter)
    )
      throw new HealthCheckFailure({
        path: "/healthz",
        outcome: "http_status",
        status: 503,
      })
  }
  async requestRollback(): Promise<{ status: 201 }> {
    this.rollbackCalls++
    if (this.mode === "accepted") {
      this.state = "target"
      return { status: 201 }
    }
    if (this.mode === "lost") {
      this.state = "target"
      throw new VercelHttpError("lost response", { ambiguous: true })
    }
    const status = this.mode
    throw new VercelHttpError(`HTTP ${status}`, {
      status,
      ambiguous: ![400, 401, 402, 403, 422, 429].includes(status),
      retryAfterMs: status === 429 ? 12_000 : null,
    })
  }
}

function fixture() {
  let now = Date.parse(NOW)
  const promotion = promotionRecord()
  const result = promotion.result!
  const packet: RollbackApprovalPacket = {
    approvalStatus: "Approved",
    approvalRevision: "rollback-42-r1",
    originalPromotionOperationId: promotion.operationId,
    promotionIncidentPageId: PROMOTION_PAGE,
    originalIncidentReceiptHash: result.incidentReceiptHash!,
    teamId: policy.teamId,
    projectId: policy.projectId,
    candidateDeploymentId: "dpl_candidate",
    rollbackDeploymentId: "dpl_previous",
  }
  const input: RollbackInput = {
    rollbackApprovalPageId: ROLLBACK_PAGE,
    rollbackApprovalRevision: packet.approvalRevision,
    rollbackApprovalFingerprint: rollbackApprovalFingerprint(packet),
    originalPromotionOperationId: packet.originalPromotionOperationId,
    promotionIncidentPageId: packet.promotionIncidentPageId,
    originalIncidentReceiptHash: packet.originalIncidentReceiptHash,
    teamId: packet.teamId,
    projectId: packet.projectId,
    candidateDeploymentId: packet.candidateDeploymentId,
    rollbackDeploymentId: packet.rollbackDeploymentId,
  }
  const notion = new FakeNotion(promotion, packet)
  const store = new MemoryStore(promotion)
  const vercel = new FakeVercel()
  const config: WorkerConfig = {
    vercelToken: "unused",
    redisUrl: "https://redis.example.com",
    redisToken: "unused",
    protectionBypassSecret: null,
    receiptProperty: "Promotion receipt",
    incidentProperty: "Promotion incident",
    rollbackReceiptProperty: "Rollback receipt",
    pollTimeoutMs: 10,
    pollIntervalMs: 1,
    pollMaxAttempts: 2,
    leaseTtlMs: 120_000,
    operationTtlSeconds: 604_800,
    requestTimeoutMs: 10_000,
    healthTimeoutMs: 5_000,
    checkMaxAgeMs: 3_600_000,
    targets: [policy],
  }
  const dependencies: RollbackRuntimeDependencies = {
    notion,
    store,
    vercel,
    now: () => new Date(now),
    sleep: async (ms) => {
      now += ms
    },
    randomToken: () => `lease-${now}`,
  }
  return {
    input,
    notion,
    store,
    vercel,
    config,
    dependencies,
    invoke: () => rollbackApprovedDeployment(input, config, dependencies),
  }
}

function installSecondApproval(
  f: ReturnType<typeof fixture>,
  pageId = "33333333-3333-4333-8333-333333333333"
): RollbackInput {
  const packet: RollbackApprovalPacket = {
    approvalStatus: "Approved",
    approvalRevision: "rollback-42-r2",
    originalPromotionOperationId: f.input.originalPromotionOperationId,
    promotionIncidentPageId: f.input.promotionIncidentPageId,
    originalIncidentReceiptHash: f.input.originalIncidentReceiptHash,
    teamId: f.input.teamId,
    projectId: f.input.projectId,
    candidateDeploymentId: f.input.candidateDeploymentId,
    rollbackDeploymentId: f.input.rollbackDeploymentId,
  }
  f.notion.rollbackPageId = pageId
  f.notion.rollbackPacket = packet
  f.notion.rollbackReceipt = ""
  f.notion.rollbackStatus = "Approved"
  return {
    rollbackApprovalPageId: pageId,
    rollbackApprovalRevision: packet.approvalRevision,
    rollbackApprovalFingerprint: rollbackApprovalFingerprint(packet),
    originalPromotionOperationId: packet.originalPromotionOperationId,
    promotionIncidentPageId: packet.promotionIncidentPageId,
    originalIncidentReceiptHash: packet.originalIncidentReceiptHash,
    teamId: packet.teamId,
    projectId: packet.projectId,
    candidateDeploymentId: packet.candidateDeploymentId,
    rollbackDeploymentId: packet.rollbackDeploymentId,
  }
}

test("fresh approved rollback persists the fence before exactly one POST and replays read-only", async () => {
  const f = fixture()
  const result = await f.invoke()
  assert.equal(result.status, "completed")
  assert.equal(result.disposition, "rolled_back")
  assert.equal(result.causality, "provider_accepted")
  assert.equal(result.rollbackRequestAccepted, true)
  assert.equal(result.rollbackRequested, true)
  assert.equal(result.steps[3].state, "completed")
  assert.equal(result.currentDeploymentId, "dpl_previous")
  assert.equal(result.receiptWritten, true)
  assert.match(result.residualRaceWarning, /no compare-and-swap/)
  assert.equal(f.vercel.rollbackCalls, 1)
  assert.ok(
    f.store.putStates.indexOf("rollback_started") <
      f.store.putStates.indexOf("reconciliation_only")
  )

  const replay = await f.invoke()
  assert.equal(replay.status, "no_op")
  assert.equal(replay.rollbackRequested, true)
  assert.equal(f.vercel.rollbackCalls, 1)
})

test("lost response converges as observed-only and never claims causal rollback", async () => {
  const f = fixture()
  f.vercel.mode = "lost"
  const result = await f.invoke()
  assert.equal(result.status, "completed")
  assert.equal(result.disposition, "observed_restored")
  assert.equal(result.causality, "observed_only")
  assert.equal(result.rollbackRequestAccepted, false)
  assert.equal(f.vercel.rollbackCalls, 1)
  assert.match(result.warnings.join(" "), /no durable HTTP 201/)
  await f.invoke()
  assert.equal(f.vercel.rollbackCalls, 1)
})

test("an already-restored healthy target is a fresh completed adoption with zero POSTs", async () => {
  const f = fixture()
  f.vercel.state = "target"
  const result = await f.invoke()
  assert.equal(result.status, "completed")
  assert.equal(result.replay, false)
  assert.equal(result.disposition, "observed_restored")
  assert.equal(result.causality, "observed_only")
  assert.equal(result.rollbackRequested, false)
  assert.equal(result.changed, false)
  assert.equal(result.receiptWritten, true)
  assert.equal(f.vercel.rollbackCalls, 0)
})

test("candidate unchanged, split aliases, and a third deployment never cause a second or unsafe POST", async () => {
  const unchanged = fixture()
  unchanged.vercel.mode = 500
  const ambiguous = await unchanged.invoke()
  assert.equal(ambiguous.status, "ambiguous")
  assert.equal(ambiguous.disposition, "candidate_unchanged")
  assert.equal(unchanged.vercel.rollbackCalls, 1)
  await unchanged.invoke()
  assert.equal(unchanged.vercel.rollbackCalls, 1)

  for (const state of ["split", "third"] as const) {
    const f = fixture()
    f.vercel.state = state
    const result = await f.invoke()
    assert.equal(
      result.status,
      state === "split" ? "partial_failure" : "conflict"
    )
    assert.equal(f.vercel.rollbackCalls, 0)
    assert.equal(result.rollbackRequested, false)
  }
})

test("fresh approval drift, target Git mismatch, unhealthy target, and rolling release block with zero POSTs", async () => {
  const cases: Array<(f: ReturnType<typeof fixture>) => void> = [
    (f) => {
      f.input.rollbackApprovalRevision = "changed"
    },
    (f) => {
      f.vercel.targetGitSha = "d".repeat(40)
    },
    (f) => {
      f.vercel.targetHealthy = false
    },
    (f) => {
      f.vercel.rollingRelease = { rollingRelease: { state: "ACTIVE" } }
    },
  ]
  for (const mutate of cases) {
    const f = fixture()
    mutate(f)
    const result = await f.invoke()
    assert.equal(result.status, "blocked")
    assert.equal(f.vercel.rollbackCalls, 0)
  }
})

test("approval revoked by the second health check is the final authority gate and sends zero POSTs", async () => {
  const f = fixture()
  f.vercel.afterHealth = (call) => {
    if (call === 2) f.notion.rollbackStatus = "Revoked"
  }
  const result = await f.invoke()
  assert.equal(result.status, "blocked")
  assert.match(result.message, /NOT_APPROVED/)
  assert.equal(f.vercel.healthCalls, 2)
  assert.equal(f.vercel.rollbackCalls, 0)
  assert.equal(
    [...f.store.rollbacks.values()].some(
      (record) => record.state === "rollback_started"
    ),
    false
  )
})

test("official rolling-release null and terminal states are safe; ACTIVE, malformed, and 404 fail closed", async () => {
  for (const rollingRelease of [
    { rollingRelease: null },
    { rollingRelease: { state: "ABORTED" } },
    { rollingRelease: { state: "COMPLETED" } },
  ]) {
    const f = fixture()
    f.vercel.rollingRelease = rollingRelease
    const result = await f.invoke()
    assert.equal(result.status, "completed")
    assert.equal(f.vercel.rollbackCalls, 1)
  }

  const unsafe: Array<(f: ReturnType<typeof fixture>) => void> = [
    (f) => {
      f.vercel.rollingRelease = { rollingRelease: { state: "ACTIVE" } }
    },
    (f) => {
      f.vercel.rollingRelease = { rollingRelease: { state: "UNKNOWN" } }
    },
    (f) => {
      f.vercel.rollingRelease = { unexpected: null }
    },
    (f) => {
      f.vercel.rollingError = new VercelHttpError("HTTP 404", { status: 404 })
    },
  ]
  for (const mutate of unsafe) {
    const f = fixture()
    mutate(f)
    const result = await f.invoke()
    assert.equal(result.status, "blocked")
    assert.equal(f.vercel.rollbackCalls, 0)
  }
})

test("incident-scoped claim allows only one POST across approvals after an uncertain response", async () => {
  const f = fixture()
  f.vercel.mode = 500
  const first = await f.invoke()
  assert.equal(first.status, "ambiguous")
  assert.equal(f.vercel.rollbackCalls, 1)

  const secondInput = installSecondApproval(f)
  f.vercel.mode = "accepted"
  const second = await rollbackApprovedDeployment(
    secondInput,
    f.config,
    f.dependencies
  )
  assert.equal(second.status, "blocked")
  assert.equal(second.resumeMode, "none")
  assert.equal(second.rollbackRequested, false)
  assert.equal(second.receiptWritten, false)
  assert.match(second.repairInstruction!, new RegExp(first.operationId))
  assert.equal(f.vercel.rollbackCalls, 1)
  assert.equal(f.store.claims.size, 1)
})

test("a replacement approval cannot inherit another operation's request causality", async () => {
  const f = fixture()
  f.vercel.mode = 500
  const first = await f.invoke()
  assert.equal(first.requestDisposition, "outcome_unknown")
  assert.equal(f.vercel.rollbackCalls, 1)

  const secondInput = installSecondApproval(f)
  f.vercel.state = "target"
  f.vercel.mode = "accepted"
  const second = await rollbackApprovedDeployment(
    secondInput,
    f.config,
    f.dependencies
  )
  assert.equal(second.status, "blocked")
  assert.equal(second.rollbackRequested, false)
  assert.equal(second.requestDisposition, "not_sent")
  assert.equal(second.causality, "none")
  assert.equal(second.receiptWritten, false)
  assert.equal(f.notion.rollbackReceipt, "")
  assert.equal(f.vercel.rollbackCalls, 1)
})

test("durably recorded definite rejection permits one genuinely new approval to re-arm", async () => {
  const f = fixture()
  f.vercel.mode = 400
  const first = await f.invoke()
  assert.equal(first.status, "blocked")
  assert.equal(f.vercel.rollbackCalls, 1)

  const secondInput = installSecondApproval(f)
  f.vercel.mode = "accepted"
  const second = await rollbackApprovedDeployment(
    secondInput,
    f.config,
    f.dependencies
  )
  assert.equal(second.status, "completed")
  assert.equal(second.requestDisposition, "accepted")
  assert.equal(f.vercel.rollbackCalls, 2)
  assert.equal([...f.store.claims.values()][0].attempts, 2)
})

test("every provider response is one-shot with truthful steps and bounded retry timing", async () => {
  for (const status of [400, 401, 402, 403, 409, 422, 429, 500]) {
    const f = fixture()
    f.vercel.mode = status
    const result = await f.invoke()
    assert.equal(
      result.status,
      [400, 401, 402, 403, 422, 429].includes(status) ? "blocked" : "ambiguous"
    )
    assert.equal(
      result.steps[3].state,
      [400, 401, 402, 403, 422, 429].includes(status) ? "failed" : "pending"
    )
    assert.equal(result.retryAfterMs, status === 429 ? 12_000 : null)
    assert.equal(f.vercel.rollbackCalls, 1)
    await f.invoke()
    assert.equal(f.vercel.rollbackCalls, 1)
  }
})

test("Notion receipt failure resumes receipt-only without a second POST", async () => {
  const f = fixture()
  f.notion.failUpdates = true
  const partial = await f.invoke()
  assert.equal(partial.status, "partial_failure")
  assert.equal(partial.resumeMode, "receipt_only")
  assert.equal(f.vercel.rollbackCalls, 1)
  f.notion.failUpdates = false
  const completed = await f.invoke()
  assert.equal(completed.status, "completed")
  assert.equal(f.vercel.rollbackCalls, 1)
})

test("an applied receipt with a lost response resumes with its durable timestamp", async () => {
  const f = fixture()
  f.notion.failAfterAppliedUpdate = true

  const partial = await f.invoke()
  assert.equal(partial.status, "partial_failure")
  assert.equal(partial.receiptWritten, false)
  assert.notEqual(f.notion.rollbackReceipt, "")
  const verifiedAt = JSON.parse(f.notion.rollbackReceipt).verifiedAt
  assert.equal(f.vercel.rollbackCalls, 1)

  await f.dependencies.sleep(1_000)
  const resumed = await f.invoke()
  assert.equal(resumed.status, "completed")
  assert.equal(resumed.receiptWritten, true)
  assert.equal(resumed.completedAt, verifiedAt)
  assert.equal(JSON.parse(f.notion.rollbackReceipt).verifiedAt, verifiedAt)
  assert.equal(f.vercel.rollbackCalls, 1)
})

test("Redis failure before rollback_started sends zero POSTs; failure after POST preserves the no-repost fence", async () => {
  const before = fixture()
  before.store.failStateOnce = "rollback_started"
  const blocked = await before.invoke()
  assert.equal(blocked.status, "blocked")
  assert.equal(before.vercel.rollbackCalls, 0)

  const after = fixture()
  after.store.failStateOnce = "reconciliation_only"
  const recovered = await after.invoke()
  assert.equal(recovered.status, "completed")
  assert.equal(after.vercel.rollbackCalls, 1)
  await after.invoke()
  assert.equal(after.vercel.rollbackCalls, 1)
})

test("durable pre-request claim failure requires a new approval and then safely re-arms", async () => {
  const f = fixture()
  f.store.failSentClaimOnce = true

  const first = await f.invoke()
  assert.equal(first.status, "ambiguous")
  assert.equal(first.requestDisposition, "not_sent")
  assert.equal(first.rollbackRequested, false)
  assert.equal(first.resumeMode, "reconcile_only")
  assert.match(first.repairInstruction!, /genuinely new rollback approval/)
  assert.equal(f.vercel.rollbackCalls, 0)
  assert.equal(
    [...f.store.rollbacks.values()].some(
      (record) =>
        record.mutationAttempts === 1 &&
        record.lastIssue === "CLAIM_WRITE_FAILED"
    ),
    true
  )

  await f.invoke()
  assert.equal(f.vercel.rollbackCalls, 0)

  const secondInput = installSecondApproval(f)
  const second = await rollbackApprovedDeployment(
    secondInput,
    f.config,
    f.dependencies
  )
  assert.equal(second.status, "completed")
  assert.equal(second.requestDisposition, "accepted")
  assert.equal(second.rollbackRequested, true)
  assert.equal(f.vercel.rollbackCalls, 1)
  assert.equal([...f.store.claims.values()][0].attempts, 1)
})

test("lease loss immediately after rollback_started persistence is an ambiguous no-repost boundary", async () => {
  const f = fixture()
  f.store.failRenewAfterRollbackStarted = true

  const result = await f.invoke()
  assert.equal(result.status, "ambiguous")
  assert.equal(result.requestDisposition, "not_sent")
  assert.equal(result.rollbackRequested, false)
  assert.equal(result.resumeMode, "reconcile_only")
  assert.match(result.message, /durable rollback boundary was crossed/i)
  assert.equal(f.vercel.rollbackCalls, 0)
  assert.equal(
    [...f.store.rollbacks.values()].some(
      (record) =>
        record.mutationAttempts === 1 &&
        (record.state === "rollback_started" ||
          record.state === "reconciliation_only")
    ),
    true
  )

  const replay = await f.invoke()
  assert.equal(replay.status, "ambiguous")
  assert.equal(replay.rollbackRequested, false)
  assert.equal(replay.requestDisposition, "not_sent")
  assert.equal(replay.resumeMode, "reconcile_only")
  assert.equal(f.vercel.rollbackCalls, 0)

  const classified = [...f.store.rollbacks.values()][0]
  assert.equal(classified.requestDisposition, "not_sent")

  const secondInput = installSecondApproval(f)
  const second = await rollbackApprovedDeployment(
    secondInput,
    f.config,
    f.dependencies
  )
  assert.equal(second.status, "completed")
  assert.equal(second.requestDisposition, "accepted")
  assert.equal(f.vercel.rollbackCalls, 1)
})

test("known zero-POST claim failure can durably adopt an external restoration", async () => {
  const f = fixture()
  f.store.failSentClaimOnce = true
  const failed = await f.invoke()
  assert.equal(failed.requestDisposition, "not_sent")
  assert.equal(f.vercel.rollbackCalls, 0)

  f.vercel.state = "target"
  const adopted = await f.invoke()
  assert.equal(adopted.status, "completed")
  assert.equal(adopted.requestDisposition, "not_sent")
  assert.equal(adopted.rollbackRequested, false)
  assert.equal(adopted.receiptWritten, true)
  assert.equal(
    JSON.parse(f.notion.rollbackReceipt).requestDisposition,
    "not_sent"
  )
  assert.equal(f.vercel.rollbackCalls, 0)

  const replay = await f.invoke()
  assert.equal(replay.status, "no_op")
  assert.equal(replay.requestDisposition, "not_sent")
  assert.equal(replay.rollbackRequested, false)
  assert.equal(f.vercel.rollbackCalls, 0)
})

test("accepted rollback that restores an unhealthy target preserves causality and never reposts", async () => {
  const f = fixture()
  // Two preflight target-health checks pass. Reconciliation after the sole POST
  // observes the approved target but receives a bounded health failure.
  f.vercel.healthFailsAfter = 2

  const result = await f.invoke()
  assert.equal(result.status, "partial_failure")
  assert.equal(result.disposition, "observed_restored")
  assert.equal(result.causality, "provider_accepted")
  assert.equal(result.requestDisposition, "accepted")
  assert.equal(result.rollbackRequested, true)
  assert.equal(result.rollbackRequestAccepted, true)
  assert.equal(result.receiptWritten, false)
  assert.deepEqual(result.healthFailure, {
    path: "/healthz",
    outcome: "http_status",
    status: 503,
  })
  assert.equal(result.resumeMode, "reconcile_only")
  assert.equal(f.vercel.rollbackCalls, 1)

  await f.invoke()
  assert.equal(f.vercel.rollbackCalls, 1)
})

test("final completion persistence failure preserves confirmed receipt evidence", async () => {
  const f = fixture()
  f.store.failStateOnce = "complete"

  const partial = await f.invoke()
  assert.equal(partial.status, "partial_failure")
  assert.equal(partial.receiptWritten, true)
  assert.equal(partial.requestDisposition, "accepted")
  assert.equal(partial.rollbackRequestAccepted, true)
  assert.equal(partial.resumeMode, "reconcile_only")
  assert.match(partial.repairInstruction!, /Do not send another rollback POST/)
  assert.notEqual(f.notion.rollbackReceipt, "")
  assert.equal(f.vercel.rollbackCalls, 1)

  await f.dependencies.sleep(1_000)
  const repaired = await f.invoke()
  assert.equal(repaired.status, "completed")
  assert.equal(repaired.receiptWritten, true)
  assert.equal(f.vercel.rollbackCalls, 1)
})

test("post-receipt provider failure resumes with the original receipt timestamp", async () => {
  const f = fixture()
  f.vercel.failProjectAfter = 4

  const partial = await f.invoke()
  assert.equal(partial.status, "partial_failure")
  assert.equal(partial.receiptWritten, true)
  assert.equal(partial.resumeMode, "reconcile_only")
  const verifiedAt = JSON.parse(f.notion.rollbackReceipt).verifiedAt
  assert.equal(partial.completedAt, verifiedAt)
  assert.equal(f.vercel.rollbackCalls, 1)

  f.vercel.failProjectAfter = null
  await f.dependencies.sleep(1_000)
  const resumed = await f.invoke()
  assert.equal(resumed.status, "completed")
  assert.equal(resumed.receiptWritten, true)
  assert.equal(resumed.completedAt, verifiedAt)
  assert.equal(JSON.parse(f.notion.rollbackReceipt).verifiedAt, verifiedAt)
  assert.equal(f.vercel.rollbackCalls, 1)
})

test("non-canonical disposition or rollback SHA fails closed after operation-record loss", async () => {
  for (const mutate of [
    (receipt: Record<string, unknown>) => {
      receipt.requestDisposition = "accepted_without_proof"
    },
    (receipt: Record<string, unknown>) => {
      receipt.rollbackGitSha = 42
    },
    (receipt: Record<string, unknown>) => {
      receipt.rollbackGitSha = "c".repeat(40)
    },
  ]) {
    const f = fixture()
    const completed = await f.invoke()
    assert.equal(completed.status, "completed")
    const operationId = rollbackOperationIdentity(f.input).operationId
    f.store.rollbacks.delete(operationId)
    const receipt = JSON.parse(f.notion.rollbackReceipt) as Record<
      string,
      unknown
    >
    mutate(receipt)
    f.notion.rollbackReceipt = JSON.stringify(receipt)
    f.vercel.rollbackCalls = 0

    const blocked = await f.invoke()
    assert.equal(blocked.status, "blocked")
    assert.match(blocked.message, /ROLLBACK_RECEIPT_OCCUPIED/)
    assert.equal(blocked.rollbackRequested, false)
    assert.equal(f.vercel.rollbackCalls, 0)
  }
})

test("a canonical-looking receipt cannot contradict the surviving incident claim", async () => {
  const f = fixture()
  const completed = await f.invoke()
  assert.equal(completed.requestDisposition, "accepted")
  const operationId = rollbackOperationIdentity(f.input).operationId
  f.store.rollbacks.delete(operationId)
  const receipt = JSON.parse(f.notion.rollbackReceipt) as Record<
    string,
    unknown
  >
  receipt.requestDisposition = "outcome_unknown"
  f.notion.rollbackReceipt = JSON.stringify(receipt)
  f.vercel.rollbackCalls = 0

  const blocked = await f.invoke()
  assert.equal(blocked.status, "blocked")
  assert.match(blocked.message, /ROLLBACK_RECEIPT_OCCUPIED/)
  assert.equal(blocked.rollbackRequested, false)
  assert.equal(f.vercel.rollbackCalls, 0)
})

test("a surviving sent claim cannot validate a different approval's fabricated receipt", async () => {
  const f = fixture()
  f.vercel.mode = 500
  await f.invoke()
  f.vercel.state = "target"
  const completed = await f.invoke()
  assert.equal(completed.status, "completed")
  assert.equal(completed.requestDisposition, "outcome_unknown")
  const originalReceipt = JSON.parse(f.notion.rollbackReceipt) as Record<
    string,
    unknown
  >

  const secondInput = installSecondApproval(f)
  originalReceipt.operationId =
    rollbackOperationIdentity(secondInput).operationId
  originalReceipt.rollbackApprovalFingerprint =
    secondInput.rollbackApprovalFingerprint
  f.notion.rollbackReceipt = JSON.stringify(originalReceipt)
  f.vercel.rollbackCalls = 0

  const blocked = await rollbackApprovedDeployment(
    secondInput,
    f.config,
    f.dependencies
  )
  assert.equal(blocked.status, "blocked")
  assert.match(blocked.message, /ROLLBACK_RECEIPT_OCCUPIED/)
  assert.equal(blocked.rollbackRequested, false)
  assert.equal(f.vercel.rollbackCalls, 0)
})

test("alternate rollback receipt key order is non-canonical after record loss", async () => {
  const f = fixture()
  await f.invoke()
  const operationId = rollbackOperationIdentity(f.input).operationId
  f.store.rollbacks.delete(operationId)
  const receipt = JSON.parse(f.notion.rollbackReceipt) as Record<
    string,
    unknown
  >
  f.notion.rollbackReceipt = JSON.stringify(
    Object.fromEntries(Object.entries(receipt).reverse())
  )
  f.vercel.rollbackCalls = 0

  const blocked = await f.invoke()
  assert.equal(blocked.status, "blocked")
  assert.match(blocked.message, /ROLLBACK_RECEIPT_OCCUPIED/)
  assert.equal(f.vercel.rollbackCalls, 0)
})

test("lost complete Redis record reconstructs only from receipt and live state", async () => {
  const f = fixture()
  await f.invoke()
  const operationId = rollbackOperationIdentity(f.input).operationId
  f.store.rollbacks.delete(operationId)
  const replay = await f.invoke()
  assert.equal(replay.status, "completed")
  assert.equal(f.vercel.rollbackCalls, 1)
})

test("record-loss recovery preserves surviving outcome-unknown claim evidence", async () => {
  const f = fixture()
  f.vercel.mode = 500
  await f.invoke()
  f.vercel.state = "target"
  const completed = await f.invoke()
  assert.equal(completed.requestDisposition, "outcome_unknown")
  const operationId = rollbackOperationIdentity(f.input).operationId
  const claimBefore = structuredClone([...f.store.claims.values()][0])
  f.store.rollbacks.delete(operationId)

  await f.dependencies.sleep(1_000)
  const replay = await f.invoke()
  assert.equal(replay.status, "completed")
  assert.equal(replay.requestDisposition, "outcome_unknown")
  assert.deepEqual([...f.store.claims.values()][0], claimBefore)
  assert.equal(f.vercel.rollbackCalls, 1)
})

test("rollback v2 durable records and strict registered schemas expose the frozen contract", async () => {
  const f = fixture()
  await f.invoke()
  const operationId = rollbackOperationIdentity(f.input).operationId
  const record = f.store.rollbacks.get(operationId)
  assert.ok(record)
  assert.equal(validateRollbackOperationRecord(record).version, 2)
  const claim = [...f.store.claims.values()][0]
  assert.ok(claim)
  assert.equal(
    validateRollbackMutationClaim(claim).kind,
    "rollback_mutation_claim"
  )
  assert.equal(claim.state, "sent")
  assert.equal(claim.attempts, 1)
  assert.throws(
    () =>
      validateRollbackMutationClaim({
        ...structuredClone(claim),
        unexpected: true,
      }),
    /strict structural and semantic validation/
  )
  assert.throws(
    () =>
      validateRollbackMutationClaim({
        ...structuredClone(claim),
        projectId: "prj_other",
      }),
    /strict structural and semantic validation/
  )
  assert.throws(
    () =>
      validateRollbackMutationClaim({
        ...structuredClone(claim),
        lastMutationStatus: 400,
      }),
    /strict structural and semantic validation/
  )
  assert.throws(
    () =>
      validateRollbackMutationClaim({
        ...structuredClone(claim),
        sentAt: "2026-07-03T16:00:00.000Z",
      }),
    /strict structural and semantic validation/
  )
  assert.equal(validateOperationRecord(f.store.promotion).version, 1)

  const capability = worker.capabilities.find(
    (candidate) => candidate.key === "rollbackApprovedDeployment"
  )
  assert.ok(capability)
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
  assert.equal(inputSchema.required.length, 10)
  assert.equal(outputSchema.additionalProperties, false)
  assert.deepEqual([...outputSchema.properties.status.enum].sort(), [
    "ambiguous",
    "blocked",
    "completed",
    "conflict",
    "no_op",
    "partial_failure",
  ])
  for (const key of [
    "causality",
    "disposition",
    "requestDisposition",
    "retryAfterMs",
    "healthFailure",
    "rollbackRequestAccepted",
    "resumeMode",
    "aliasState",
    "residualRaceWarning",
  ]) {
    assert.ok(outputSchema.required.includes(key))
  }
})

test("prepared durable records cannot fabricate terminal success", async () => {
  const f = fixture()
  f.vercel.state = "split"
  const drift = await f.invoke()
  assert.equal(drift.status, "partial_failure")
  const operationId = rollbackOperationIdentity(f.input).operationId
  const corrupted = structuredClone(f.store.rollbacks.get(operationId)!)
  assert.equal(corrupted.state, "prepared")
  assert.ok(corrupted.result)
  for (const mutate of [
    (record: RollbackOperationRecord) => {
      record.result!.rollbackGitSha = "c".repeat(40)
    },
    (record: RollbackOperationRecord) => {
      record.result!.rollbackGitBranch = "fabricated"
    },
    (record: RollbackOperationRecord) => {
      record.result!.promotionApprovalPageId = ROLLBACK_PAGE
    },
    (record: RollbackOperationRecord) => {
      record.result!.productionDomains = ["fabricated.example.com"]
      record.result!.aliasState = [
        { domain: "fabricated.example.com", deploymentId: "dpl_previous" },
      ]
    },
  ]) {
    const fabricated = structuredClone(corrupted)
    mutate(fabricated)
    assert.throws(
      () => validateRollbackOperationRecord(fabricated),
      /strict structural and semantic validation/
    )
  }
  corrupted.result.status = "completed"
  corrupted.result.ok = true
  corrupted.result.receiptWritten = true
  corrupted.result.receiptWrittenAt = NOW
  corrupted.result.completedAt = NOW
  corrupted.result.retryable = false
  corrupted.result.resumeToken = null
  corrupted.result.repairInstruction = null
  assert.throws(
    () => validateRollbackOperationRecord(corrupted),
    /strict structural and semantic validation/
  )

  f.store.rollbacks.set(operationId, corrupted)
  const blocked = await f.invoke()
  assert.equal(blocked.status, "blocked")
  assert.match(blocked.message, /COORDINATION_CORRUPT/)
  assert.equal(f.vercel.rollbackCalls, 0)
})

test("rollback authority pages and Worker-owned Notion properties must be distinct", () => {
  assert.throws(
    () =>
      validateRollbackInput({
        ...fixture().input,
        rollbackApprovalPageId: PROMOTION_PAGE,
      }),
    /must differ from promotionIncidentPageId/
  )

  const baseEnvironment = {
    VERCEL_ACCESS_TOKEN: "token",
    UPSTASH_REDIS_REST_URL: "https://redis.example.com",
    UPSTASH_REDIS_REST_TOKEN: "token",
    VERCEL_PROMOTION_TARGETS_JSON: JSON.stringify([policy]),
  }
  for (const overrides of [
    {
      NOTION_PROMOTION_RECEIPT_PROPERTY: "Shared",
      NOTION_PROMOTION_INCIDENT_PROPERTY: "Shared",
    },
    {
      NOTION_PROMOTION_RECEIPT_PROPERTY: "Shared",
      NOTION_ROLLBACK_RECEIPT_PROPERTY: "Shared",
    },
    {
      NOTION_PROMOTION_INCIDENT_PROPERTY: "Shared",
      NOTION_ROLLBACK_RECEIPT_PROPERTY: "Shared",
    },
  ]) {
    assert.throws(
      () => loadConfig({ ...baseEnvironment, ...overrides }),
      /property names must be distinct/
    )
  }
})
