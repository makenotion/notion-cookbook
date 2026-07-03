import {
  matchingStoredRollbackReceipt,
  parsePromotionIncidentReceipt,
  retrieveApproval,
  retrieveRollbackApproval,
  rollbackMutationClaimIdentity,
  rollbackOperationIdentity,
  verifyApproval,
  verifyRollbackApproval,
  writeRollbackReceipt,
} from "./approval.js"
import {
  DEPLOYMENT_HOSTNAME,
  DEPLOYMENT_ID,
  findTargetPolicy,
  PROJECT_ID,
  TEAM_ID,
  validateRollbackInput,
} from "./config.js"
import type {
  OperationRecord,
  PromotionIncidentReceipt,
  PromotionObservation,
  RollbackApprovalSnapshot,
  RollbackInput,
  RollbackMutationClaim,
  RollbackOperationRecord,
  RollbackResult,
  RollbackResultStatus,
  RollbackRuntimeDependencies,
  TargetPolicy,
  WorkerConfig,
} from "./types.js"
import { HealthCheckFailure, SafetyError, VercelHttpError } from "./types.js"
import { observePromotion, verifyRollbackTarget } from "./vercel.js"

interface LeaseIdentity {
  key: string
  token: string
}

interface Authority {
  promotion: OperationRecord
  incident: PromotionIncidentReceipt
  rollbackApproval: RollbackApprovalSnapshot
}

const RESIDUAL_RACE_WARNING =
  "Vercel provides no compare-and-swap precondition for rollback. The shared project lease coordinates this Worker only; dashboard, CLI, and other API writers can still race after the final read, so this tool never claims absolute no-clobber safety."

function iso(dependencies: RollbackRuntimeDependencies): string {
  return dependencies.now().toISOString()
}

function resultFor(options: {
  operationId: string
  input: RollbackInput
  policy: TargetPolicy
  incident: PromotionIncidentReceipt
  startedAt: string
  status: RollbackResultStatus
  disposition: RollbackResult["disposition"]
  causality?: RollbackResult["causality"]
  rollbackRequested: boolean
  rollbackRequestAccepted?: boolean
  requestDisposition?: RollbackResult["requestDisposition"]
  preconditionsVerified?: boolean
  receiptWritten?: boolean
  receiptWrittenAt?: string | null
  currentDeploymentId?: string | null
  productionDomains?: string[]
  domainDeploymentIds?: Record<string, string | null>
  rollbackDeploymentUrl?: string | null
  completedAt?: string | null
  changed?: boolean
  retryable?: boolean
  retryAfterMs?: number | null
  healthFailure?: RollbackResult["healthFailure"]
  resumeMode?: RollbackResult["resumeMode"]
  repairInstruction?: string | null
  message: string
}): RollbackResult {
  const productionDomains =
    options.productionDomains ?? options.policy.productionDomains
  const aliasState = productionDomains.map((domain) => ({
    domain,
    deploymentId:
      options.domainDeploymentIds?.[domain] ??
      options.currentDeploymentId ??
      null,
  }))
  if (
    (options.currentDeploymentId != null &&
      !DEPLOYMENT_ID.test(options.currentDeploymentId)) ||
    (options.rollbackDeploymentUrl != null &&
      !DEPLOYMENT_HOSTNAME.test(options.rollbackDeploymentUrl)) ||
    aliasState.some(
      (entry) =>
        entry.deploymentId !== null && !DEPLOYMENT_ID.test(entry.deploymentId)
    )
  ) {
    throw new SafetyError(
      "RECEIPT_SEMANTICS",
      "Rollback receipt provider evidence is malformed."
    )
  }
  const ok = options.status === "completed" || options.status === "no_op"
  const replay = options.status === "no_op"
  const accepted = options.rollbackRequestAccepted ?? false
  const causality =
    options.causality ?? (accepted ? "provider_accepted" : "none")
  const requestDisposition =
    options.requestDisposition ??
    (accepted
      ? "accepted"
      : options.rollbackRequested
        ? "outcome_unknown"
        : "not_sent")
  const receiptWritten = options.receiptWritten ?? false
  const retryable =
    options.retryable ??
    (options.status === "ambiguous" || options.status === "partial_failure")
  const resumeMode =
    options.resumeMode ??
    (retryable ? "reconcile_only" : ok ? "complete" : "none")
  const repairInstruction = ok
    ? null
    : (options.repairInstruction ??
      (retryable
        ? "Resume this exact rollback operation for read-only reconciliation; it will never issue another rollback POST."
        : "Investigate the reported authority or production-state conflict and require a new approval for any new mutation."))
  const rollbackState = !options.rollbackRequested
    ? "skipped"
    : accepted ||
        options.disposition === "rolled_back" ||
        options.disposition === "observed_restored"
      ? "completed"
      : options.status === "blocked"
        ? "failed"
        : "pending"
  const successState = ok ? "completed" : "failed"
  const steps: RollbackResult["steps"] =
    options.preconditionsVerified === false
      ? [
          { name: "incident", state: "blocked" },
          { name: "approval", state: "blocked" },
          { name: "preflight", state: "blocked" },
          { name: "rollback", state: "skipped" },
          { name: "reconciliation", state: "skipped" },
          { name: "receipt", state: "skipped" },
        ]
      : [
          { name: "incident", state: "completed" },
          { name: "approval", state: "completed" },
          { name: "preflight", state: "completed" },
          { name: "rollback", state: rollbackState },
          {
            name: "reconciliation",
            state: options.status === "ambiguous" ? "pending" : successState,
          },
          {
            name: "receipt",
            state: receiptWritten ? "completed" : ok ? "pending" : "skipped",
          },
        ]
  const warnings = [RESIDUAL_RACE_WARNING]
  if (causality === "observed_only") {
    warnings.push(
      "Production was observed on the rollback target, but no durable HTTP 201 proves this operation caused that change."
    )
  }
  if (options.disposition === "split")
    warnings.push(
      "Production aliases are split; no mutation retry is permitted."
    )
  const result: RollbackResult = {
    ok,
    operationId: options.operationId,
    idempotencyKey: options.operationId,
    status: options.status,
    changed:
      options.changed ??
      (options.disposition === "rolled_back" ||
        options.disposition === "observed_restored"),
    replay,
    preconditionsVerified: options.preconditionsVerified ?? true,
    rollbackRequested: options.rollbackRequested,
    receiptWritten,
    causality,
    disposition: options.disposition,
    rollbackRequestAccepted: accepted,
    requestDisposition,
    resumeMode,
    retryable,
    retryAfterMs: options.retryAfterMs ?? null,
    resumeToken: retryable ? options.operationId : null,
    repairInstruction,
    originalPromotionOperationId: options.input.originalPromotionOperationId,
    originalIncidentReceiptHash: options.input.originalIncidentReceiptHash,
    teamId: options.input.teamId,
    projectId: options.input.projectId,
    candidateDeploymentId: options.input.candidateDeploymentId,
    rollbackDeploymentId: options.input.rollbackDeploymentId,
    currentDeploymentId: options.currentDeploymentId ?? null,
    rollbackDeploymentUrl: options.rollbackDeploymentUrl ?? null,
    rollbackGitSha: options.incident.rollbackTargetGitSha,
    rollbackGitBranch: options.incident.rollbackTargetGitBranch,
    promotionApprovalPageId: options.incident.promotionApprovalPageId,
    promotionIncidentPageId: options.input.promotionIncidentPageId,
    rollbackApprovalPageId: options.input.rollbackApprovalPageId,
    rollbackApprovalRevision: options.input.rollbackApprovalRevision,
    rollbackApprovalFingerprint: options.input.rollbackApprovalFingerprint,
    productionDomains: [...productionDomains],
    aliasState,
    healthPaths: [...options.policy.healthPaths],
    healthFailure: options.healthFailure ?? null,
    receiptWrittenAt: options.receiptWrittenAt ?? null,
    startedAt: options.startedAt,
    completedAt: options.completedAt ?? null,
    warnings,
    residualRaceWarning: RESIDUAL_RACE_WARNING,
    steps,
    message: options.message,
  }
  assertRollbackResultSemantics(result)
  return result
}

