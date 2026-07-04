import { createHash } from "node:crypto"
import type {
  EscalationInput,
  EscalationPacket,
  ReceiptProof,
  SourceKind,
  SourceMapping,
  SourceSnapshot,
  StoredReceipt,
} from "./types.js"
import { SafetyError } from "./types.js"

const ID = /^[A-Za-z0-9_-]{1,100}$/
const PROJECT = /^[A-Z][A-Z0-9_]{0,19}$/
const ISSUE_TYPE = /^[0-9]{1,30}$/
const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,19}-[1-9][0-9]{0,11}$/
const FINGERPRINT = /^[0-9a-f]{64}$/
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OPERATION_ID = /^icj_[0-9a-f]{32}$/
const MAPPING_ID = /^icm_[0-9a-f]{32}$/

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value)
  return (
    actual.length === expected.length &&
    actual.every((key) => expected.includes(key))
  )
}

function exactIso(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

function plain(value: unknown, name: string, min: number, max: number): string {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new SafetyError(
      "INVALID_PACKET",
      `${name} is not bounded plain text.`
    )
  }
  return value
}

function nullablePlain(
  value: unknown,
  name: string,
  max: number
): string | null {
  if (value === null) return null
  return plain(value, name, 1, max)
}

export function validateInput(input: EscalationInput): void {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !exactKeys(input as unknown as Record<string, unknown>, [
      "approvalPageId",
      "approvalRevision",
      "approvalFingerprint",
      "sourceKind",
      "sourceId",
    ])
  ) {
    throw new SafetyError("INVALID_INPUT", "Input shape is invalid.")
  }
  if (!UUID.test(input.approvalPageId)) {
    throw new SafetyError("INVALID_INPUT", "approvalPageId must be a UUID.")
  }
  plain(input.approvalRevision, "approvalRevision", 1, 100)
  if (!FINGERPRINT.test(input.approvalFingerprint)) {
    throw new SafetyError(
      "INVALID_INPUT",
      "approvalFingerprint must be lowercase SHA-256."
    )
  }
  if (input.sourceKind !== "ticket" && input.sourceKind !== "conversation") {
    throw new SafetyError("INVALID_INPUT", "sourceKind is unsupported.")
  }
  if (!ID.test(input.sourceId)) {
    throw new SafetyError("INVALID_INPUT", "sourceId is invalid.")
  }
}

