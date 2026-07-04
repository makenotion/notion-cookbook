import { isDeepStrictEqual } from "node:util"
import {
  operationIdentity,
  packetFingerprint,
  parsePacket,
  validateInput,
  validateMapping,
  validateReceiptProof,
} from "./canonical.js"
import { boundedText, type FetchLike } from "./http.js"
import type {
  DurableOperation,
  MutationState,
  OperationStore,
  ReceiptProof,
  RequestDisposition,
  SourceMapping,
} from "./types.js"
import { SafetyError } from "./types.js"

export const RELEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end'
export const RENEW_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end'
export const CAS_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then redis.call("set", KEYS[1], ARGV[2]); if ARGV[3] ~= "" then redis.call("expire", KEYS[1], ARGV[3]); end; return 1 else return 0 end'

interface RedisResponse {
  result?: unknown
  error?: unknown
}

interface RedisStoreOptions {
  baseUrl: string
  token: string
  timeoutMs: number
  fetchFn?: FetchLike
}

const OPERATION_STATES = new Set<MutationState>([
  "pending",
  "fenced",
  "rejected",
  "complete",
])
const DISPOSITIONS = new Set<RequestDisposition>([
  "not_sent",
  "outcome_unknown",
  "accepted",
  "definitely_rejected",
])

const OPERATION_KEYS = [
  "version",
  "operationId",
  "marker",
  "propertyKey",
  "mappingId",
  "mappingGeneration",
  "policy",
  "input",
  "packet",
  "createdAt",
  "updatedAt",
  "sourceGuardFingerprint",
  "jiraMode",
  "jiraState",
  "jiraDisposition",
  "jiraAttempts",
  "jiraIssueId",
  "jiraIssueKey",
  "issueCreated",
  "issueEnriched",
  "tagState",
  "routeState",
  "noteState",
  "intercomNotePartId",
  "receiptProofHash",
  "receiptWritten",
  "completedAt",
] as const

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  )
}

function iso(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.toISOString() === value
}

