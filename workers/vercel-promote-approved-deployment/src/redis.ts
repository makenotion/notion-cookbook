import { isDeepStrictEqual } from "node:util"
import {
  parsePromotionIncidentReceipt,
  rollbackMutationClaimIdentity,
} from "./approval.js"
import {
  DEPLOYMENT_HOSTNAME,
  DEPLOYMENT_ID,
  HOSTNAME,
  parseTargetPolicies,
  PROJECT_ID,
  TEAM_ID,
  validatePromoteInput,
  validateRollbackInput,
} from "./config.js"
import type {
  OperationRecord,
  PromoteInput,
  PromotionResult,
  ReceiptRecord,
  ReceiptStep,
  RedisOperationStoreLike,
  RollbackInput,
  RollbackMutationClaim,
  RollbackOperationRecord,
  RollbackResult,
  TargetPolicy,
} from "./types.js"
import { isDefinitePromotionRejectionStatus, SafetyError } from "./types.js"

export const RELEASE_LEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end'
export const RENEW_LEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end'

interface RedisResponse {
  result?: unknown
  error?: unknown
}

const OPERATION_ID = /^vpa_[0-9a-f]{32}$/
const ROLLBACK_OPERATION_ID = /^vrb_[0-9a-f]{32}$/
const ROLLBACK_CLAIM_ID = /^rmc_[0-9a-f]{32}$/
const INPUT_KEYS = new Set([
  "approvalPageId",
  "approvalRevision",
  "approvalFingerprint",
  "teamId",
  "projectId",
  "deploymentId",
  "expectedGitSha",
  "expectedGitBranch",
  "expectedCurrentDeploymentId",
])
const POLICY_KEYS = new Set([
  "teamId",
  "projectId",
  "productionDomains",
  "deploymentChecks",
  "healthPaths",
])
const CHECK_KEYS = new Set(["id", "name"])
const RECORD_KEYS = new Set([
  "version",
  "operationId",
  "state",
  "input",
  "policy",
  "createdAt",
  "updatedAt",
  "mutationStartedAt",
  "promotionAcceptedAt",
  "mutationAttempts",
  "lastMutationStatus",
  "lastIssue",
  "result",
])
const RESULT_KEYS = new Set([
  "ok",
  "operationId",
  "idempotencyKey",
  "status",
  "changed",
  "replay",
  "preconditionsVerified",
  "promotionRequested",
  "receiptWritten",
  "records",
  "steps",
  "warnings",
  "retryable",
  "retryAfterMs",
  "resumeToken",
  "repairInstruction",
  "teamId",
  "projectId",
  "deploymentId",
  "deploymentUrl",
  "previousDeploymentId",
  "currentDeploymentId",
  "gitSha",
  "gitBranch",
  "approvalPageId",
  "approvalRevision",
  "approvalFingerprint",
  "checkIds",
  "checkNames",
  "healthPaths",
  "productionDomains",
  "aliasState",
  "healthFailure",
  "rollbackRequested",
  "incidentReceiptHash",
  "freshApprovalInstruction",
  "rollbackTargetGitSha",
  "rollbackTargetGitBranch",
  "residualRaceWarning",
  "startedAt",
  "completedAt",
  "message",
])
const PROMOTION_RESULT_V2_FIELDS = new Set([
  "aliasState",
  "healthFailure",
  "rollbackRequested",
  "incidentReceiptHash",
  "freshApprovalInstruction",
  "rollbackTargetGitSha",
  "rollbackTargetGitBranch",
  "residualRaceWarning",
])
const LEGACY_RESULT_KEYS = new Set(
  [...RESULT_KEYS].filter((key) => !PROMOTION_RESULT_V2_FIELDS.has(key))
)
const RECEIPT_RECORD_KEYS = new Set([
  "kind",
  "system",
  "id",
  "url",
  "action",
  "state",
])
const STEP_KEYS = new Set(["name", "state"])
const STATES = new Set([
  "prepared",
  "mutation_started",
  "mutation_unknown",
  "receipt_pending",
  "complete",
])
const RESULT_STATUSES = new Set([
  "completed",
  "no_op",
  "blocked",
  "conflict",
  "partial_failure",
  "ambiguous",
  "rollback_recommended",
])
const STEP_NAMES: ReceiptStep["name"][] = [
  "approval",
  "preflight",
  "promotion",
  "reconciliation",
  "receipt",
]

function corrupt(): never {
  throw new SafetyError(
    "COORDINATION_CORRUPT",
    "The durable operation record failed strict structural and semantic validation."
  )
}

function exactObject(
  value: unknown,
  keys: Set<string>
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) corrupt()
  const object = value as Record<string, unknown>
  const actual = Object.keys(object)
  if (actual.length !== keys.size || actual.some((key) => !keys.has(key))) {
    corrupt()
  }
  return object
}

function boundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function isoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.toISOString() === value
}

function nullableIso(value: unknown): value is string | null {
  return value === null || isoTimestamp(value)
}

function stringArray(
  value: unknown,
  minimum: number,
  maximum: number,
  itemMaximum: number
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= minimum &&
    value.length <= maximum &&
    value.every((item) => boundedString(item, itemMaximum))
  )
}

function validateStoredInput(value: unknown): PromoteInput {
  const input = exactObject(value, INPUT_KEYS) as unknown as PromoteInput
  try {
    validatePromoteInput(input)
  } catch {
    corrupt()
  }
  return input
}