export function parsePacket(value: unknown): EscalationPacket {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SafetyError(
      "INVALID_PACKET",
      "Escalation packet must be an object."
    )
  }
  const packet = value as Record<string, unknown>
  const keys = [
    "version",
    "sourceKind",
    "sourceId",
    "expectedSourceUpdatedAt",
    "expectedSourceState",
    "expectedContactId",
    "expectedCompanyId",
    "expectedTeamAssigneeId",
    "jiraProjectKey",
    "jiraIssueTypeId",
    "destinationIssueKey",
    "severity",
    "summary",
    "impact",
    "environment",
    "reproductionSteps",
    "accountTier",
    "entitlement",
    "incidentKey",
    "includeSafeAttachmentMetadata",
  ]
  if (
    Object.keys(packet).length !== keys.length ||
    Object.keys(packet).some((key) => !keys.includes(key)) ||
    packet.version !== 1 ||
    (packet.sourceKind !== "ticket" && packet.sourceKind !== "conversation") ||
    typeof packet.expectedSourceUpdatedAt !== "number" ||
    !Number.isSafeInteger(packet.expectedSourceUpdatedAt) ||
    packet.expectedSourceUpdatedAt < 1 ||
    packet.expectedSourceUpdatedAt > 4_102_444_800 ||
    ![
      "open",
      "closed",
      "snoozed",
      "submitted",
      "in_progress",
      "waiting_on_customer",
      "resolved",
    ].includes(packet.expectedSourceState as string) ||
    !["sev1", "sev2", "sev3", "sev4"].includes(packet.severity as string) ||
    typeof packet.includeSafeAttachmentMetadata !== "boolean" ||
    !Array.isArray(packet.reproductionSteps) ||
    packet.reproductionSteps.length < 1 ||
    packet.reproductionSteps.length > 10
  ) {
    throw new SafetyError(
      "INVALID_PACKET",
      "Escalation packet shape is invalid."
    )
  }
  const sourceId = plain(packet.sourceId, "sourceId", 1, 100)
  const contactId = plain(packet.expectedContactId, "expectedContactId", 1, 100)
  if (!ID.test(sourceId) || !ID.test(contactId)) {
    throw new SafetyError("INVALID_PACKET", "Intercom identifiers are invalid.")
  }
  const companyId = nullablePlain(
    packet.expectedCompanyId,
    "expectedCompanyId",
    100
  )
  const expectedTeam = nullablePlain(
    packet.expectedTeamAssigneeId,
    "expectedTeamAssigneeId",
    100
  )
  if (
    (companyId && !ID.test(companyId)) ||
    (expectedTeam && !ID.test(expectedTeam))
  ) {
    throw new SafetyError(
      "INVALID_PACKET",
      "Intercom company or team identifier is invalid."
    )
  }
  const projectKey = plain(packet.jiraProjectKey, "jiraProjectKey", 1, 20)
  const issueTypeId = plain(packet.jiraIssueTypeId, "jiraIssueTypeId", 1, 30)
  const destination = nullablePlain(
    packet.destinationIssueKey,
    "destinationIssueKey",
    64
  )
  if (
    !PROJECT.test(projectKey) ||
    !ISSUE_TYPE.test(issueTypeId) ||
    (destination && !ISSUE_KEY.test(destination))
  ) {
    throw new SafetyError("INVALID_PACKET", "Jira target identity is invalid.")
  }
  const steps = packet.reproductionSteps.map((step, index) =>
    plain(step, `reproductionSteps[${index}]`, 1, 500)
  )
  return {
    version: 1,
    sourceKind: packet.sourceKind,
    sourceId,
    expectedSourceUpdatedAt: packet.expectedSourceUpdatedAt,
    expectedSourceState:
      packet.expectedSourceState as EscalationPacket["expectedSourceState"],
    expectedContactId: contactId,
    expectedCompanyId: companyId,
    expectedTeamAssigneeId: expectedTeam,
    jiraProjectKey: projectKey,
    jiraIssueTypeId: issueTypeId,
    destinationIssueKey: destination,
    severity: packet.severity as EscalationPacket["severity"],
    summary: plain(packet.summary, "summary", 1, 200),
    impact: plain(packet.impact, "impact", 1, 1_500),
    environment: plain(packet.environment, "environment", 1, 500),
    reproductionSteps: steps,
    accountTier: nullablePlain(packet.accountTier, "accountTier", 100),
    entitlement: nullablePlain(packet.entitlement, "entitlement", 200),
    incidentKey: nullablePlain(packet.incidentKey, "incidentKey", 100),
    includeSafeAttachmentMetadata: packet.includeSafeAttachmentMetadata,
  }
}

export function canonicalPacket(packet: EscalationPacket): string {
  return JSON.stringify({
    version: 1,
    sourceKind: packet.sourceKind,
    sourceId: packet.sourceId,
    expectedSourceUpdatedAt: packet.expectedSourceUpdatedAt,
    expectedSourceState: packet.expectedSourceState,
    expectedContactId: packet.expectedContactId,
    expectedCompanyId: packet.expectedCompanyId,
    expectedTeamAssigneeId: packet.expectedTeamAssigneeId,
    jiraProjectKey: packet.jiraProjectKey,
    jiraIssueTypeId: packet.jiraIssueTypeId,
    destinationIssueKey: packet.destinationIssueKey,
    severity: packet.severity,
    summary: packet.summary,
    impact: packet.impact,
    environment: packet.environment,
    reproductionSteps: packet.reproductionSteps,
    accountTier: packet.accountTier,
    entitlement: packet.entitlement,
    incidentKey: packet.incidentKey,
    includeSafeAttachmentMetadata: packet.includeSafeAttachmentMetadata,
  })
}

export function packetFingerprint(packet: EscalationPacket): string {
  return createHash("sha256").update(canonicalPacket(packet)).digest("hex")
}