export function assertRollbackResultSemantics(result: RollbackResult): void {
  const success = result.status === "completed" || result.status === "no_op"
  if (
    result.ok !== success ||
    result.idempotencyKey !== result.operationId ||
    result.replay !== (result.status === "no_op") ||
    result.retryable !== (result.resumeToken !== null) ||
    !(
      result.retryAfterMs === null ||
      (Number.isSafeInteger(result.retryAfterMs) &&
        result.retryAfterMs >= 0 &&
        result.retryAfterMs <= 300_000)
    ) ||
    (success && result.repairInstruction !== null) ||
    (!success && result.repairInstruction === null) ||
    (result.causality === "provider_accepted") !==
      result.rollbackRequestAccepted ||
    (result.requestDisposition === "accepted") !==
      result.rollbackRequestAccepted ||
    (result.requestDisposition === "not_sent") !== !result.rollbackRequested ||
    (result.requestDisposition === "outcome_unknown") !==
      (result.rollbackRequested && !result.rollbackRequestAccepted) ||
    result.receiptWritten !== (result.receiptWrittenAt !== null) ||
    result.steps.length !== 6 ||
    result.steps[3]?.state !==
      (!result.rollbackRequested
        ? "skipped"
        : result.rollbackRequestAccepted ||
            result.disposition === "rolled_back" ||
            result.disposition === "observed_restored"
          ? "completed"
          : result.status === "blocked"
            ? "failed"
            : "pending") ||
    !result.residualRaceWarning.includes("no compare-and-swap")
  ) {
    throw new SafetyError(
      "RECEIPT_SEMANTICS",
      "The rollback receipt fields are internally inconsistent."
    )
  }
}

function assertNoActiveRollingRelease(value: unknown | null): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SafetyError(
      "ROLLING_RELEASE_RESPONSE_INVALID",
      "Vercel returned an invalid rolling-release wrapper."
    )
  }
  const wrapper = value as Record<string, unknown>
  if (
    Object.keys(wrapper).length !== 1 ||
    !Object.hasOwn(wrapper, "rollingRelease")
  ) {
    throw new SafetyError(
      "ROLLING_RELEASE_RESPONSE_INVALID",
      "Vercel returned an unexpected rolling-release wrapper."
    )
  }
  const rollingRelease = wrapper.rollingRelease
  if (rollingRelease === null) return
  if (
    !rollingRelease ||
    typeof rollingRelease !== "object" ||
    Array.isArray(rollingRelease)
  ) {
    throw new SafetyError(
      "ROLLING_RELEASE_RESPONSE_INVALID",
      "Vercel returned an invalid rolling-release state."
    )
  }
  const state = (rollingRelease as Record<string, unknown>).state
  if (state === "ABORTED" || state === "COMPLETED") return
  if (state === "ACTIVE") {
    throw new SafetyError(
      "ROLLING_RELEASE_ACTIVE",
      "Vercel reports an active rolling release; this tool does not abort or combine with it."
    )
  }
  throw new SafetyError(
    "ROLLING_RELEASE_RESPONSE_INVALID",
    "Vercel returned an unsupported rolling-release state."
  )
}

function assertIncidentAuthority(
  promotion: OperationRecord,
  incident: PromotionIncidentReceipt,
  input: RollbackInput,
  policy: TargetPolicy
): void {
  const recommendation = promotion.result
  if (
    recommendation?.status !== "rollback_recommended" ||
    recommendation.receiptWritten !== true ||
    recommendation.incidentReceiptHash !== input.originalIncidentReceiptHash ||
    promotion.operationId !== input.originalPromotionOperationId ||
    promotion.input.approvalPageId !== input.promotionIncidentPageId ||
    promotion.input.teamId !== input.teamId ||
    promotion.input.projectId !== input.projectId ||
    promotion.input.deploymentId !== input.candidateDeploymentId ||
    promotion.input.expectedCurrentDeploymentId !==
      input.rollbackDeploymentId ||
    incident.operationId !== promotion.operationId ||
    incident.teamId !== input.teamId ||
    incident.projectId !== input.projectId ||
    incident.candidateDeploymentId !== input.candidateDeploymentId ||
    incident.expectedPriorDeploymentId !== input.rollbackDeploymentId ||
    incident.promotionApprovalPageId !== input.promotionIncidentPageId ||
    incident.candidateGitSha !== promotion.input.expectedGitSha ||
    incident.candidateGitBranch !== promotion.input.expectedGitBranch ||
    JSON.stringify(incident.productionDomains) !==
      JSON.stringify(recommendation.productionDomains) ||
    JSON.stringify(incident.aliasState) !==
      JSON.stringify(recommendation.aliasState) ||
    incident.aliasState.some(
      (entry) => entry.deploymentId !== input.candidateDeploymentId
    ) ||
    JSON.stringify(promotion.policy) !== JSON.stringify(policy)
  ) {
    throw new SafetyError(
      "INCIDENT_AUTHORITY_MISMATCH",
      "The durable promotion incident, its Notion receipt, and the rollback request do not identify one exact release transition."
    )
  }
}

async function readAuthority(
  input: RollbackInput,
  policy: TargetPolicy,
  config: WorkerConfig,
  dependencies: RollbackRuntimeDependencies,
  requireEmptyRollbackReceipt: boolean
): Promise<Authority> {
  const promotion = await dependencies.store.getOperation(
    input.originalPromotionOperationId
  )
  if (!promotion) {
    throw new SafetyError(
      "PROMOTION_RECORD_MISSING",
      "The original durable promotion incident record is missing; rollback authority cannot be reconstructed from caller input alone."
    )
  }
  const [promotionPage, rollbackApproval] = await Promise.all([
    retrieveApproval(
      dependencies.notion,
      input.promotionIncidentPageId,
      config.incidentProperty ?? "Promotion incident",
      16_000
    ),
    retrieveRollbackApproval(
      dependencies.notion,
      input.rollbackApprovalPageId,
      config.rollbackReceiptProperty ?? "Rollback receipt"
    ),
  ])
  verifyApproval(promotionPage, promotion.input, { requireRevision: true })
  verifyRollbackApproval(rollbackApproval, input, { requireRevision: true })
  if (requireEmptyRollbackReceipt && rollbackApproval.receiptText) {
    throw new SafetyError(
      "ROLLBACK_RECEIPT_NOT_EMPTY",
      "A fresh rollback approval requires an empty Worker-owned rollback receipt property."
    )
  }
  const incident = parsePromotionIncidentReceipt(
    promotionPage.receiptText,
    input.originalIncidentReceiptHash
  )
  assertIncidentAuthority(promotion, incident, input, policy)
  return { promotion, incident, rollbackApproval }
}

async function ensureLease(
  lease: LeaseIdentity,
  config: WorkerConfig,
  dependencies: RollbackRuntimeDependencies
): Promise<void> {
  if (
    !(await dependencies.store.renewLease(
      lease.key,
      lease.token,
      config.leaseTtlMs
    ))
  ) {
    throw new SafetyError(
      "LEASE_LOST",
      "The shared project-wide promotion/rollback lease expired or changed owner."
    )
  }
}

async function saveRecord(
  record: RollbackOperationRecord,
  lease: LeaseIdentity,
  config: WorkerConfig,
  dependencies: RollbackRuntimeDependencies
): Promise<void> {
  await ensureLease(lease, config, dependencies)
  record.updatedAt = iso(dependencies)
  await dependencies.store.putRollbackOperation(record)
  await ensureLease(lease, config, dependencies)
}

async function persistOperationBoundary(
  record: RollbackOperationRecord,
  lease: LeaseIdentity,
  config: WorkerConfig,
  dependencies: RollbackRuntimeDependencies
): Promise<void> {
  await ensureLease(lease, config, dependencies)
  record.updatedAt = iso(dependencies)
  await dependencies.store.putRollbackOperation(record)
}

async function saveClaim(
  claim: RollbackMutationClaim,
  lease: LeaseIdentity,
  config: WorkerConfig,
  dependencies: RollbackRuntimeDependencies
): Promise<void> {
  await ensureLease(lease, config, dependencies)
  claim.updatedAt = iso(dependencies)
  await dependencies.store.putRollbackMutationClaim(claim)
  await ensureLease(lease, config, dependencies)
}