function validateStoredPolicy(
  value: unknown,
  input: Pick<PromoteInput, "teamId" | "projectId">
): TargetPolicy {
  const object = exactObject(value, POLICY_KEYS)
  if (!Array.isArray(object.deploymentChecks)) corrupt()
  for (const check of object.deploymentChecks) exactObject(check, CHECK_KEYS)
  let policy: TargetPolicy
  try {
    policy = parseTargetPolicies(JSON.stringify([object]))[0]
  } catch {
    corrupt()
  }
  if (
    !isDeepStrictEqual(policy, object) ||
    policy.teamId !== input.teamId ||
    policy.projectId !== input.projectId
  ) {
    corrupt()
  }
  return policy
}

const ROLLBACK_INPUT_KEYS = new Set([
  "rollbackApprovalPageId",
  "rollbackApprovalRevision",
  "rollbackApprovalFingerprint",
  "originalPromotionOperationId",
  "promotionIncidentPageId",
  "originalIncidentReceiptHash",
  "teamId",
  "projectId",
  "candidateDeploymentId",
  "rollbackDeploymentId",
])
const ROLLBACK_RECORD_KEYS = new Set([
  "version",
  "kind",
  "operationId",
  "state",
  "input",
  "policy",
  "incident",
  "claimId",
  "promotionOperationId",
  "promotionIncidentHash",
  "createdAt",
  "updatedAt",
  "rollbackStartedAt",
  "rollbackAcceptedAt",
  "mutationAttempts",
  "requestDisposition",
  "lastMutationStatus",
  "lastRetryAfterMs",
  "lastIssue",
  "result",
])
const ROLLBACK_RESULT_KEYS = new Set([
  "ok",
  "operationId",
  "idempotencyKey",
  "status",
  "changed",
  "replay",
  "preconditionsVerified",
  "rollbackRequested",
  "receiptWritten",
  "causality",
  "disposition",
  "rollbackRequestAccepted",
  "requestDisposition",
  "resumeMode",
  "retryable",
  "retryAfterMs",
  "resumeToken",
  "repairInstruction",
  "originalPromotionOperationId",
  "originalIncidentReceiptHash",
  "teamId",
  "projectId",
  "candidateDeploymentId",
  "rollbackDeploymentId",
  "currentDeploymentId",
  "rollbackDeploymentUrl",
  "rollbackGitSha",
  "rollbackGitBranch",
  "promotionApprovalPageId",
  "promotionIncidentPageId",
  "rollbackApprovalPageId",
  "rollbackApprovalRevision",
  "rollbackApprovalFingerprint",
  "productionDomains",
  "aliasState",
  "healthPaths",
  "healthFailure",
  "receiptWrittenAt",
  "startedAt",
  "completedAt",
  "warnings",
  "residualRaceWarning",
  "steps",
  "message",
])
const ROLLBACK_STATES = new Set([
  "prepared",
  "rollback_started",
  "reconciliation_only",
  "receipt_pending",
  "complete",
])
const ROLLBACK_STATUSES = new Set([
  "completed",
  "no_op",
  "blocked",
  "conflict",
  "partial_failure",
  "ambiguous",
])
const ROLLBACK_STEP_NAMES = [
  "incident",
  "approval",
  "preflight",
  "rollback",
  "reconciliation",
  "receipt",
] as const
const ROLLBACK_CLAIM_KEYS = new Set([
  "version",
  "kind",
  "claimId",
  "state",
  "promotionOperationId",
  "promotionIncidentHash",
  "teamId",
  "projectId",
  "candidateDeploymentId",
  "rollbackDeploymentId",
  "activeOperationId",
  "attempts",
  "createdAt",
  "updatedAt",
  "sentAt",
  "definitelyRejectedAt",
  "lastMutationStatus",
  "lastRetryAfterMs",
])
const ROLLBACK_CLAIM_STATES = new Set([
  "available",
  "operation_fenced",
  "sent",
  "definitely_rejected",
])