export function operationIdentity(input: EscalationInput): {
  operationId: string
  marker: string
  propertyKey: string
} {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        approvalPageId: input.approvalPageId.toLowerCase(),
        approvalRevision: input.approvalRevision,
        approvalFingerprint: input.approvalFingerprint,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
      })
    )
    .digest("hex")
  return {
    operationId: `icj_${digest.slice(0, 32)}`,
    marker: `notion-int-${digest.slice(0, 24)}`,
    propertyKey: `notion.intercom.${digest.slice(0, 32)}`,
  }
}

export function mappingIdentity(
  workspaceId: string,
  kind: SourceKind,
  sourceId: string
): string {
  return `icm_${createHash("sha256").update(`${workspaceId}:${kind}:${sourceId}`).digest("hex").slice(0, 32)}`
}

export function leaseIdentity(
  workspaceId: string,
  kind: SourceKind,
  sourceId: string
): string {
  return `intercom-jira:v1:lease:${createHash("sha256").update(`${workspaceId}:${kind}:${sourceId}`).digest("hex")}`
}

function normalizedBody(body: string): string {
  return body.replace(/\s+/g, " ").slice(0, 8_000)
}

export function sourceGuardFingerprint(
  source: SourceSnapshot,
  operationMarker: string,
  escalationTagId: string
): string {
  const material = {
    kind: source.kind,
    id: source.id,
    state: source.state,
    title: normalizedBody(source.title),
    openingBody: normalizedBody(source.openingBody),
    contactIds: [...source.contactIds].sort(),
    companyId: source.companyId,
    slaStatus: source.slaStatus,
    tags: source.tags
      .filter((tag) => tag.id !== escalationTagId)
      .map((tag) => ({ id: tag.id, name: tag.name.slice(0, 100) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    parts: source.parts
      .filter((part) => !part.body.includes(`[${operationMarker}]`))
      .map((part) => ({
        id: part.id,
        type: part.type,
        body: normalizedBody(part.body),
        attachments: part.attachments.map((attachment) => ({
          name: attachment.name.slice(0, 200),
          contentType: attachment.contentType,
          size: attachment.size,
        })),
      })),
  }
  return createHash("sha256").update(JSON.stringify(material)).digest("hex")
}

export function canonicalReceipt(receipt: StoredReceipt): string {
  return JSON.stringify({
    version: 1,
    operationId: receipt.operationId,
    proofHash: receipt.proofHash,
    status: "escalated",
    approvalPageId: receipt.approvalPageId,
    approvalRevision: receipt.approvalRevision,
    approvalFingerprint: receipt.approvalFingerprint,
    mappingId: receipt.mappingId,
    mappingGeneration: receipt.mappingGeneration,
    intercomTeamId: receipt.intercomTeamId,
    intercomTagId: receipt.intercomTagId,
    sourceKind: receipt.sourceKind,
    sourceId: receipt.sourceId,
    jiraProjectKey: receipt.jiraProjectKey,
    jiraIssueTypeId: receipt.jiraIssueTypeId,
    jiraIssueId: receipt.jiraIssueId,
    jiraIssueKey: receipt.jiraIssueKey,
    jiraUrl: receipt.jiraUrl,
    issueCreated: receipt.issueCreated,
    issueEnriched: receipt.issueEnriched,
    tagged: true,
    routed: true,
    internalNotePartId: receipt.internalNotePartId,
    customerVisibleReplySent: false,
    completedAt: receipt.completedAt,
  })
}

function receiptProofMaterial(receipt: StoredReceipt): string {
  return JSON.stringify({
    version: 1,
    operationId: receipt.operationId,
    status: "escalated",
    approvalPageId: receipt.approvalPageId,
    approvalRevision: receipt.approvalRevision,
    approvalFingerprint: receipt.approvalFingerprint,
    mappingId: receipt.mappingId,
    mappingGeneration: receipt.mappingGeneration,
    intercomTeamId: receipt.intercomTeamId,
    intercomTagId: receipt.intercomTagId,
    sourceKind: receipt.sourceKind,
    sourceId: receipt.sourceId,
    jiraProjectKey: receipt.jiraProjectKey,
    jiraIssueTypeId: receipt.jiraIssueTypeId,
    jiraIssueId: receipt.jiraIssueId,
    jiraIssueKey: receipt.jiraIssueKey,
    jiraUrl: receipt.jiraUrl,
    issueCreated: receipt.issueCreated,
    issueEnriched: receipt.issueEnriched,
    tagged: true,
    routed: true,
    internalNotePartId: receipt.internalNotePartId,
    customerVisibleReplySent: false,
    completedAt: receipt.completedAt,
  })
}

export function receiptProofHash(receipt: StoredReceipt): string {
  return createHash("sha256")
    .update(receiptProofMaterial(receipt))
    .digest("hex")
}

const RECEIPT_KEYS = [
  "version",
  "operationId",
  "proofHash",
  "status",
  "approvalPageId",
  "approvalRevision",
  "approvalFingerprint",
  "mappingId",
  "mappingGeneration",
  "intercomTeamId",
  "intercomTagId",
  "sourceKind",
  "sourceId",
  "jiraProjectKey",
  "jiraIssueTypeId",
  "jiraIssueId",
  "jiraIssueKey",
  "jiraUrl",
  "issueCreated",
  "issueEnriched",
  "tagged",
  "routed",
  "internalNotePartId",
  "customerVisibleReplySent",
  "completedAt",
] as const

export function validateStoredReceipt(value: unknown): StoredReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SafetyError(
      "RECEIPT_INVALID",
      "Stored receipt is malformed.",
      "conflict"
    )
  }
  const receipt = value as unknown as StoredReceipt
  const raw = value as Record<string, unknown>
  let validUrl = false
  try {
    const url = new URL(receipt.jiraUrl)
    validUrl =
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      receipt.jiraUrl.length <= 2_048
  } catch {
    validUrl = false
  }
  if (
    !exactKeys(raw, RECEIPT_KEYS) ||
    receipt.version !== 1 ||
    !OPERATION_ID.test(receipt.operationId) ||
    !FINGERPRINT.test(receipt.proofHash) ||
    receipt.status !== "escalated" ||
    !UUID.test(receipt.approvalPageId) ||
    typeof receipt.approvalRevision !== "string" ||
    receipt.approvalRevision.length < 1 ||
    receipt.approvalRevision.length > 100 ||
    !FINGERPRINT.test(receipt.approvalFingerprint) ||
    !MAPPING_ID.test(receipt.mappingId) ||
    !Number.isSafeInteger(receipt.mappingGeneration) ||
    receipt.mappingGeneration < 1 ||
    receipt.mappingGeneration > 1_000_000 ||
    !ID.test(receipt.intercomTeamId) ||
    !ID.test(receipt.intercomTagId) ||
    (receipt.sourceKind !== "ticket" &&
      receipt.sourceKind !== "conversation") ||
    !ID.test(receipt.sourceId) ||
    !PROJECT.test(receipt.jiraProjectKey) ||
    !ISSUE_TYPE.test(receipt.jiraIssueTypeId) ||
    !/^[0-9]{1,30}$/.test(receipt.jiraIssueId) ||
    !ISSUE_KEY.test(receipt.jiraIssueKey) ||
    !receipt.jiraIssueKey.startsWith(`${receipt.jiraProjectKey}-`) ||
    !validUrl ||
    typeof receipt.issueCreated !== "boolean" ||
    typeof receipt.issueEnriched !== "boolean" ||
    receipt.issueCreated === receipt.issueEnriched ||
    receipt.tagged !== true ||
    receipt.routed !== true ||
    !ID.test(receipt.internalNotePartId) ||
    receipt.customerVisibleReplySent !== false ||
    !exactIso(receipt.completedAt) ||
    receiptProofHash(receipt) !== receipt.proofHash
  ) {
    throw new SafetyError(
      "RECEIPT_INVALID",
      "Stored receipt failed validation.",
      "conflict"
    )
  }
  return receipt
}

export function validateReceiptProof(
  value: unknown,
  expectedOperationId: string
): ReceiptProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SafetyError(
      "COORDINATION_CORRUPT",
      "Permanent receipt proof is malformed.",
      "conflict"
    )
  }
  const raw = value as Record<string, unknown>
  const proof = value as unknown as ReceiptProof
  let receipt: StoredReceipt
  try {
    receipt = validateStoredReceipt(proof.receipt)
  } catch {
    throw new SafetyError(
      "COORDINATION_CORRUPT",
      "Permanent receipt proof contains an invalid receipt.",
      "conflict"
    )
  }
  if (
    !exactKeys(raw, ["version", "operationId", "proofHash", "receipt"]) ||
    proof.version !== 1 ||
    proof.operationId !== expectedOperationId ||
    receipt.operationId !== expectedOperationId ||
    proof.proofHash !== receipt.proofHash
  ) {
    throw new SafetyError(
      "COORDINATION_CORRUPT",
      "Permanent receipt proof failed validation.",
      "conflict"
    )
  }
  return proof
}