async function persistSentClaim(
  claim: RollbackMutationClaim,
  lease: LeaseIdentity,
  config: WorkerConfig,
  dependencies: RollbackRuntimeDependencies
): Promise<void> {
  await ensureLease(lease, config, dependencies)
  claim.updatedAt = iso(dependencies)
  await dependencies.store.putRollbackMutationClaim(claim)
}

function newMutationClaim(
  input: RollbackInput,
  operationId: string,
  createdAt: string
): RollbackMutationClaim {
  const { claimId } = rollbackMutationClaimIdentity(input)
  return {
    version: 1,
    kind: "rollback_mutation_claim",
    claimId,
    state: "operation_fenced",
    promotionOperationId: input.originalPromotionOperationId,
    promotionIncidentHash: input.originalIncidentReceiptHash,
    teamId: input.teamId,
    projectId: input.projectId,
    candidateDeploymentId: input.candidateDeploymentId,
    rollbackDeploymentId: input.rollbackDeploymentId,
    activeOperationId: operationId,
    attempts: 0,
    createdAt,
    updatedAt: createdAt,
    sentAt: null,
    definitelyRejectedAt: null,
    lastMutationStatus: null,
    lastRetryAfterMs: null,
  }
}

function rearmClaim(claim: RollbackMutationClaim, operationId: string): void {
  claim.state = "operation_fenced"
  claim.activeOperationId = operationId
  claim.sentAt = null
  claim.definitelyRejectedAt = null
  claim.lastMutationStatus = null
  claim.lastRetryAfterMs = null
}

function applyClaimHistory(
  record: RollbackOperationRecord,
  claim: RollbackMutationClaim
): void {
  if (claim.state !== "sent" && claim.state !== "definitely_rejected") return
  record.rollbackStartedAt ??= claim.sentAt
  record.mutationAttempts = 1
  record.lastMutationStatus = claim.lastMutationStatus
  record.lastRetryAfterMs = claim.lastRetryAfterMs
  if (claim.lastMutationStatus === 201) {
    record.rollbackAcceptedAt ??= claim.updatedAt
    record.requestDisposition = "accepted"
  } else {
    record.requestDisposition = "outcome_unknown"
  }
  if (record.state === "prepared" || record.state === "rollback_started") {
    record.state = "reconciliation_only"
  }
}

function newRecord(
  operationId: string,
  input: RollbackInput,
  policy: TargetPolicy,
  incident: PromotionIncidentReceipt,
  createdAt: string
): RollbackOperationRecord {
  const { claimId } = rollbackMutationClaimIdentity(input)
  return {
    version: 2,
    kind: "rollback",
    operationId,
    state: "prepared",
    input: { ...input },
    policy: {
      ...policy,
      productionDomains: [...policy.productionDomains],
      deploymentChecks: policy.deploymentChecks.map((check) => ({ ...check })),
      healthPaths: [...policy.healthPaths],
    },
    incident: structuredClone(incident),
    claimId,
    promotionOperationId: input.originalPromotionOperationId,
    promotionIncidentHash: input.originalIncidentReceiptHash,
    createdAt,
    updatedAt: createdAt,
    rollbackStartedAt: null,
    rollbackAcceptedAt: null,
    mutationAttempts: 0,
    requestDisposition: "not_sent",
    lastMutationStatus: null,
    lastRetryAfterMs: null,
    lastIssue: null,
    result: null,
  }
}

function assertRecordIdentity(
  record: RollbackOperationRecord,
  input: RollbackInput,
  policy: TargetPolicy
): void {
  if (
    JSON.stringify(record.input) !== JSON.stringify(input) ||
    JSON.stringify(record.policy) !== JSON.stringify(policy)
  ) {
    throw new SafetyError(
      "COORDINATION_CORRUPT",
      "The durable rollback record does not match this exact approved request."
    )
  }
}

async function verifyProviderPreconditions(
  authority: Authority,
  input: RollbackInput,
  policy: TargetPolicy,
  dependencies: RollbackRuntimeDependencies
): Promise<PromotionObservation> {
  const [candidate, observation, rollingRelease] = await Promise.all([
    dependencies.vercel.getDeployment(
      input.teamId,
      input.candidateDeploymentId
    ),
    observePromotion(
      dependencies.vercel,
      policy,
      input.candidateDeploymentId,
      input.rollbackDeploymentId
    ),
    dependencies.vercel.getRollingRelease(input.teamId, input.projectId),
  ])
  assertNoActiveRollingRelease(rollingRelease)
  verifyRollbackTarget({
    project: observation.project,
    deployment: candidate,
    teamId: input.teamId,
    projectId: input.projectId,
    deploymentId: input.candidateDeploymentId,
    expectedGitSha: authority.incident.candidateGitSha,
    expectedGitBranch: authority.incident.candidateGitBranch,
  })
  verifyRollbackTarget({
    project: observation.project,
    deployment: observation.deployment,
    teamId: input.teamId,
    projectId: input.projectId,
    deploymentId: input.rollbackDeploymentId,
    expectedGitSha: authority.incident.rollbackTargetGitSha,
    expectedGitBranch: authority.incident.rollbackTargetGitBranch,
  })
  await dependencies.vercel.checkHealth(
    observation.deployment.url!,
    policy.healthPaths
  )
  return observation
}

function classificationDisposition(
  observation: PromotionObservation
): RollbackResult["disposition"] {
  if (observation.classification === "target_current")
    return "observed_restored"
  if (observation.classification === "expected_current")
    return "candidate_unchanged"
  if (observation.classification === "other_current") return "third_deployment"
  return "split"
}

function requestDispositionFor(
  record: RollbackOperationRecord
): RollbackResult["requestDisposition"] {
  return record.requestDisposition
}

function rollbackWasRequested(record: RollbackOperationRecord): boolean {
  return record.requestDisposition !== "not_sent"
}