export function validateRollbackMutationClaim(
  value: unknown,
  expectedClaimId?: string
): RollbackMutationClaim {
  const claim = exactObject(value, ROLLBACK_CLAIM_KEYS)
  if (
    claim.version !== 1 ||
    claim.kind !== "rollback_mutation_claim" ||
    typeof claim.claimId !== "string" ||
    !ROLLBACK_CLAIM_ID.test(claim.claimId) ||
    (expectedClaimId !== undefined && claim.claimId !== expectedClaimId) ||
    !ROLLBACK_CLAIM_STATES.has(claim.state as string) ||
    typeof claim.promotionOperationId !== "string" ||
    !OPERATION_ID.test(claim.promotionOperationId) ||
    typeof claim.promotionIncidentHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(claim.promotionIncidentHash) ||
    typeof claim.teamId !== "string" ||
    !TEAM_ID.test(claim.teamId) ||
    typeof claim.projectId !== "string" ||
    !PROJECT_ID.test(claim.projectId) ||
    typeof claim.candidateDeploymentId !== "string" ||
    !DEPLOYMENT_ID.test(claim.candidateDeploymentId) ||
    typeof claim.rollbackDeploymentId !== "string" ||
    !DEPLOYMENT_ID.test(claim.rollbackDeploymentId) ||
    !(
      claim.activeOperationId === null ||
      (typeof claim.activeOperationId === "string" &&
        ROLLBACK_OPERATION_ID.test(claim.activeOperationId))
    ) ||
    !Number.isSafeInteger(claim.attempts) ||
    (claim.attempts as number) < 0 ||
    (claim.attempts as number) > 100 ||
    !isoTimestamp(claim.createdAt) ||
    !isoTimestamp(claim.updatedAt) ||
    Date.parse(claim.updatedAt as string) <
      Date.parse(claim.createdAt as string) ||
    !nullableIso(claim.sentAt) ||
    !nullableIso(claim.definitelyRejectedAt) ||
    !(
      claim.lastMutationStatus === null ||
      (Number.isInteger(claim.lastMutationStatus) &&
        (claim.lastMutationStatus as number) >= 100 &&
        (claim.lastMutationStatus as number) <= 599)
    ) ||
    !(
      claim.lastRetryAfterMs === null ||
      (Number.isSafeInteger(claim.lastRetryAfterMs) &&
        (claim.lastRetryAfterMs as number) >= 0 &&
        (claim.lastRetryAfterMs as number) <= 300_000)
    )
  )
    corrupt()

  const identity = rollbackMutationClaimIdentity({
    rollbackApprovalPageId: "00000000-0000-4000-8000-000000000001",
    rollbackApprovalRevision: "claim-validation",
    rollbackApprovalFingerprint: "0".repeat(64),
    originalPromotionOperationId: claim.promotionOperationId as string,
    promotionIncidentPageId: "00000000-0000-4000-8000-000000000002",
    originalIncidentReceiptHash: claim.promotionIncidentHash as string,
    teamId: claim.teamId as string,
    projectId: claim.projectId as string,
    candidateDeploymentId: claim.candidateDeploymentId as string,
    rollbackDeploymentId: claim.rollbackDeploymentId as string,
  })
  if (identity.claimId !== claim.claimId) corrupt()

  const attempts = claim.attempts as number
  const sentAtMs =
    claim.sentAt === null ? null : Date.parse(claim.sentAt as string)
  const rejectedAtMs =
    claim.definitelyRejectedAt === null
      ? null
      : Date.parse(claim.definitelyRejectedAt as string)
  const createdAtMs = Date.parse(claim.createdAt as string)
  const updatedAtMs = Date.parse(claim.updatedAt as string)
  if (
    (sentAtMs !== null && (sentAtMs < createdAtMs || sentAtMs > updatedAtMs)) ||
    (rejectedAtMs !== null &&
      (sentAtMs === null ||
        rejectedAtMs < sentAtMs ||
        rejectedAtMs > updatedAtMs)) ||
    (claim.state === "available" &&
      (claim.activeOperationId !== null ||
        attempts !== 0 ||
        claim.sentAt !== null ||
        claim.definitelyRejectedAt !== null ||
        claim.lastMutationStatus !== null ||
        claim.lastRetryAfterMs !== null)) ||
    (claim.state === "operation_fenced" &&
      (claim.activeOperationId === null ||
        claim.sentAt !== null ||
        claim.definitelyRejectedAt !== null ||
        claim.lastMutationStatus !== null ||
        claim.lastRetryAfterMs !== null)) ||
    (claim.state === "sent" &&
      (claim.activeOperationId === null ||
        attempts < 1 ||
        claim.sentAt === null ||
        claim.definitelyRejectedAt !== null ||
        [400, 401, 402, 403, 422, 429].includes(
          claim.lastMutationStatus as number
        ))) ||
    (claim.state === "definitely_rejected" &&
      (claim.activeOperationId === null ||
        attempts < 1 ||
        claim.sentAt === null ||
        claim.definitelyRejectedAt === null ||
        ![400, 401, 402, 403, 422, 429].includes(
          claim.lastMutationStatus as number
        )))
  )
    corrupt()
  return claim as unknown as RollbackMutationClaim
}

function validateStoredRollbackInput(value: unknown): RollbackInput {
  const input = exactObject(
    value,
    ROLLBACK_INPUT_KEYS
  ) as unknown as RollbackInput
  try {
    validateRollbackInput(input)
  } catch {
    corrupt()
  }
  return input
}