export function parseMatchingReceipt(
  text: string | null,
  input: EscalationInput,
  operationId: string
): StoredReceipt | null {
  if (!text) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  let receipt: StoredReceipt
  try {
    receipt = validateStoredReceipt(value)
  } catch {
    return null
  }
  if (
    receipt.operationId !== operationId ||
    receipt.approvalPageId.toLowerCase() !==
      input.approvalPageId.toLowerCase() ||
    receipt.approvalRevision !== input.approvalRevision ||
    receipt.sourceKind !== input.sourceKind ||
    receipt.sourceId !== input.sourceId ||
    receipt.approvalFingerprint !== input.approvalFingerprint
  ) {
    return null
  }
  return canonicalReceipt(receipt) === text ? receipt : null
}

export function validateMapping(
  value: unknown,
  expectedId: string
): SourceMapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SafetyError(
      "COORDINATION_CORRUPT",
      "Source mapping is malformed.",
      "conflict"
    )
  }
  const mapping = value as SourceMapping
  const raw = value as unknown as Record<string, unknown>
  if (
    !exactKeys(raw, [
      "version",
      "mappingId",
      "workspaceId",
      "sourceKind",
      "sourceId",
      "generation",
      "state",
      "ownerOperationId",
      "intendedIssueKey",
      "jiraIssueId",
      "jiraIssueKey",
      "createdAt",
      "updatedAt",
    ]) ||
    mapping.version !== 1 ||
    mapping.mappingId !== expectedId ||
    mapping.mappingId !==
      mappingIdentity(
        mapping.workspaceId,
        mapping.sourceKind,
        mapping.sourceId
      ) ||
    !Number.isSafeInteger(mapping.generation) ||
    mapping.generation < 1 ||
    mapping.generation > 1_000_000 ||
    (mapping.state !== "claiming" && mapping.state !== "mapped") ||
    !/^icj_[0-9a-f]{32}$/.test(mapping.ownerOperationId) ||
    !ID.test(mapping.workspaceId) ||
    (mapping.sourceKind !== "ticket" &&
      mapping.sourceKind !== "conversation") ||
    !ID.test(mapping.sourceId) ||
    (mapping.intendedIssueKey !== null &&
      !ISSUE_KEY.test(mapping.intendedIssueKey)) ||
    (mapping.jiraIssueId !== null &&
      !/^[0-9]{1,30}$/.test(mapping.jiraIssueId)) ||
    (mapping.jiraIssueKey !== null && !ISSUE_KEY.test(mapping.jiraIssueKey)) ||
    !exactIso(mapping.createdAt) ||
    !exactIso(mapping.updatedAt) ||
    Date.parse(mapping.updatedAt) < Date.parse(mapping.createdAt) ||
    (mapping.state === "claiming" &&
      (mapping.jiraIssueId !== null || mapping.jiraIssueKey !== null)) ||
    (mapping.state === "mapped" &&
      (!mapping.jiraIssueId || !mapping.jiraIssueKey)) ||
    (mapping.state === "mapped" &&
      mapping.intendedIssueKey !== null &&
      mapping.intendedIssueKey !== mapping.jiraIssueKey)
  ) {
    throw new SafetyError(
      "COORDINATION_CORRUPT",
      "Source mapping failed validation.",
      "conflict"
    )
  }
  return mapping
}