async function finishReceipt(
  record: RollbackOperationRecord,
  authority: Authority,
  observation: PromotionObservation,
  causality: RollbackResult["causality"],
  disposition: "rolled_back" | "observed_restored",
  lease: LeaseIdentity,
  config: WorkerConfig,
  dependencies: RollbackRuntimeDependencies
): Promise<RollbackResult> {
  const completedAt =
    record.result?.completedAt &&
    (record.state === "receipt_pending" || record.result.receiptWritten)
      ? record.result.completedAt
      : iso(dependencies)
  const accepted = causality === "provider_accepted"
  const pending = resultFor({
    operationId: record.operationId,
    retryAfterMs: record.lastRetryAfterMs,
    input: record.input,
    policy: record.policy,
    incident: authority.incident,
    startedAt: record.createdAt,
    status: "partial_failure",
    disposition,
    causality,
    rollbackRequested: rollbackWasRequested(record),
    rollbackRequestAccepted: accepted,
    receiptWritten: false,
    currentDeploymentId: record.input.rollbackDeploymentId,
    productionDomains: observation.productionDomains,
    domainDeploymentIds: observation.domainDeploymentIds,
    rollbackDeploymentUrl: observation.deployment.url ?? null,
    completedAt,
    changed: true,
    retryable: true,
    resumeMode: "receipt_only",
    repairInstruction:
      "Resume this exact operation only to verify provider state and write/read back the rollback receipt; no POST will be sent.",
    message:
      "Production is restored and healthy; the fresh Notion rollback receipt is pending.",
  })
  record.state = "receipt_pending"
  record.result = pending
  await saveRecord(record, lease, config, dependencies)
  try {
    await writeRollbackReceipt(
      dependencies.notion,
      record.input,
      config.rollbackReceiptProperty ?? "Rollback receipt",
      {
        ...pending,
        status: "completed",
        ok: true,
        retryable: false,
        resumeToken: null,
        repairInstruction: null,
      }
    )
  } catch (error) {
    record.lastIssue =
      error instanceof SafetyError ? error.code : "RECEIPT_WRITE_FAILED"
    try {
      await saveRecord(record, lease, config, dependencies)
    } catch {
      /* receipt_pending fence is durable */
    }
    return {
      ...pending,
      message: `Production is restored and healthy, but Notion receipt write/readback failed (${record.lastIssue}).`,
    }
  }
  const receiptWrittenAt = iso(dependencies)
  let finalObservation: PromotionObservation
  try {
    await ensureLease(lease, config, dependencies)
    finalObservation = await observePromotion(
      dependencies.vercel,
      record.policy,
      record.input.candidateDeploymentId,
      record.input.rollbackDeploymentId
    )
    await ensureLease(lease, config, dependencies)
    if (finalObservation.classification === "target_current") {
      verifyRollbackTarget({
        project: finalObservation.project,
        deployment: finalObservation.deployment,
        teamId: record.input.teamId,
        projectId: record.input.projectId,
        deploymentId: record.input.rollbackDeploymentId,
        expectedGitSha: authority.incident.rollbackTargetGitSha,
        expectedGitBranch: authority.incident.rollbackTargetGitBranch,
      })
    }
  } catch (error) {
    const issue =
      error instanceof SafetyError
        ? error.code
        : error instanceof VercelHttpError
          ? `VERCEL_READ_${error.status ?? "FAILED"}`
          : "FINAL_PROVIDER_READ_FAILED"
    const failure = resultFor({
      operationId: record.operationId,
      retryAfterMs: record.lastRetryAfterMs,
      input: record.input,
      policy: record.policy,
      incident: authority.incident,
      startedAt: record.createdAt,
      status: "partial_failure",
      disposition,
      causality,
      rollbackRequested: rollbackWasRequested(record),
      rollbackRequestAccepted: accepted,
      receiptWritten: true,
      receiptWrittenAt,
      currentDeploymentId: record.input.rollbackDeploymentId,
      productionDomains: observation.productionDomains,
      domainDeploymentIds: observation.domainDeploymentIds,
      rollbackDeploymentUrl: observation.deployment.url ?? null,
      completedAt,
      changed: rollbackWasRequested(record),
      retryable: true,
      resumeMode: "reconcile_only",
      repairInstruction:
        "Do not send another rollback POST. The canonical Notion receipt was confirmed; restore provider/coordination reads and resume this operation read-only.",
      message: `The canonical rollback receipt is confirmed, but final provider or identity verification failed (${issue}).`,
    })
    record.state = "reconciliation_only"
    record.lastIssue = issue
    record.result = failure
    try {
      await saveRecord(record, lease, config, dependencies)
    } catch {
      /* receipt evidence remains authoritative even if Redis is unavailable */
    }
    return failure
  }
  if (finalObservation.classification !== "target_current") {
    const finalDisposition = classificationDisposition(finalObservation)
    const status =
      finalDisposition === "third_deployment" ? "conflict" : "partial_failure"
    const drift = resultFor({
      operationId: record.operationId,
      retryAfterMs: record.lastRetryAfterMs,
      input: record.input,
      policy: record.policy,
      incident: authority.incident,
      startedAt: record.createdAt,
      status,
      disposition: finalDisposition,
      causality,
      rollbackRequested: rollbackWasRequested(record),
      rollbackRequestAccepted: accepted,
      receiptWritten: true,
      receiptWrittenAt,
      currentDeploymentId: finalObservation.currentDeploymentId,
      productionDomains: finalObservation.productionDomains,
      domainDeploymentIds: finalObservation.domainDeploymentIds,
      rollbackDeploymentUrl: finalObservation.deployment.url ?? null,
      completedAt,
      changed: true,
      retryable: status === "partial_failure",
      resumeMode: "reconcile_only",
      repairInstruction:
        "Do not send another rollback. Investigate the provider drift and resume this exact operation only for read-only reconciliation.",
      message:
        "The canonical rollback receipt was read back, but production changed during final provider verification.",
    })
    record.state = "reconciliation_only"
    record.lastIssue = "POST_RECEIPT_PROVIDER_STATE_CHANGED"
    record.result = drift
    try {
      await saveRecord(record, lease, config, dependencies)
    } catch {
      /* preserve the confirmed receipt in the returned result */
    }
    return drift
  }
  const noPost = !rollbackWasRequested(record)
  const completed = resultFor({
    operationId: record.operationId,
    retryAfterMs: record.lastRetryAfterMs,
    input: record.input,
    policy: record.policy,
    incident: authority.incident,
    startedAt: record.createdAt,
    status: "completed",
    disposition,
    causality,
    rollbackRequested: rollbackWasRequested(record),
    rollbackRequestAccepted: accepted,
    receiptWritten: true,
    receiptWrittenAt,
    currentDeploymentId: record.input.rollbackDeploymentId,
    productionDomains: finalObservation.productionDomains,
    domainDeploymentIds: finalObservation.domainDeploymentIds,
    rollbackDeploymentUrl: finalObservation.deployment.url ?? null,
    completedAt,
    changed: !noPost,
    retryable: false,
    resumeMode: "complete",
    message: noPost
      ? "The exact prior deployment was already healthy on every production domain before mutation; the Worker wrote an observed-only receipt and sent zero rollback POSTs."
      : accepted
        ? "Vercel returned HTTP 201, every exact production domain is restored to the approved prior deployment, health passed, and the fresh Notion receipt was read back."
        : "Every exact production domain is observed on the approved prior deployment and health passed, but no durable HTTP 201 proves this operation caused restoration; the Notion receipt records observed-only causality.",
  })
  record.state = "complete"
  record.lastIssue = null
  record.result = completed
  try {
    await saveRecord(record, lease, config, dependencies)
  } catch (error) {
    const issue =
      error instanceof SafetyError ? error.code : "COORDINATION_UNAVAILABLE"
    return resultFor({
      operationId: record.operationId,
      retryAfterMs: record.lastRetryAfterMs,
      input: record.input,
      policy: record.policy,
      incident: authority.incident,
      startedAt: record.createdAt,
      status: "partial_failure",
      disposition,
      causality,
      rollbackRequested: rollbackWasRequested(record),
      rollbackRequestAccepted: accepted,
      receiptWritten: true,
      receiptWrittenAt,
      currentDeploymentId: record.input.rollbackDeploymentId,
      productionDomains: finalObservation.productionDomains,
      domainDeploymentIds: finalObservation.domainDeploymentIds,
      rollbackDeploymentUrl: finalObservation.deployment.url ?? null,
      completedAt,
      changed: !noPost,
      retryable: true,
      resumeMode: "reconcile_only",
      repairInstruction:
        "Do not send another rollback POST. The provider state and canonical receipt are confirmed; restore Redis and resume read-only to rebuild completion state.",
      message: `Rollback and receipt are confirmed, but final durable completion failed (${issue}).`,
    })
  }
  return completed
}