function validateRollbackResult(
  value: unknown,
  operationId: string,
  input: RollbackInput,
  policy: TargetPolicy,
  createdAt: string
): RollbackResult {
  const result = exactObject(value, ROLLBACK_RESULT_KEYS)
  if (
    typeof result.ok !== "boolean" ||
    result.operationId !== operationId ||
    result.idempotencyKey !== operationId ||
    !ROLLBACK_STATUSES.has(result.status as string) ||
    typeof result.changed !== "boolean" ||
    typeof result.replay !== "boolean" ||
    typeof result.preconditionsVerified !== "boolean" ||
    typeof result.rollbackRequested !== "boolean" ||
    typeof result.receiptWritten !== "boolean" ||
    typeof result.rollbackRequestAccepted !== "boolean" ||
    typeof result.retryable !== "boolean" ||
    !new Set(["accepted", "outcome_unknown", "not_sent"]).has(
      result.requestDisposition as string
    ) ||
    !(
      result.retryAfterMs === null ||
      (Number.isSafeInteger(result.retryAfterMs) &&
        (result.retryAfterMs as number) >= 0 &&
        (result.retryAfterMs as number) <= 300_000)
    ) ||
    !(result.resumeToken === null || result.resumeToken === operationId) ||
    !(
      result.repairInstruction === null ||
      boundedString(result.repairInstruction, 1_000)
    ) ||
    result.originalPromotionOperationId !==
      input.originalPromotionOperationId ||
    result.originalIncidentReceiptHash !== input.originalIncidentReceiptHash ||
    result.teamId !== input.teamId ||
    result.projectId !== input.projectId ||
    result.candidateDeploymentId !== input.candidateDeploymentId ||
    result.rollbackDeploymentId !== input.rollbackDeploymentId ||
    result.promotionIncidentPageId !== input.promotionIncidentPageId ||
    result.rollbackApprovalPageId !== input.rollbackApprovalPageId ||
    result.rollbackApprovalRevision !== input.rollbackApprovalRevision ||
    result.rollbackApprovalFingerprint !== input.rollbackApprovalFingerprint ||
    !(
      result.currentDeploymentId === null ||
      (typeof result.currentDeploymentId === "string" &&
        DEPLOYMENT_ID.test(result.currentDeploymentId))
    ) ||
    !(
      result.rollbackDeploymentUrl === null ||
      (typeof result.rollbackDeploymentUrl === "string" &&
        DEPLOYMENT_HOSTNAME.test(result.rollbackDeploymentUrl))
    ) ||
    !boundedString(result.rollbackGitSha, 64) ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(result.rollbackGitSha as string) ||
    !boundedString(result.rollbackGitBranch, 256) ||
    !boundedString(result.promotionApprovalPageId, 36) ||
    !stringArray(result.productionDomains, 1, 100, 253) ||
    !isDeepStrictEqual(result.healthPaths, policy.healthPaths) ||
    !nullableIso(result.receiptWrittenAt) ||
    result.startedAt !== createdAt ||
    !nullableIso(result.completedAt) ||
    !stringArray(result.warnings, 0, 6, 500) ||
    !boundedString(result.residualRaceWarning, 500) ||
    !boundedString(result.message, 1_000) ||
    !new Set(["provider_accepted", "observed_only", "none"]).has(
      result.causality as string
    ) ||
    !new Set([
      "rolled_back",
      "observed_restored",
      "candidate_unchanged",
      "split",
      "third_deployment",
      "unknown",
    ]).has(result.disposition as string) ||
    !new Set(["none", "reconcile_only", "receipt_only", "complete"]).has(
      result.resumeMode as string
    )
  )
    corrupt()
  if (
    !Array.isArray(result.aliasState) ||
    result.aliasState.length !== (result.productionDomains as string[]).length
  )
    corrupt()
  if (result.healthFailure !== null) {
    const health = exactObject(
      result.healthFailure,
      new Set(["path", "outcome", "status"])
    )
    if (
      !boundedString(health.path, 256) ||
      !new Set(["transport_error", "http_status"]).has(
        health.outcome as string
      ) ||
      !(
        health.status === null ||
        (Number.isInteger(health.status) &&
          (health.status as number) >= 100 &&
          (health.status as number) <= 599)
      )
    )
      corrupt()
  }
  result.aliasState.forEach((rawEntry, index) => {
    const entry = exactObject(rawEntry, new Set(["domain", "deploymentId"]))
    if (
      entry.domain !== (result.productionDomains as string[])[index] ||
      !(
        entry.deploymentId === null ||
        (typeof entry.deploymentId === "string" &&
          DEPLOYMENT_ID.test(entry.deploymentId))
      )
    )
      corrupt()
  })
  if (
    !Array.isArray(result.steps) ||
    result.steps.length !== ROLLBACK_STEP_NAMES.length
  )
    corrupt()
  result.steps.forEach((rawStep, index) => {
    const step = exactObject(rawStep, STEP_KEYS)
    if (
      step.name !== ROLLBACK_STEP_NAMES[index] ||
      !new Set(["completed", "skipped", "blocked", "failed", "pending"]).has(
        step.state as string
      )
    )
      corrupt()
  })
  const rollbackStep = (result.steps as Array<Record<string, unknown>>)[3]
  const expectedRollbackStep = !result.rollbackRequested
    ? "skipped"
    : result.rollbackRequestAccepted ||
        result.disposition === "rolled_back" ||
        result.disposition === "observed_restored"
      ? "completed"
      : result.status === "blocked"
        ? "failed"
        : "pending"
  if (rollbackStep?.state !== expectedRollbackStep) corrupt()
  const success = result.status === "completed" || result.status === "no_op"
  if (
    result.ok !== success ||
    result.replay !== (result.status === "no_op") ||
    result.retryable !== (result.resumeToken !== null) ||
    (success && result.repairInstruction !== null) ||
    (!success && result.repairInstruction === null) ||
    (result.causality === "provider_accepted") !==
      result.rollbackRequestAccepted ||
    (result.requestDisposition === "accepted") !==
      result.rollbackRequestAccepted ||
    (result.requestDisposition === "not_sent") !== !result.rollbackRequested ||
    (result.requestDisposition === "outcome_unknown") !==
      (result.rollbackRequested && !result.rollbackRequestAccepted) ||
    result.receiptWritten !== (result.receiptWrittenAt !== null)
  )
    corrupt()
  return result as unknown as RollbackResult
}