function validateOperation(
  value: unknown,
  expectedId: string
): DurableOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SafetyError(
      "COORDINATION_CORRUPT",
      "Durable operation is malformed.",
      "conflict"
    )
  }
  const operation = value as DurableOperation
  const raw = value as Record<string, unknown>
  let identity: ReturnType<typeof operationIdentity>
  try {
    validateInput(operation.input)
    const packet = parsePacket(operation.packet)
    if (!isDeepStrictEqual(packet, operation.packet))
      throw new Error("packet not canonical")
    identity = operationIdentity(operation.input)
  } catch {
    throw new SafetyError(
      "COORDINATION_CORRUPT",
      "Durable operation input failed validation.",
      "conflict"
    )
  }
  const policy = operation.policy as unknown
  const policyValid =
    !!policy &&
    typeof policy === "object" &&
    !Array.isArray(policy) &&
    exactKeys(policy as Record<string, unknown>, [
      "jiraProjectKey",
      "jiraIssueTypeId",
      "intercomTeamId",
      "intercomTagId",
    ])
  const idsPaired =
    (operation.jiraIssueId === null) === (operation.jiraIssueKey === null)
  const completeJira =
    operation.jiraState === "complete" &&
    operation.jiraDisposition === "accepted" &&
    operation.jiraMode !== null &&
    !!operation.jiraIssueId &&
    !!operation.jiraIssueKey &&
    operation.issueCreated !== operation.issueEnriched &&
    operation.issueCreated === (operation.jiraMode === "create") &&
    operation.issueEnriched === (operation.jiraMode === "enrich")
  const incompleteJira =
    operation.jiraState !== "complete" &&
    !operation.issueCreated &&
    !operation.issueEnriched &&
    ((operation.jiraState === "pending" &&
      operation.jiraDisposition === "not_sent" &&
      operation.jiraAttempts === 0) ||
      (operation.jiraState === "fenced" &&
        operation.jiraDisposition === "outcome_unknown" &&
        operation.jiraAttempts >= 1) ||
      (operation.jiraState === "rejected" &&
        operation.jiraDisposition === "definitely_rejected" &&
        operation.jiraAttempts >= 1))
  const allProviderComplete =
    operation.jiraState === "complete" &&
    operation.tagState === "complete" &&
    operation.routeState === "complete" &&
    operation.noteState === "complete"
  if (
    !exactKeys(raw, OPERATION_KEYS) ||
    operation.version !== 1 ||
    operation.operationId !== expectedId ||
    operation.operationId !== identity.operationId ||
    operation.marker !== identity.marker ||
    operation.propertyKey !== identity.propertyKey ||
    !/^icm_[0-9a-f]{32}$/.test(operation.mappingId) ||
    (operation.mappingGeneration !== null &&
      (!Number.isSafeInteger(operation.mappingGeneration) ||
        operation.mappingGeneration < 1 ||
        operation.mappingGeneration > 1_000_000)) ||
    !policyValid ||
    !operation.policy ||
    operation.policy.jiraProjectKey !== operation.packet.jiraProjectKey ||
    operation.policy.jiraIssueTypeId !== operation.packet.jiraIssueTypeId ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(operation.policy.intercomTeamId) ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(operation.policy.intercomTagId) ||
    operation.packet.sourceKind !== operation.input.sourceKind ||
    operation.packet.sourceId !== operation.input.sourceId ||
    packetFingerprint(operation.packet) !==
      operation.input.approvalFingerprint ||
    !iso(operation.createdAt) ||
    !iso(operation.updatedAt) ||
    Date.parse(operation.updatedAt) < Date.parse(operation.createdAt) ||
    (operation.sourceGuardFingerprint !== null &&
      !/^[0-9a-f]{64}$/.test(operation.sourceGuardFingerprint)) ||
    (operation.jiraMode !== null &&
      operation.jiraMode !== "create" &&
      operation.jiraMode !== "enrich") ||
    (operation.jiraMode !== null && operation.mappingGeneration === null) ||
    !OPERATION_STATES.has(operation.jiraState) ||
    !DISPOSITIONS.has(operation.jiraDisposition) ||
    !Number.isSafeInteger(operation.jiraAttempts) ||
    operation.jiraAttempts < 0 ||
    operation.jiraAttempts > 3 ||
    (operation.jiraMode === null &&
      (operation.jiraState !== "pending" ||
        operation.jiraDisposition !== "not_sent" ||
        operation.jiraAttempts !== 0 ||
        operation.jiraIssueId !== null ||
        operation.jiraIssueKey !== null)) ||
    (!completeJira && !incompleteJira) ||
    !idsPaired ||
    (operation.jiraIssueId !== null &&
      !/^[0-9]{1,30}$/.test(operation.jiraIssueId)) ||
    (operation.jiraIssueKey !== null &&
      !/^[A-Z][A-Z0-9_]{0,19}-[1-9][0-9]{0,11}$/.test(
        operation.jiraIssueKey
      )) ||
    (operation.jiraIssueKey !== null &&
      !operation.jiraIssueKey.startsWith(
        `${operation.packet.jiraProjectKey}-`
      )) ||
    typeof operation.issueCreated !== "boolean" ||
    typeof operation.issueEnriched !== "boolean" ||
    !OPERATION_STATES.has(operation.tagState) ||
    !OPERATION_STATES.has(operation.routeState) ||
    !OPERATION_STATES.has(operation.noteState) ||
    (operation.intercomNotePartId !== null &&
      !/^[A-Za-z0-9_-]{1,100}$/.test(operation.intercomNotePartId)) ||
    (operation.noteState === "complete") !==
      (operation.intercomNotePartId !== null) ||
    (operation.receiptProofHash !== null &&
      !/^[0-9a-f]{64}$/.test(operation.receiptProofHash)) ||
    typeof operation.receiptWritten !== "boolean" ||
    (operation.completedAt !== null && !iso(operation.completedAt)) ||
    (operation.completedAt !== null && !allProviderComplete) ||
    (operation.completedAt !== null &&
      Date.parse(operation.completedAt) > Date.parse(operation.updatedAt)) ||
    (operation.completedAt !== null &&
      Date.parse(operation.completedAt) < Date.parse(operation.createdAt)) ||
    (operation.receiptProofHash !== null && operation.completedAt === null) ||
    (operation.receiptWritten && operation.receiptProofHash === null)
  ) {
    throw new SafetyError(
      "COORDINATION_CORRUPT",
      "Durable operation failed validation.",
      "conflict"
    )
  }
  return operation
}

export class RedisOperationStore implements OperationStore {
  private readonly fetchFn: FetchLike

  constructor(private readonly options: RedisStoreOptions) {
    this.fetchFn = options.fetchFn ?? fetch
  }

  private operationKey(id: string): string {
    return `intercom-jira:v1:operation:${id}`
  }

  private mappingKey(id: string): string {
    return `intercom-jira:v1:mapping:${id}`
  }

  private receiptProofKey(id: string): string {
    return `intercom-jira:v1:receipt-proof:${id}`
  }