async function reconcile(
  record: RollbackOperationRecord,
  authority: Authority,
  lease: LeaseIdentity,
  config: WorkerConfig,
  dependencies: RollbackRuntimeDependencies,
  poll: boolean
): Promise<RollbackResult> {
  const attempts = poll ? config.pollMaxAttempts : 1
  let lastObservation: PromotionObservation | null = null
  let lastIssue = record.lastIssue ?? "ROLLBACK_RECONCILIATION_PENDING"
  let healthFailure: RollbackResult["healthFailure"] = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    await ensureLease(lease, config, dependencies)
    try {
      const observation = await observePromotion(
        dependencies.vercel,
        record.policy,
        record.input.candidateDeploymentId,
        record.input.rollbackDeploymentId
      )
      lastObservation = observation
      await ensureLease(lease, config, dependencies)
      if (observation.classification === "target_current") {
        verifyRollbackTarget({
          project: observation.project,
          deployment: observation.deployment,
          teamId: record.input.teamId,
          projectId: record.input.projectId,
          deploymentId: record.input.rollbackDeploymentId,
          expectedGitSha: authority.incident.rollbackTargetGitSha,
          expectedGitBranch: authority.incident.rollbackTargetGitBranch,
        })
        await dependencies.vercel.checkHealth(
          observation.deployment.url!,
          record.policy.healthPaths
        )
        await ensureLease(lease, config, dependencies)
        const finalObservation = await observePromotion(
          dependencies.vercel,
          record.policy,
          record.input.candidateDeploymentId,
          record.input.rollbackDeploymentId
        )
        await ensureLease(lease, config, dependencies)
        if (finalObservation.classification !== "target_current") {
          lastObservation = finalObservation
          lastIssue = "POST_HEALTH_ALIAS_DRIFT"
        } else {
          verifyRollbackTarget({
            project: finalObservation.project,
            deployment: finalObservation.deployment,
            teamId: record.input.teamId,
            projectId: record.input.projectId,
            deploymentId: record.input.rollbackDeploymentId,
            expectedGitSha: authority.incident.rollbackTargetGitSha,
            expectedGitBranch: authority.incident.rollbackTargetGitBranch,
          })
          const causality = record.rollbackAcceptedAt
            ? "provider_accepted"
            : "observed_only"
          return finishReceipt(
            record,
            authority,
            finalObservation,
            causality,
            causality === "provider_accepted"
              ? "rolled_back"
              : "observed_restored",
            lease,
            config,
            dependencies
          )
        }
      }
      if (observation.classification === "other_current") break
      lastIssue = `OBSERVED_${observation.classification.toUpperCase()}`
    } catch (error) {
      lastIssue =
        error instanceof SafetyError
          ? error.code
          : error instanceof VercelHttpError
            ? `VERCEL_READ_${error.status ?? "FAILED"}`
            : "RECONCILIATION_READ_FAILED"
      if (error instanceof HealthCheckFailure) {
        healthFailure = { ...error.evidence }
        break
      }
    }
    if (attempt + 1 < attempts) await dependencies.sleep(config.pollIntervalMs)
  }
  const disposition = lastObservation
    ? classificationDisposition(lastObservation)
    : "unknown"
  const definiteRejected =
    record.lastMutationStatus !== null &&
    [400, 401, 402, 403, 422, 429].includes(record.lastMutationStatus)
  const status: RollbackResultStatus =
    disposition === "third_deployment"
      ? "conflict"
      : disposition === "split" ||
          (disposition === "observed_restored" && healthFailure !== null)
        ? "partial_failure"
        : definiteRejected
          ? "blocked"
          : "ambiguous"
  const retryable = status === "ambiguous" || status === "partial_failure"
  const result = resultFor({
    operationId: record.operationId,
    retryAfterMs: record.lastRetryAfterMs,
    input: record.input,
    policy: record.policy,
    incident: authority.incident,
    startedAt: record.createdAt,
    status,
    disposition,
    causality: record.rollbackAcceptedAt
      ? "provider_accepted"
      : disposition === "observed_restored"
        ? "observed_only"
        : "none",
    rollbackRequested: rollbackWasRequested(record),
    rollbackRequestAccepted: record.rollbackAcceptedAt !== null,
    receiptWritten: record.result?.receiptWritten ?? false,
    receiptWrittenAt: record.result?.receiptWrittenAt ?? null,
    currentDeploymentId: lastObservation?.currentDeploymentId ?? null,
    productionDomains: lastObservation?.productionDomains,
    domainDeploymentIds: lastObservation?.domainDeploymentIds,
    rollbackDeploymentUrl: lastObservation?.deployment.url ?? null,
    completedAt: record.result?.completedAt ?? null,
    healthFailure,
    changed: disposition !== "candidate_unchanged" && disposition !== "unknown",
    retryable,
    resumeMode: "reconcile_only",
    repairInstruction:
      healthFailure !== null && disposition === "observed_restored"
        ? "Do not send another rollback POST. The approved target owns every production domain but is unhealthy; investigate or create a new separately approved incident action."
        : definiteRejected
          ? `Vercel returned a definite HTTP ${record.lastMutationStatus} response. This approval is fenced from another POST; inspect provider policy and create a genuinely new approval only if another attempt is desired.`
          : undefined,
    message:
      healthFailure !== null && disposition === "observed_restored"
        ? "Production is restored to the exact approved target, but a fixed target health check failed; the sole rollback POST will never be repeated."
        : `Rollback reconciliation is not authoritative (${lastIssue}); the sole POST will never be repeated.`,
  })
  record.state = "reconciliation_only"
  record.lastIssue = lastIssue
  record.result = result
  try {
    await saveRecord(record, lease, config, dependencies)
  } catch {
    /* rollback_started remains a no-repost fence */
  }
  return result
}

async function completeObservedWithoutPost(
  record: RollbackOperationRecord,
  authority: Authority,
  observation: PromotionObservation,
  lease: LeaseIdentity,
  config: WorkerConfig,
  dependencies: RollbackRuntimeDependencies
): Promise<RollbackResult> {
  // No provider mutation needs a rollback_started fence on this path.
  record.lastIssue = "ALREADY_RESTORED_BEFORE_POST"
  return finishReceipt(
    record,
    authority,
    observation,
    "observed_only",
    "observed_restored",
    lease,
    config,
    dependencies
  )
}

async function verifyCompleteReplay(
  record: RollbackOperationRecord,
  authority: Authority,
  lease: LeaseIdentity,
  config: WorkerConfig,
  dependencies: RollbackRuntimeDependencies
): Promise<RollbackResult> {
  const observation = await observePromotion(
    dependencies.vercel,
    record.policy,
    record.input.candidateDeploymentId,
    record.input.rollbackDeploymentId
  )
  await ensureLease(lease, config, dependencies)
  const stored = matchingStoredRollbackReceipt(
    authority.rollbackApproval,
    record.input,
    record.operationId,
    authority.incident.rollbackTargetGitSha,
    requestDispositionFor(record)
  )
  if (observation.classification !== "target_current" || !stored) {
    return resultFor({
      operationId: record.operationId,
      retryAfterMs: record.lastRetryAfterMs,
      input: record.input,
      policy: record.policy,
      incident: authority.incident,
      startedAt: record.createdAt,
      status:
        observation.classification === "partial"
          ? "partial_failure"
          : "conflict",
      disposition: classificationDisposition(observation),
      causality: record.rollbackAcceptedAt
        ? "provider_accepted"
        : "observed_only",
      rollbackRequested: rollbackWasRequested(record),
      rollbackRequestAccepted: record.rollbackAcceptedAt !== null,
      receiptWritten: stored !== null,
      receiptWrittenAt: stored?.verifiedAt ?? null,
      currentDeploymentId: observation.currentDeploymentId,
      productionDomains: observation.productionDomains,
      domainDeploymentIds: observation.domainDeploymentIds,
      rollbackDeploymentUrl: observation.deployment.url ?? null,
      changed: false,
      retryable: false,
      resumeMode: "complete",
      repairInstruction:
        "Investigate provider or Notion drift; never reuse this completed rollback approval for another POST.",
      message:
        "The completed rollback receipt no longer matches both live production and Notion state.",
    })
  }
  verifyRollbackTarget({
    project: observation.project,
    deployment: observation.deployment,
    teamId: record.input.teamId,
    projectId: record.input.projectId,
    deploymentId: record.input.rollbackDeploymentId,
    expectedGitSha: authority.incident.rollbackTargetGitSha,
    expectedGitBranch: authority.incident.rollbackTargetGitBranch,
  })
  await dependencies.vercel.checkHealth(
    observation.deployment.url!,
    record.policy.healthPaths
  )
  await ensureLease(lease, config, dependencies)
  const finalObservation = await observePromotion(
    dependencies.vercel,
    record.policy,
    record.input.candidateDeploymentId,
    record.input.rollbackDeploymentId
  )
  await ensureLease(lease, config, dependencies)
  const finalApproval = await retrieveRollbackApproval(
    dependencies.notion,
    record.input.rollbackApprovalPageId,
    config.rollbackReceiptProperty ?? "Rollback receipt"
  )
  verifyRollbackApproval(finalApproval, record.input, { requireRevision: true })
  const finalStored = matchingStoredRollbackReceipt(
    finalApproval,
    record.input,
    record.operationId,
    authority.incident.rollbackTargetGitSha,
    requestDispositionFor(record)
  )
  if (finalObservation.classification !== "target_current" || !finalStored) {
    return resultFor({
      operationId: record.operationId,
      retryAfterMs: record.lastRetryAfterMs,
      input: record.input,
      policy: record.policy,
      incident: authority.incident,
      startedAt: record.createdAt,
      status:
        finalObservation.classification === "partial"
          ? "partial_failure"
          : "conflict",
      disposition: classificationDisposition(finalObservation),
      causality: record.rollbackAcceptedAt
        ? "provider_accepted"
        : "observed_only",
      rollbackRequested: rollbackWasRequested(record),
      rollbackRequestAccepted: record.rollbackAcceptedAt !== null,
      receiptWritten: finalStored !== null,
      receiptWrittenAt: finalStored?.verifiedAt ?? null,
      currentDeploymentId: finalObservation.currentDeploymentId,
      productionDomains: finalObservation.productionDomains,
      domainDeploymentIds: finalObservation.domainDeploymentIds,
      rollbackDeploymentUrl: finalObservation.deployment.url ?? null,
      changed: false,
      retryable: false,
      resumeMode: "complete",
      repairInstruction:
        "Investigate provider or Notion drift; never reuse this completed rollback approval for another POST.",
      message:
        "The completed rollback changed during read-only replay verification.",
    })
  }
  verifyRollbackTarget({
    project: finalObservation.project,
    deployment: finalObservation.deployment,
    teamId: record.input.teamId,
    projectId: record.input.projectId,
    deploymentId: record.input.rollbackDeploymentId,
    expectedGitSha: authority.incident.rollbackTargetGitSha,
    expectedGitBranch: authority.incident.rollbackTargetGitBranch,
  })
  return resultFor({
    operationId: record.operationId,
    retryAfterMs: record.lastRetryAfterMs,
    input: record.input,
    policy: record.policy,
    incident: authority.incident,
    startedAt: record.createdAt,
    status: "no_op",
    disposition:
      record.result?.disposition === "rolled_back"
        ? "rolled_back"
        : "observed_restored",
    causality: record.rollbackAcceptedAt
      ? "provider_accepted"
      : "observed_only",
    rollbackRequested: rollbackWasRequested(record),
    rollbackRequestAccepted: record.rollbackAcceptedAt !== null,
    receiptWritten: true,
    receiptWrittenAt: finalStored.verifiedAt,
    currentDeploymentId: record.input.rollbackDeploymentId,
    productionDomains: finalObservation.productionDomains,
    domainDeploymentIds: finalObservation.domainDeploymentIds,
    rollbackDeploymentUrl: finalObservation.deployment.url ?? null,
    completedAt: record.result?.completedAt ?? finalStored.verifiedAt,
    changed: false,
    retryable: false,
    resumeMode: "complete",
    message:
      "The exact prior deployment remains healthy on every production domain and the canonical rollback receipt is present; replay issued no POST.",
  })
}