export function validateRollbackOperationRecord(
  value: unknown,
  expectedOperationId?: string
): RollbackOperationRecord {
  const record = exactObject(value, ROLLBACK_RECORD_KEYS)
  if (
    record.version !== 2 ||
    record.kind !== "rollback" ||
    typeof record.operationId !== "string" ||
    !ROLLBACK_OPERATION_ID.test(record.operationId) ||
    (expectedOperationId !== undefined &&
      record.operationId !== expectedOperationId) ||
    !ROLLBACK_STATES.has(record.state as string) ||
    !isoTimestamp(record.createdAt) ||
    !isoTimestamp(record.updatedAt) ||
    Date.parse(record.updatedAt as string) <
      Date.parse(record.createdAt as string) ||
    !nullableIso(record.rollbackStartedAt) ||
    !nullableIso(record.rollbackAcceptedAt) ||
    typeof record.claimId !== "string" ||
    !ROLLBACK_CLAIM_ID.test(record.claimId) ||
    (record.mutationAttempts !== 0 && record.mutationAttempts !== 1) ||
    !new Set(["accepted", "outcome_unknown", "not_sent"]).has(
      record.requestDisposition as string
    ) ||
    !(
      record.lastMutationStatus === null ||
      (Number.isInteger(record.lastMutationStatus) &&
        (record.lastMutationStatus as number) >= 100 &&
        (record.lastMutationStatus as number) <= 599)
    ) ||
    !(
      record.lastRetryAfterMs === null ||
      (Number.isSafeInteger(record.lastRetryAfterMs) &&
        (record.lastRetryAfterMs as number) >= 0 &&
        (record.lastRetryAfterMs as number) <= 300_000)
    ) ||
    !(
      record.lastIssue === null ||
      (boundedString(record.lastIssue, 100) &&
        /^[A-Z0-9_]+$/.test(record.lastIssue as string))
    )
  )
    corrupt()
  const input = validateStoredRollbackInput(record.input)
  const policy = validateStoredPolicy(record.policy, input)
  let incident
  try {
    incident = parsePromotionIncidentReceipt(
      JSON.stringify(record.incident),
      input.originalIncidentReceiptHash
    )
  } catch {
    corrupt()
  }
  const expectedClaimId = rollbackMutationClaimIdentity(input).claimId
  if (
    record.claimId !== expectedClaimId ||
    record.promotionOperationId !== input.originalPromotionOperationId ||
    record.promotionIncidentHash !== input.originalIncidentReceiptHash ||
    incident.operationId !== input.originalPromotionOperationId ||
    incident.teamId !== input.teamId ||
    incident.projectId !== input.projectId ||
    incident.candidateDeploymentId !== input.candidateDeploymentId ||
    incident.expectedPriorDeploymentId !== input.rollbackDeploymentId ||
    incident.promotionApprovalPageId !== input.promotionIncidentPageId ||
    !isDeepStrictEqual(incident.productionDomains, policy.productionDomains)
  )
    corrupt()
  const attempts = record.mutationAttempts as number
  if (
    (attempts === 0 &&
      (record.rollbackStartedAt !== null ||
        record.rollbackAcceptedAt !== null ||
        record.requestDisposition !== "not_sent" ||
        record.lastMutationStatus !== null ||
        record.lastRetryAfterMs !== null)) ||
    (attempts === 1 && record.rollbackStartedAt === null) ||
    (record.rollbackAcceptedAt !== null && record.lastMutationStatus !== 201) ||
    (record.requestDisposition === "accepted") !==
      (record.rollbackAcceptedAt !== null) ||
    (record.requestDisposition === "outcome_unknown" && attempts !== 1) ||
    (record.state === "rollback_started" && attempts !== 1) ||
    (record.state === "reconciliation_only" &&
      attempts === 0 &&
      (record.result === null ||
        (record.result as Record<string, unknown>).rollbackRequested !==
          false)) ||
    ((record.state === "receipt_pending" || record.state === "complete") &&
      attempts === 0 &&
      (record.result === null ||
        (record.result as Record<string, unknown>).rollbackRequested !== false))
  )
    corrupt()
  const result =
    record.result === null
      ? null
      : validateRollbackResult(
          record.result,
          record.operationId as string,
          input,
          policy,
          record.createdAt as string
        )
  const preparedResultIsSafe =
    result === null ||
    (!result.ok &&
      !result.rollbackRequested &&
      !result.receiptWritten &&
      !result.retryable &&
      result.resumeMode === "none" &&
      ((result.status === "conflict" &&
        result.disposition === "third_deployment") ||
        (result.status === "partial_failure" &&
          result.disposition === "split") ||
        (result.status === "blocked" &&
          record.lastIssue === "INCIDENT_MUTATION_ALREADY_SENT")))
  if (
    result !== null &&
    (result.rollbackGitSha !== incident.rollbackTargetGitSha ||
      result.rollbackGitBranch !== incident.rollbackTargetGitBranch ||
      result.promotionApprovalPageId !== incident.promotionApprovalPageId ||
      !isDeepStrictEqual(result.productionDomains, policy.productionDomains))
  ) {
    corrupt()
  }
  if (
    (record.state === "prepared" &&
      (attempts !== 0 || !preparedResultIsSafe)) ||
    (record.state === "rollback_started" && result !== null) ||
    (record.state === "receipt_pending" &&
      (result === null ||
        result.resumeMode !== "receipt_only" ||
        result.receiptWritten)) ||
    (record.state === "complete" &&
      (result === null ||
        result.status !== "completed" ||
        !result.ok ||
        !result.receiptWritten)) ||
    (result?.ok === true && record.state !== "complete") ||
    (result !== null &&
      (result.rollbackRequested !==
        (record.requestDisposition !== "not_sent") ||
        result.requestDisposition !== record.requestDisposition ||
        result.rollbackRequestAccepted !==
          (record.rollbackAcceptedAt !== null) ||
        result.retryAfterMs !== record.lastRetryAfterMs))
  )
    corrupt()
  record.result = result
  return record as unknown as RollbackOperationRecord
}