  private async command(parts: (string | number)[]): Promise<unknown> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs)
    let response: Response
    let text: string
    try {
      response = await this.fetchFn(this.options.baseUrl, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(parts),
      })
      text = await boundedText(response, 262_144, controller.signal)
    } catch {
      clearTimeout(timeout)
      throw new SafetyError(
        "COORDINATION_UNAVAILABLE",
        "The durable coordination store did not respond; provider mutation was not retried.",
        "blocked",
        true
      )
    }
    clearTimeout(timeout)
    if (!response.ok) {
      throw new SafetyError(
        "COORDINATION_UNAVAILABLE",
        `The durable coordination store returned HTTP ${response.status}.`,
        "blocked",
        true
      )
    }
    let payload: RedisResponse
    try {
      payload = JSON.parse(text) as RedisResponse
    } catch {
      throw new SafetyError(
        "COORDINATION_CORRUPT",
        "The coordination store returned malformed JSON.",
        "conflict"
      )
    }
    if (payload.error !== undefined && payload.error !== null) {
      throw new SafetyError(
        "COORDINATION_ERROR",
        "The coordination store rejected the command.",
        "blocked",
        true
      )
    }
    return payload.result
  }

  async createOperation(
    record: DurableOperation,
    ttlSeconds: number
  ): Promise<boolean> {
    validateOperation(record, record.operationId)
    const result = await this.command([
      "SET",
      this.operationKey(record.operationId),
      JSON.stringify(record),
      "NX",
      "EX",
      ttlSeconds,
    ])
    return result === "OK"
  }

  async getOperation(operationId: string): Promise<DurableOperation | null> {
    const result = await this.command(["GET", this.operationKey(operationId)])
    if (result === null) return null
    if (typeof result !== "string" || result.length > 64_000) {
      throw new SafetyError(
        "COORDINATION_CORRUPT",
        "Durable operation value is invalid.",
        "conflict"
      )
    }
    let value: unknown
    try {
      value = JSON.parse(result)
    } catch {
      throw new SafetyError(
        "COORDINATION_CORRUPT",
        "Durable operation JSON is invalid.",
        "conflict"
      )
    }
    return validateOperation(value, operationId)
  }

  async saveOperation(
    previous: DurableOperation,
    next: DurableOperation,
    ttlSeconds: number
  ): Promise<boolean> {
    validateOperation(next, previous.operationId)
    const result = await this.command([
      "EVAL",
      CAS_SCRIPT,
      "1",
      this.operationKey(previous.operationId),
      JSON.stringify(previous),
      JSON.stringify(next),
      ttlSeconds,
    ])
    return result === 1
  }

  async getMapping(mappingId: string): Promise<SourceMapping | null> {
    const result = await this.command(["GET", this.mappingKey(mappingId)])
    if (result === null) return null
    if (typeof result !== "string" || result.length > 16_000) {
      throw new SafetyError(
        "COORDINATION_CORRUPT",
        "Source mapping value is invalid.",
        "conflict"
      )
    }
    let value: unknown
    try {
      value = JSON.parse(result)
    } catch {
      throw new SafetyError(
        "COORDINATION_CORRUPT",
        "Source mapping JSON is invalid.",
        "conflict"
      )
    }
    return validateMapping(value, mappingId)
  }

  async createMapping(mapping: SourceMapping): Promise<boolean> {
    validateMapping(mapping, mapping.mappingId)
    return (
      (await this.command([
        "SET",
        this.mappingKey(mapping.mappingId),
        JSON.stringify(mapping),
        "NX",
      ])) === "OK"
    )
  }

  async saveMapping(
    previous: SourceMapping,
    next: SourceMapping
  ): Promise<boolean> {
    validateMapping(next, previous.mappingId)
    return (
      (await this.command([
        "EVAL",
        CAS_SCRIPT,
        "1",
        this.mappingKey(previous.mappingId),
        JSON.stringify(previous),
        JSON.stringify(next),
        "",
      ])) === 1
    )
  }

  async getReceiptProof(operationId: string): Promise<ReceiptProof | null> {
    const result = await this.command([
      "GET",
      this.receiptProofKey(operationId),
    ])
    if (result === null) return null
    if (typeof result !== "string" || result.length > 16_000) {
      throw new SafetyError(
        "COORDINATION_CORRUPT",
        "Permanent receipt proof value is invalid.",
        "conflict"
      )
    }
    let value: unknown
    try {
      value = JSON.parse(result)
    } catch {
      throw new SafetyError(
        "COORDINATION_CORRUPT",
        "Permanent receipt proof JSON is invalid.",
        "conflict"
      )
    }
    return validateReceiptProof(value, operationId)
  }

  async createReceiptProof(proof: ReceiptProof): Promise<boolean> {
    validateReceiptProof(proof, proof.operationId)
    return (
      (await this.command([
        "SET",
        this.receiptProofKey(proof.operationId),
        JSON.stringify(proof),
        "NX",
      ])) === "OK"
    )
  }

  async acquireLease(
    key: string,
    token: string,
    ttlMs: number
  ): Promise<boolean> {
    return (await this.command(["SET", key, token, "NX", "PX", ttlMs])) === "OK"
  }

  async renewLease(
    key: string,
    token: string,
    ttlMs: number
  ): Promise<boolean> {
    return (
      (await this.command(["EVAL", RENEW_SCRIPT, "1", key, token, ttlMs])) === 1
    )
  }

  async releaseLease(key: string, token: string): Promise<void> {
    try {
      await this.command(["EVAL", RELEASE_SCRIPT, "1", key, token])
    } catch {
      // TTL release is the fallback; never mask the operation result.
    }
  }
}