function safeInput(value: unknown): RollbackInput {
  const object =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const pick = (name: string, fallback: string) =>
    typeof object[name] === "string" ? (object[name] as string) : fallback
  return {
    rollbackApprovalPageId: pick(
      "rollbackApprovalPageId",
      "00000000-0000-4000-8000-000000000000"
    ),
    rollbackApprovalRevision: pick("rollbackApprovalRevision", "invalid"),
    rollbackApprovalFingerprint: pick(
      "rollbackApprovalFingerprint",
      "0".repeat(64)
    ),
    originalPromotionOperationId: pick(
      "originalPromotionOperationId",
      `vpa_${"0".repeat(32)}`
    ),
    promotionIncidentPageId: pick(
      "promotionIncidentPageId",
      "00000000-0000-4000-8000-000000000000"
    ),
    originalIncidentReceiptHash: pick(
      "originalIncidentReceiptHash",
      "0".repeat(64)
    ),
    teamId: pick("teamId", "team_invalid"),
    projectId: pick("projectId", "prj_invalid"),
    candidateDeploymentId: pick("candidateDeploymentId", "dpl_invalid"),
    rollbackDeploymentId: pick("rollbackDeploymentId", "dpl_invalid2"),
  }
}

function blockedResult(
  value: unknown,
  dependencies: RollbackRuntimeDependencies,
  error: unknown
): RollbackResult {
  const input = safeInput(value)
  const incident: PromotionIncidentReceipt = {
    version: 1,
    operationId: input.originalPromotionOperationId,
    status: "promotion_health_failed",
    teamId: input.teamId,
    projectId: input.projectId,
    candidateDeploymentId: input.candidateDeploymentId,
    expectedPriorDeploymentId: input.rollbackDeploymentId,
    promotionApprovalPageId: input.promotionIncidentPageId,
    promotionApprovalRevision: "invalid",
    promotionApprovalFingerprint: "0".repeat(64),
    candidateGitSha: "0".repeat(40),
    candidateGitBranch: "invalid",
    rollbackTargetGitSha: "0".repeat(40),
    rollbackTargetGitBranch: "invalid",
    healthFailure: {
      path: "/invalid",
      outcome: "transport_error",
      status: null,
    },
    productionDomains: ["invalid.example"],
    aliasState: [
      { domain: "invalid.example", deploymentId: input.candidateDeploymentId },
    ],
    observedAt: iso(dependencies),
  }
  const policy: TargetPolicy = {
    teamId: input.teamId,
    projectId: input.projectId,
    productionDomains: ["invalid.example"],
    deploymentChecks: [],
    healthPaths: ["/invalid"],
  }
  const operationId = rollbackOperationIdentity(input).operationId
  const code = error instanceof SafetyError ? error.code : "INVALID_INPUT"
  const detail =
    error instanceof Error
      ? error.message
      : "The rollback request failed closed."
  return resultFor({
    operationId,
    input,
    policy,
    incident,
    startedAt: iso(dependencies),
    status: "blocked",
    disposition: "unknown",
    rollbackRequested: false,
    preconditionsVerified: false,
    changed: false,
    retryable: false,
    resumeMode: "none",
    repairInstruction:
      "Correct the authority, configuration, or bounded input failure and obtain explicit confirmation before any new call.",
    message: `${code}: ${detail}`,
  })
}

function boundaryFailureResult(
  record: RollbackOperationRecord,
  error: unknown,
  knownNotSentPersisted = false
): RollbackResult {
  const prior = record.result
  const domainDeploymentIds = prior
    ? Object.fromEntries(
        prior.aliasState.map((entry) => [entry.domain, entry.deploymentId])
      )
    : undefined
  const issue =
    error instanceof SafetyError
      ? error.code
      : error instanceof VercelHttpError
        ? `VERCEL_${error.status ?? "FAILED"}`
        : "POST_BOUNDARY_FAILURE"
  const receiptWritten = prior?.receiptWritten === true
  return resultFor({
    operationId: record.operationId,
    input: record.input,
    policy: record.policy,
    incident: record.incident,
    startedAt: record.createdAt,
    status: receiptWritten ? "partial_failure" : "ambiguous",
    disposition: prior?.disposition ?? "unknown",
    causality: record.rollbackAcceptedAt
      ? "provider_accepted"
      : prior?.disposition === "observed_restored"
        ? "observed_only"
        : "none",
    rollbackRequested: rollbackWasRequested(record),
    rollbackRequestAccepted: record.rollbackAcceptedAt !== null,
    receiptWritten,
    receiptWrittenAt: prior?.receiptWrittenAt ?? null,
    currentDeploymentId: prior?.currentDeploymentId ?? null,
    productionDomains: prior?.productionDomains,
    domainDeploymentIds,
    rollbackDeploymentUrl: prior?.rollbackDeploymentUrl ?? null,
    completedAt: prior?.completedAt ?? null,
    changed: prior?.changed ?? false,
    retryable: true,
    retryAfterMs: record.lastRetryAfterMs,
    healthFailure: prior?.healthFailure ?? null,
    resumeMode: "reconcile_only",
    repairInstruction: knownNotSentPersisted
      ? "This approval is permanently reconciliation-only. No rollback request was sent; after repairing coordination, create a genuinely new rollback approval if a new attempt is still required."
      : "Do not send another rollback POST or create a replacement approval. Restore authority/coordination reads and resume this exact operation for reconciliation only.",
    message: knownNotSentPersisted
      ? `The durable operation fence was written, but the incident dispatch claim failed (${issue}); zero rollback POSTs were sent and only a genuinely new approval may re-arm the incident claim.`
      : `The durable rollback boundary was crossed (${issue}); this and every replacement approval are fenced from another POST until a definite provider rejection is durably recorded.`,
  })
}

