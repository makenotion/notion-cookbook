import { isDeepStrictEqual } from "node:util"
import {
  DEPLOYMENT_HOSTNAME,
  DEPLOYMENT_ID,
  HOSTNAME,
  parseTargetPolicies,
  PROJECT_ID,
  TEAM_ID,
  validatePromoteInput,
} from "./config.js"
import type {
  OperationRecord,
  PromoteInput,
  PromotionResult,
  ReceiptRecord,
  ReceiptStep,
  RedisOperationStoreLike,
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
  "startedAt",
  "completedAt",
  "message",
])
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
  input: PromoteInput
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
  const result = exactObject(value, RESULT_KEYS)
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
        "The Redis coordination service is unavailable; no promotion was attempted."
      )
    }
    if (!response.ok) {
      throw new SafetyError(
        "COORDINATION_UNAVAILABLE",
        `The Redis coordination service returned HTTP ${response.status}; no promotion was attempted.`
      )
    }
    let payload: RedisResponse
    try {
      payload = (await response.json()) as RedisResponse
    } catch {
      throw new SafetyError(
        "COORDINATION_UNAVAILABLE",
        "The Redis coordination service returned invalid JSON; no promotion was attempted."
      )
    }
    if (payload.error !== undefined) {
      throw new SafetyError(
        "COORDINATION_UNAVAILABLE",
        "The Redis coordination command failed; no promotion was attempted."
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
}