function validateReceiptRecord(value: unknown): ReceiptRecord {
  const record = exactObject(value, RECEIPT_RECORD_KEYS)
  if (
    !new Set(["approval", "project", "deployment", "production_domain"]).has(
      record.kind as string
    ) ||
    !new Set(["notion", "vercel"]).has(record.system as string) ||
    !boundedString(record.id, 253) ||
    !(
      record.url === null ||
      (typeof record.url === "string" &&
        record.url.length <= 1_000 &&
        /^https:\/\//.test(record.url))
    ) ||
    !new Set([
      "verified",
      "promoted",
      "observed",
      "routed",
      "receipt_written",
    ]).has(record.action as string) ||
    !boundedString(record.state, 120)
  ) {
    corrupt()
  }
  return record as unknown as ReceiptRecord
}

function validateStep(value: unknown, index: number): ReceiptStep {
  const step = exactObject(value, STEP_KEYS)
  if (
    step.name !== STEP_NAMES[index] ||
    !new Set(["completed", "skipped", "blocked", "failed", "pending"]).has(
      step.state as string
    )
  ) {
    corrupt()
  }
  return step as unknown as ReceiptStep
}

function validateStoredResult(
  value: unknown,
  operationId: string,
  input: PromoteInput,
  policy: TargetPolicy,
  createdAt: string
): PromotionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) corrupt()
  const raw = value as Record<string, unknown>
  const keys = Object.keys(raw)
  const isLegacy =
    keys.length === LEGACY_RESULT_KEYS.size &&
    keys.every((key) => LEGACY_RESULT_KEYS.has(key))
  const result: Record<string, unknown> = isLegacy
    ? {
        ...raw,
        aliasState: Array.isArray(raw.productionDomains)
          ? raw.productionDomains.map((domain) => ({
              domain,
              deploymentId: raw.currentDeploymentId ?? null,
            }))
          : [],
        healthFailure: null,
        rollbackRequested: false,
        incidentReceiptHash: null,
        freshApprovalInstruction: null,
        rollbackTargetGitSha: null,
        rollbackTargetGitBranch: null,
        residualRaceWarning:
          "Vercel exposes no provider compare-and-swap precondition; the project lease coordinates this Worker only, so external writers can still race.",
      }
    : exactObject(value, RESULT_KEYS)
  if (
    typeof result.ok !== "boolean" ||
    result.operationId !== operationId ||
    result.idempotencyKey !== operationId ||
    !RESULT_STATUSES.has(result.status as string) ||
    typeof result.changed !== "boolean" ||
    typeof result.replay !== "boolean" ||
    typeof result.preconditionsVerified !== "boolean" ||
    typeof result.promotionRequested !== "boolean" ||
    typeof result.receiptWritten !== "boolean" ||
    typeof result.retryable !== "boolean" ||
    !(
      result.retryAfterMs === null ||
      (Number.isSafeInteger(result.retryAfterMs) &&
        (result.retryAfterMs as number) >= 0 &&
        (result.retryAfterMs as number) <= 300_000)
    ) ||
    !(result.resumeToken === null || result.resumeToken === operationId) ||
    !(
      result.repairInstruction === null ||
      boundedString(result.repairInstruction, 1_000)
    ) ||
    result.teamId !== input.teamId ||
    result.projectId !== input.projectId ||
    result.deploymentId !== input.deploymentId ||
    result.previousDeploymentId !== input.expectedCurrentDeploymentId ||
    !(
      result.currentDeploymentId === null ||
      (typeof result.currentDeploymentId === "string" &&
        DEPLOYMENT_ID.test(result.currentDeploymentId))
    ) ||
    result.gitSha !== input.expectedGitSha ||
    result.gitBranch !== input.expectedGitBranch ||
    result.approvalPageId !== input.approvalPageId ||
    result.approvalRevision !== input.approvalRevision ||
    result.approvalFingerprint !== input.approvalFingerprint ||
    result.startedAt !== createdAt ||
    !nullableIso(result.completedAt) ||
    !boundedString(result.message, 1_000)
  ) {
    corrupt()
  }

  if (
    result.rollbackRequested !== false ||
    !boundedString(result.residualRaceWarning, 500) ||
    !Array.isArray(result.aliasState) ||
    !Array.isArray(result.productionDomains)
  ) {
    corrupt()
  }
  if (
    result.aliasState.length !== (result.productionDomains as string[]).length
  )
    corrupt()
  result.aliasState.forEach((rawEntry, index) => {
    const entry = exactObject(rawEntry, new Set(["domain", "deploymentId"]))
    if (
      entry.domain !== (result.productionDomains as string[])[index] ||
      !(
        entry.deploymentId === null ||
        (typeof entry.deploymentId === "string" &&
          DEPLOYMENT_ID.test(entry.deploymentId))
      )
    )
      corrupt()
  })

  if (result.status === "rollback_recommended") {
    const health = result.healthFailure as Record<string, unknown> | null
    if (
      !health ||
      !boundedString(health.path, 256) ||
      !new Set(["transport_error", "http_status"]).has(
        health.outcome as string
      ) ||
      !(
        health.status === null ||
        (Number.isInteger(health.status) &&
          (health.status as number) >= 100 &&
          (health.status as number) <= 599)
      ) ||
      !boundedString(result.incidentReceiptHash, 64) ||
      !/^[0-9a-f]{64}$/.test(result.incidentReceiptHash as string) ||
      !boundedString(result.freshApprovalInstruction, 1_000) ||
      !boundedString(result.rollbackTargetGitSha, 64) ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(
        result.rollbackTargetGitSha as string
      ) ||
      !boundedString(result.rollbackTargetGitBranch, 256) ||
      result.retryable !== false ||
      result.changed !== true ||
      result.currentDeploymentId !== input.deploymentId
    )
      corrupt()
  } else if (
    result.healthFailure !== null ||
    result.incidentReceiptHash !== null ||
    result.freshApprovalInstruction !== null ||
    result.rollbackTargetGitSha !== null ||
    result.rollbackTargetGitBranch !== null
  )
    corrupt()

  const success = result.status === "completed" || result.status === "no_op"
  if (
    result.ok !== success ||
    result.replay !== (result.status === "no_op") ||
    result.retryable !== (result.resumeToken !== null) ||
    (success && result.repairInstruction !== null) ||
    (!success && result.repairInstruction === null)
  ) {
    corrupt()
  }

  if (
    !(
      result.deploymentUrl === null ||
      (typeof result.deploymentUrl === "string" &&
        DEPLOYMENT_HOSTNAME.test(result.deploymentUrl))
    ) ||
    !isDeepStrictEqual(
      result.checkIds,
      policy.deploymentChecks.map((check) => check.id)
    ) ||
    !isDeepStrictEqual(
      result.checkNames,
      policy.deploymentChecks.map((check) => check.name ?? check.id)
    ) ||
    !isDeepStrictEqual(result.healthPaths, policy.healthPaths) ||
    !stringArray(result.productionDomains, 1, 120, 253) ||
    new Set(result.productionDomains).size !==
      result.productionDomains.length ||
    result.productionDomains.some(
      (domain) => domain !== domain.toLowerCase() || !HOSTNAME.test(domain)
    ) ||
    policy.productionDomains.some(
      (domain) => !(result.productionDomains as string[]).includes(domain)
    ) ||
    !stringArray(result.warnings, 0, 5, 500)
  ) {
    corrupt()
  }

  if (
    !Array.isArray(result.steps) ||
    result.steps.length !== STEP_NAMES.length
  ) {
    corrupt()
  }
  result.steps.forEach((step, index) => validateStep(step, index))
  if (
    !Array.isArray(result.records) ||
    result.records.length !== 3 + result.productionDomains.length
  ) {
    corrupt()
  }
  const records = result.records.map(validateReceiptRecord)
  if (
    records[0].kind !== "approval" ||
    records[0].system !== "notion" ||
    records[0].id !== input.approvalPageId ||
    records[1].kind !== "project" ||
    records[1].system !== "vercel" ||
    records[1].id !== input.projectId ||
    records[2].kind !== "deployment" ||
    records[2].system !== "vercel" ||
    records[2].id !== input.deploymentId ||
    records
      .slice(3)
      .some(
        (record, index) =>
          record.kind !== "production_domain" ||
          record.system !== "vercel" ||
          record.id !== (result.productionDomains as string[])[index]
      )
  ) {
    corrupt()
  }
  if (
    (result.receiptWritten && records[0].action !== "receipt_written") ||
    (!result.receiptWritten && records[0].action === "receipt_written")
  ) {
    corrupt()
  }

  if (
    result.status === "completed" &&
    (result.currentDeploymentId !== input.deploymentId ||
      result.completedAt === null ||
      result.receiptWritten !== true)
  ) {
    corrupt()
  }
  return result as unknown as PromotionResult
}