export async function rollbackApprovedDeployment(
  input: RollbackInput,
  config: WorkerConfig,
  dependencies: RollbackRuntimeDependencies
): Promise<RollbackResult> {
  let policy: TargetPolicy
  try {
    validateRollbackInput(input)
    policy = findTargetPolicy(config, input)
  } catch (error) {
    return blockedResult(input, dependencies, error)
  }
  const { operationId, leaseKey } = rollbackOperationIdentity(input)
  const { claimId } = rollbackMutationClaimIdentity(input)
  const lease: LeaseIdentity = {
    key: leaseKey,
    token: dependencies.randomToken(),
  }
  const startedAt = iso(dependencies)
  let acquired = false
  let record: RollbackOperationRecord | null = null
  let claim: RollbackMutationClaim | null = null
  let authority: Authority | null = null
  let crossedBoundary = false
  let discoveredKnownPreRequestGap = false
  try {
    acquired = await dependencies.store.acquireLease(
      lease.key,
      lease.token,
      config.leaseTtlMs
    )
    if (!acquired) {
      throw new SafetyError(
        "LEASE_BUSY",
        "The shared project-wide promotion/rollback lease is already held."
      )
    }
    record = await dependencies.store.getRollbackOperation(operationId)
    if (record) assertRecordIdentity(record, input, policy)
    crossedBoundary = record?.mutationAttempts === 1
    claim = await dependencies.store.getRollbackMutationClaim(claimId)
    if (
      record &&
      claim?.state === "operation_fenced" &&
      claim.activeOperationId === record.operationId &&
      record.mutationAttempts === 1 &&
      record.requestDisposition === "not_sent" &&
      (record.state === "rollback_started" ||
        record.state === "reconciliation_only")
    ) {
      record.state = "reconciliation_only"
      record.lastIssue = "CLAIM_WRITE_FAILED"
      record.result = null
      discoveredKnownPreRequestGap = true
    }
    if (
      record &&
      claim &&
      claim.activeOperationId === record.operationId &&
      (claim.state === "sent" || claim.state === "definitely_rejected") &&
      !(
        claim.state === "sent" &&
        claim.lastMutationStatus === null &&
        record.requestDisposition === "not_sent"
      )
    ) {
      applyClaimHistory(record, claim)
    }
    try {
      authority = await readAuthority(
        input,
        policy,
        config,
        dependencies,
        false
      )
    } catch (error) {
      if (crossedBoundary && record) return boundaryFailureResult(record, error)
      throw error
    }
    await ensureLease(lease, config, dependencies)
    if (discoveredKnownPreRequestGap && record) {
      await saveRecord(record, lease, config, dependencies)
    }

    if (record?.state === "complete") {
      return await verifyCompleteReplay(
        record,
        authority,
        lease,
        config,
        dependencies
      )
    }
    if (record?.state === "prepared" && record.result) {
      return record.result
    }
    if (record?.state === "receipt_pending") {
      return await reconcile(
        record,
        authority,
        lease,
        config,
        dependencies,
        false
      )
    }
    if (
      record &&
      (record.state === "rollback_started" ||
        record.state === "reconciliation_only")
    ) {
      return await reconcile(
        record,
        authority,
        lease,
        config,
        dependencies,
        false
      )
    }

    // A lost complete Redis record is reconstructed only from a canonical
    // Notion receipt plus live target state; an empty receipt never authorizes a repost.
    if (!record) {
      const claimReceiptDisposition =
        claim?.state === "sent" && claim.activeOperationId === operationId
          ? claim.lastMutationStatus === 201
            ? "accepted"
            : "outcome_unknown"
          : undefined
      const stored = matchingStoredRollbackReceipt(
        authority.rollbackApproval,
        input,
        operationId,
        authority.incident.rollbackTargetGitSha,
        claimReceiptDisposition
      )
      if (
        authority.rollbackApproval.receiptText &&
        (!stored ||
          (claim !== null &&
            (claim.state !== "sent" ||
              claim.activeOperationId !== operationId)))
      ) {
        throw new SafetyError(
          "ROLLBACK_RECEIPT_OCCUPIED",
          "The rollback receipt contains non-matching content or contradicts the durable incident claim."
        )
      }
      if (stored) {
        record = newRecord(
          operationId,
          input,
          policy,
          authority.incident,
          startedAt
        )
        if (stored.requestDisposition !== "not_sent") {
          record.state = "reconciliation_only"
          record.requestDisposition = stored.requestDisposition
          if (claim) {
            applyClaimHistory(record, claim)
          } else {
            record.rollbackStartedAt = stored.verifiedAt
            record.mutationAttempts = 1
            if (stored.requestDisposition === "accepted") {
              record.rollbackAcceptedAt = stored.verifiedAt
              record.lastMutationStatus = 201
            }
            claim = newMutationClaim(input, operationId, startedAt)
            claim.state = "sent"
            claim.activeOperationId = operationId
            claim.attempts = 1
            claim.sentAt = stored.verifiedAt
            claim.definitelyRejectedAt = null
            claim.lastMutationStatus =
              stored.requestDisposition === "accepted" ? 201 : null
            claim.lastRetryAfterMs = null
            await saveClaim(claim, lease, config, dependencies)
          }
        }
        record.state = "reconciliation_only"
        record.result = resultFor({
          operationId,
          input,
          policy,
          incident: authority.incident,
          startedAt: record.createdAt,
          status: "partial_failure",
          disposition:
            stored.requestDisposition === "accepted"
              ? "rolled_back"
              : "observed_restored",
          causality:
            stored.requestDisposition === "accepted"
              ? "provider_accepted"
              : "observed_only",
          rollbackRequested: stored.requestDisposition !== "not_sent",
          rollbackRequestAccepted: stored.requestDisposition === "accepted",
          receiptWritten: true,
          receiptWrittenAt: stored.verifiedAt,
          currentDeploymentId: input.rollbackDeploymentId,
          productionDomains: policy.productionDomains,
          domainDeploymentIds: Object.fromEntries(
            policy.productionDomains.map((domain) => [
              domain,
              input.rollbackDeploymentId,
            ])
          ),
          completedAt: stored.verifiedAt,
          changed: stored.requestDisposition !== "not_sent",
          retryable: true,
          resumeMode: "reconcile_only",
          repairInstruction:
            "The canonical receipt survived coordination-record loss. Resume this operation only for live read-only verification; no rollback POST will be sent.",
          message:
            "The canonical rollback receipt was recovered after coordination-record loss; live provider and health verification are pending.",
        })
        await saveRecord(record, lease, config, dependencies)
        return await reconcile(
          record,
          authority,
          lease,
          config,
          dependencies,
          false
        )
      }
    }

    if (claim?.state === "sent") {
      record ??= newRecord(
        operationId,
        input,
        policy,
        authority.incident,
        startedAt
      )
      if (claim.activeOperationId !== operationId) {
        const prior = claim.activeOperationId
          ? await dependencies.store.getRollbackOperation(
              claim.activeOperationId
            )
          : null
        if (prior?.requestDisposition === "not_sent") {
          rearmClaim(claim, operationId)
          await saveClaim(claim, lease, config, dependencies)
        } else {
          const fenced = resultFor({
            operationId,
            input,
            policy,
            incident: authority.incident,
            startedAt: record.createdAt,
            status: "blocked",
            disposition: "unknown",
            rollbackRequested: false,
            preconditionsVerified: false,
            changed: false,
            retryable: false,
            resumeMode: "none",
            repairInstruction: `Do not use this replacement approval. Resume incident owner ${claim.activeOperationId} for read-only reconciliation; a new approval cannot inherit or repeat its request.`,
            message:
              "This incident already has a sent or outcome-unknown rollback claim owned by another approval; this operation issued zero POSTs and cannot write a causal receipt.",
          })
          record.lastIssue = "INCIDENT_MUTATION_ALREADY_SENT"
          record.result = fenced
          await saveRecord(record, lease, config, dependencies)
          return fenced
        }
      }
      if (claim.state === "sent") {
        record.requestDisposition = "outcome_unknown"
        applyClaimHistory(record, claim)
        record.lastIssue ??= "INCIDENT_MUTATION_ALREADY_SENT"
        await saveRecord(record, lease, config, dependencies)
        return await reconcile(
          record,
          authority,
          lease,
          config,
          dependencies,
          false
        )
      }
    }

    if (
      claim?.state === "definitely_rejected" &&
      claim.activeOperationId === operationId
    ) {
      record ??= newRecord(
        operationId,
        input,
        policy,
        authority.incident,
        startedAt
      )
      applyClaimHistory(record, claim)
      record.lastIssue = `ROLLBACK_HTTP_${claim.lastMutationStatus}`
      await saveRecord(record, lease, config, dependencies)
      return await reconcile(
        record,
        authority,
        lease,
        config,
        dependencies,
        false
      )
    }

    if (
      claim?.state === "operation_fenced" &&
      claim.activeOperationId !== operationId
    ) {
      const prior = claim.activeOperationId
        ? await dependencies.store.getRollbackOperation(claim.activeOperationId)
        : null
      if (prior?.mutationAttempts === 1) {
        if (prior.requestDisposition !== "not_sent") {
          record ??= newRecord(
            operationId,
            input,
            policy,
            authority.incident,
            startedAt
          )
          record.rollbackStartedAt = prior.rollbackStartedAt ?? claim.updatedAt
          record.mutationAttempts = 1
          record.state = "reconciliation_only"
          record.lastIssue = "CLAIM_PREVIOUS_BOUNDARY_UNKNOWN"
          await saveRecord(record, lease, config, dependencies)
          return await reconcile(
            record,
            authority,
            lease,
            config,
            dependencies,
            false
          )
        }
      }
    }

    await verifyProviderPreconditions(authority, input, policy, dependencies)
    await ensureLease(lease, config, dependencies)
    record ??= newRecord(
      operationId,
      input,
      policy,
      authority.incident,
      startedAt
    )
    await saveRecord(record, lease, config, dependencies)

    // Repeat expensive provider gates first. The fresh rollback approval is
    // the final authority read before either durable mutation fence.
    const observation = await verifyProviderPreconditions(
      authority,
      input,
      policy,
      dependencies
    )
    await ensureLease(lease, config, dependencies)
    authority = await readAuthority(input, policy, config, dependencies, true)
    await ensureLease(lease, config, dependencies)

    if (observation.classification === "target_current") {
      return await completeObservedWithoutPost(
        record,
        authority,
        observation,
        lease,
        config,
        dependencies
      )
    }
    if (observation.classification !== "expected_current") {
      const disposition = classificationDisposition(observation)
      const drift = resultFor({
        operationId,
        input,
        policy,
        incident: authority.incident,
        startedAt: record.createdAt,
        status:
          disposition === "third_deployment" ? "conflict" : "partial_failure",
        disposition,
        rollbackRequested: false,
        currentDeploymentId: observation.currentDeploymentId,
        productionDomains: observation.productionDomains,
        domainDeploymentIds: observation.domainDeploymentIds,
        rollbackDeploymentUrl: observation.deployment.url ?? null,
        changed: false,
        retryable: false,
        resumeMode: "none",
        repairInstruction:
          "Do not roll back from drifted production state. Investigate the split or third deployment and require a new incident decision.",
        message:
          "The exact production domains no longer unanimously point to the incident candidate; zero rollback POSTs were sent.",
      })
      record.result = drift
      await saveRecord(record, lease, config, dependencies)
      return drift
    }

    if (!claim) {
      claim = newMutationClaim(input, operationId, iso(dependencies))
      await saveClaim(claim, lease, config, dependencies)
    } else if (claim.state === "definitely_rejected") {
      rearmClaim(claim, operationId)
      await saveClaim(claim, lease, config, dependencies)
    } else if (
      claim.state === "operation_fenced" &&
      claim.activeOperationId !== operationId
    ) {
      rearmClaim(claim, operationId)
      await saveClaim(claim, lease, config, dependencies)
    }
    if (
      claim.state !== "operation_fenced" ||
      claim.activeOperationId !== operationId
    ) {
      throw new SafetyError(
        "MUTATION_CLAIM_NOT_ARMED",
        "The incident-scoped rollback mutation claim is not safely armed for this operation."
      )
    }

    record.state = "rollback_started"
    record.rollbackStartedAt = iso(dependencies)
    record.mutationAttempts = 1
    record.lastMutationStatus = null
    record.lastRetryAfterMs = null
    record.lastIssue = null
    await persistOperationBoundary(record, lease, config, dependencies)
    crossedBoundary = true

    claim.state = "sent"
    claim.activeOperationId = operationId
    claim.attempts += 1
    claim.sentAt = iso(dependencies)
    claim.definitelyRejectedAt = null
    claim.lastMutationStatus = null
    claim.lastRetryAfterMs = null
    try {
      await persistSentClaim(claim, lease, config, dependencies)
    } catch (error) {
      record.state = "reconciliation_only"
      record.lastIssue = "CLAIM_WRITE_FAILED"
      let failurePersisted = false
      try {
        await saveRecord(record, lease, config, dependencies)
        failurePersisted = true
      } catch {
        /* rollback_started remains the durable operation fence */
      }
      return boundaryFailureResult(record, error, failurePersisted)
    }

    try {
      const [storedOperation, storedClaim] = await Promise.all([
        dependencies.store.getRollbackOperation(operationId),
        dependencies.store.getRollbackMutationClaim(claimId),
      ])
      if (
        storedOperation?.state !== "rollback_started" ||
        storedOperation.mutationAttempts !== 1 ||
        storedClaim?.state !== "sent" ||
        storedClaim.activeOperationId !== operationId
      ) {
        throw new SafetyError(
          "MUTATION_FENCES_UNCONFIRMED",
          "Both durable rollback mutation fences could not be confirmed."
        )
      }
      await ensureLease(lease, config, dependencies)
    } catch (error) {
      return boundaryFailureResult(record, error)
    }

    try {
      record.requestDisposition = "outcome_unknown"
      await persistOperationBoundary(record, lease, config, dependencies)
    } catch (error) {
      record.requestDisposition = "not_sent"
      return boundaryFailureResult(record, error)
    }

    try {
      const response = await dependencies.vercel.requestRollback(
        input.teamId,
        input.projectId,
        input.rollbackDeploymentId
      )
      claim.lastMutationStatus = response.status
      claim.lastRetryAfterMs = null
      await saveClaim(claim, lease, config, dependencies)
      record.lastMutationStatus = response.status
      record.lastRetryAfterMs = null
      record.rollbackAcceptedAt = claim.updatedAt
      record.requestDisposition = "accepted"
      record.state = "reconciliation_only"
      await saveRecord(record, lease, config, dependencies)
    } catch (error) {
      if (error instanceof VercelHttpError) {
        record.lastMutationStatus = error.status
        record.lastRetryAfterMs =
          error.retryAfterMs === null
            ? null
            : Math.min(Math.max(error.retryAfterMs, 0), 300_000)
        record.lastIssue =
          error.status === null
            ? "ROLLBACK_TRANSPORT_UNKNOWN"
            : `ROLLBACK_HTTP_${error.status}`
        claim.lastMutationStatus = error.status
        claim.lastRetryAfterMs = record.lastRetryAfterMs
        if (
          !error.ambiguous &&
          error.status !== null &&
          [400, 401, 402, 403, 422, 429].includes(error.status)
        ) {
          claim.state = "definitely_rejected"
          claim.definitelyRejectedAt = iso(dependencies)
        }
      } else {
        record.lastIssue = "ROLLBACK_TRANSPORT_UNKNOWN"
      }
      record.state = "reconciliation_only"
      try {
        await saveClaim(claim, lease, config, dependencies)
        applyClaimHistory(record, claim)
        await saveRecord(record, lease, config, dependencies)
      } catch {
        /* the earlier sent claim remains the cross-approval no-repost fence */
      }
    }
    return await reconcile(record, authority, lease, config, dependencies, true)
  } catch (error) {
    if (crossedBoundary && record) {
      try {
        if (record.state === "rollback_started") {
          record.state = "reconciliation_only"
          record.lastIssue ??=
            error instanceof SafetyError
              ? error.code
              : "ROLLBACK_OUTCOME_UNKNOWN"
          await saveRecord(record, lease, config, dependencies)
        }
      } catch {
        /* preserve the earlier rollback_started fence */
      }
      return boundaryFailureResult(record, error)
    }
    return blockedResult(input, dependencies, error)
  } finally {
    if (acquired) {
      try {
        await dependencies.store.releaseLease(lease.key, lease.token)
      } catch {
        /* token-owned expiry is safe */
      }
    }
  }
}