export function validateOperationRecord(
  value: unknown,
  expectedOperationId?: string
): OperationRecord {
  const record = exactObject(value, RECORD_KEYS)
  if (
    record.version !== 1 ||
    typeof record.operationId !== "string" ||
    !OPERATION_ID.test(record.operationId) ||
    (expectedOperationId !== undefined &&
      record.operationId !== expectedOperationId) ||
    !STATES.has(record.state as string) ||
    !isoTimestamp(record.createdAt) ||
    !isoTimestamp(record.updatedAt) ||
    Date.parse(record.updatedAt) < Date.parse(record.createdAt) ||
    !nullableIso(record.mutationStartedAt) ||
    !nullableIso(record.promotionAcceptedAt) ||
    !Number.isSafeInteger(record.mutationAttempts) ||
    (record.mutationAttempts as number) < 0 ||
    (record.mutationAttempts as number) > 100 ||
    !(
      record.lastMutationStatus === null ||
      (Number.isSafeInteger(record.lastMutationStatus) &&
        (record.lastMutationStatus as number) >= 100 &&
        (record.lastMutationStatus as number) <= 599)
    ) ||
    !(
      record.lastIssue === null ||
      (boundedString(record.lastIssue, 100) &&
        /^[A-Z0-9_]+$/.test(record.lastIssue))
    )
  ) {
    corrupt()
  }

  const input = validateStoredInput(record.input)
  const policy = validateStoredPolicy(record.policy, input)
  const attempts = record.mutationAttempts as number
  if (
    (attempts === 0 &&
      (record.mutationStartedAt !== null ||
        record.promotionAcceptedAt !== null ||
        record.lastMutationStatus !== null)) ||
    (attempts > 0 && record.mutationStartedAt === null) ||
    (record.promotionAcceptedAt !== null && attempts === 0) ||
    ((record.state === "mutation_started" ||
      record.state === "mutation_unknown") &&
      attempts === 0) ||
    (record.mutationStartedAt !== null &&
      (Date.parse(record.mutationStartedAt as string) <
        Date.parse(record.createdAt as string) ||
        Date.parse(record.mutationStartedAt as string) >
          Date.parse(record.updatedAt as string))) ||
    (record.promotionAcceptedAt !== null &&
      (record.mutationStartedAt === null ||
        Date.parse(record.promotionAcceptedAt as string) <
          Date.parse(record.mutationStartedAt as string) ||
        Date.parse(record.promotionAcceptedAt as string) >
          Date.parse(record.updatedAt as string) ||
        (record.lastMutationStatus !== 201 &&
          record.lastMutationStatus !== 202)))
  ) {
    corrupt()
  }

  const result =
    record.result === null
      ? null
      : validateStoredResult(
          record.result,
          record.operationId as string,
          input,
          policy,
          record.createdAt as string
        )
  if (
    (record.state === "prepared" &&
      !(
        (attempts === 0 &&
          record.mutationStartedAt === null &&
          record.promotionAcceptedAt === null &&
          record.lastMutationStatus === null &&
          record.lastIssue === null &&
          result === null) ||
        (attempts > 0 &&
          record.mutationStartedAt !== null &&
          record.promotionAcceptedAt === null &&
          typeof record.lastMutationStatus === "number" &&
          isDefinitePromotionRejectionStatus(record.lastMutationStatus) &&
          record.lastIssue === `PROMOTION_HTTP_${record.lastMutationStatus}` &&
          result?.status === "blocked" &&
          result.promotionRequested === true &&
          result.receiptWritten === false)
      )) ||
    result?.status === "no_op" ||
    (result?.status === "completed" && record.state !== "complete") ||
    (result?.status === "partial_failure" &&
      record.state !== "mutation_unknown" &&
      record.state !== "receipt_pending") ||
    ((result?.status === "ambiguous" || result?.status === "conflict") &&
      record.state !== "mutation_unknown") ||
    (record.state === "complete" &&
      (result?.status !== "completed" || result.receiptWritten !== true)) ||
    (record.state === "receipt_pending" &&
      (result?.status !== "partial_failure" ||
        result.receiptWritten !== false ||
        result.completedAt === null))
  ) {
    corrupt()
  }
  record.result = result
  return record as unknown as OperationRecord
}

export class RedisOperationStore implements RedisOperationStoreLike {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: {
    baseUrl: string
    token: string
    fetchImpl?: typeof fetch
    timeoutMs?: number
  }) {
    this.baseUrl = options.baseUrl
    this.token = options.token
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 5_000
  }

  private async command(parts: (string | number)[]): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(parts),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch {
      throw new SafetyError(
        "COORDINATION_UNAVAILABLE",
        "The Redis coordination service is unavailable."
      )
    }
    if (!response.ok) {
      throw new SafetyError(
        "COORDINATION_UNAVAILABLE",
        `The Redis coordination service returned HTTP ${response.status}.`
      )
    }
    let payload: RedisResponse
    try {
      payload = (await response.json()) as RedisResponse
    } catch {
      throw new SafetyError(
        "COORDINATION_UNAVAILABLE",
        "The Redis coordination service returned invalid JSON."
      )
    }
    if (payload.error !== undefined) {
      throw new SafetyError(
        "COORDINATION_UNAVAILABLE",
        "The Redis coordination command failed."
      )
    }
    return payload.result
  }

  async acquireLease(
    key: string,
    token: string,
    ttlMs: number
  ): Promise<boolean> {
    const result = await this.command(["SET", key, token, "NX", "PX", ttlMs])
    return result === "OK"
  }

  async renewLease(
    key: string,
    token: string,
    ttlMs: number
  ): Promise<boolean> {
    const result = await this.command([
      "EVAL",
      RENEW_LEASE_SCRIPT,
      1,
      key,
      token,
      ttlMs,
    ])
    return result === 1
  }

  async releaseLease(key: string, token: string): Promise<boolean> {
    const result = await this.command([
      "EVAL",
      RELEASE_LEASE_SCRIPT,
      1,
      key,
      token,
    ])
    return result === 1
  }

  async getOperation(operationId: string): Promise<OperationRecord | null> {
    const key = `vercel-promotion:operation:${operationId}`
    const result = await this.command(["GET", key])
    if (result === null) return null
    if (typeof result !== "string") {
      throw new SafetyError(
        "COORDINATION_CORRUPT",
        "The durable operation record has an invalid Redis type."
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(result)
    } catch {
      throw new SafetyError(
        "COORDINATION_CORRUPT",
        "The durable operation record is not valid JSON."
      )
    }
    return validateOperationRecord(parsed, operationId)
  }

  async putOperation(
    record: OperationRecord,
    ttlSeconds: number | null
  ): Promise<void> {
    validateOperationRecord(record, record.operationId)
    const key = `vercel-promotion:operation:${record.operationId}`
    const parts: (string | number)[] = ["SET", key, JSON.stringify(record)]
    if (ttlSeconds !== null) parts.push("PX", ttlSeconds * 1_000)
    const result = await this.command(parts)
    if (result !== "OK") {
      throw new SafetyError(
        "COORDINATION_UNAVAILABLE",
        "The durable operation record could not be saved."
      )
    }
  }

  async getRollbackOperation(
    operationId: string
  ): Promise<RollbackOperationRecord | null> {
    if (!ROLLBACK_OPERATION_ID.test(operationId)) {
      throw new SafetyError(
        "COORDINATION_CORRUPT",
        "The rollback operation ID is invalid."
      )
    }
    const key = `vercel-rollback:v2:operation:${operationId}`
    const result = await this.command(["GET", key])
    if (result === null) return null
    if (typeof result !== "string") {
      throw new SafetyError(
        "COORDINATION_CORRUPT",
        "The durable rollback record has an invalid Redis type."
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(result)
    } catch {
      throw new SafetyError(
        "COORDINATION_CORRUPT",
        "The durable rollback record is not valid JSON."
      )
    }
    return validateRollbackOperationRecord(parsed, operationId)
  }

  async putRollbackOperation(record: RollbackOperationRecord): Promise<void> {
    validateRollbackOperationRecord(record, record.operationId)
    const key = `vercel-rollback:v2:operation:${record.operationId}`
    const result = await this.command(["SET", key, JSON.stringify(record)])
    if (result !== "OK") {
      throw new SafetyError(
        "COORDINATION_UNAVAILABLE",
        "The durable rollback record could not be saved."
      )
    }
  }

  async getRollbackMutationClaim(
    claimId: string
  ): Promise<RollbackMutationClaim | null> {
    if (!ROLLBACK_CLAIM_ID.test(claimId)) {
      throw new SafetyError(
        "COORDINATION_CORRUPT",
        "The rollback mutation claim ID is invalid."
      )
    }
    const key = `vercel-rollback:v2:mutation-claim:${claimId}`
    const result = await this.command(["GET", key])
    if (result === null) return null
    if (typeof result !== "string") {
      throw new SafetyError(
        "COORDINATION_CORRUPT",
        "The rollback mutation claim has an invalid Redis type."
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(result)
    } catch {
      throw new SafetyError(
        "COORDINATION_CORRUPT",
        "The rollback mutation claim is not valid JSON."
      )
    }
    return validateRollbackMutationClaim(parsed, claimId)
  }

  async putRollbackMutationClaim(claim: RollbackMutationClaim): Promise<void> {
    validateRollbackMutationClaim(claim, claim.claimId)
    const key = `vercel-rollback:v2:mutation-claim:${claim.claimId}`
    const result = await this.command(["SET", key, JSON.stringify(claim)])
    if (result !== "OK") {
      throw new SafetyError(
        "COORDINATION_UNAVAILABLE",
        "The rollback mutation claim could not be saved."
      )
    }
  }
}
