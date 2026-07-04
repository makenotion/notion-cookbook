import { isDeepStrictEqual } from "node:util"
import {
  canonicalReceipt,
  canonicalPacket,
  leaseIdentity,
  mappingIdentity,
  operationIdentity,
  parseMatchingReceipt,
  receiptProofHash,
  sourceGuardFingerprint,
  validateInput,
} from "./canonical.js"
import type { EscalationTarget, RuntimeConfig } from "./config.js"
import { targetFor } from "./config.js"
import { isDefiniteMutationRejection } from "./http.js"
import { retrieveApproval, verifyApproval, writeReceipt } from "./notion.js"
import type {
  CompanySnapshot,
  ContactSnapshot,
  DurableOperation,
  EscalationDependencies,
  EscalationInput,
  EscalationPacket,
  EscalationPolicy,
  EscalationResult,
  JiraIssue,
  ReceiptProof,
  ResultRecord,
  ResultStep,
  SourceAttachment,
  SourceMapping,
  SourceSnapshot,
  StoredReceipt,
} from "./types.js"
import { ProviderError, SafetyError } from "./types.js"

interface VerifiedContext {
  source: SourceSnapshot
  contact: ContactSnapshot
  company: CompanySnapshot | null
  safeAttachments: SourceAttachment[]
  warnings: string[]
}

interface InvocationEffects {
  issueCreated: boolean
  issueEnriched: boolean
  tagged: boolean
  routed: boolean
  noted: boolean
  receiptWritten: boolean
  touchedSteps: Set<ResultStep["name"]>
}

function newEffects(): InvocationEffects {
  return {
    issueCreated: false,
    issueEnriched: false,
    tagged: false,
    routed: false,
    noted: false,
    receiptWritten: false,
    touchedSteps: new Set(["approval"]),
  }
}

function iso(now: () => Date): string {
  return now().toISOString()
}

function newOperation(
  input: EscalationInput,
  packet: DurableOperation["packet"],
  now: string,
  mappingId: string,
  policy: EscalationPolicy | null
): DurableOperation {
  const identity = operationIdentity(input)
  return {
    version: 1,
    operationId: identity.operationId,
    marker: identity.marker,
    propertyKey: identity.propertyKey,
    mappingId,
    mappingGeneration: null,
    policy,
    input: { ...input },
    packet,
    createdAt: now,
    updatedAt: now,
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

function fallbackPacket(input: EscalationInput): EscalationPacket {
  return {
    version: 1,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    expectedSourceUpdatedAt: 1,
    expectedSourceState:
      input.sourceKind === "conversation" ? "open" : "submitted",
    expectedContactId: "unavailable",
    expectedCompanyId: null,
    expectedTeamAssigneeId: null,
    jiraProjectKey: "UNKNOWN",
    jiraIssueTypeId: "1",
    destinationIssueKey: null,
    severity: "sev4",
    summary: "Approval unavailable",
    impact: "Approval unavailable",
    environment: "Approval unavailable",
    reproductionSteps: ["Approval unavailable"],
    accountTier: null,
    entitlement: null,
    incidentKey: null,
    includeSafeAttachmentMetadata: false,
  }
}

function mappingRecord(
  mappingId: string,
  operation: DurableOperation,
  workspaceId: string,
  now: string
): SourceMapping {
  return {
    version: 1,
    mappingId,
    workspaceId,
    sourceKind: operation.input.sourceKind,
    sourceId: operation.input.sourceId,
    generation: 1,
    state: "claiming",
    ownerOperationId: operation.operationId,
    intendedIssueKey: operation.packet.destinationIssueKey,
    jiraIssueId: null,
    jiraIssueKey: null,
    createdAt: now,
    updatedAt: now,
  }
}

function safeAttachments(
  source: SourceSnapshot,
  include: boolean
): {
  attachments: SourceAttachment[]
  warnings: string[]
} {
  if (!include) return { attachments: [], warnings: [] }
  const allowed = new Set([
    "image/png",
    "image/jpeg",
    "application/pdf",
    "text/plain",
  ])
  const all = source.parts.flatMap((part) => part.attachments)
  const eligible = all.filter(
    (attachment) =>
      attachment.contentType !== null &&
      allowed.has(attachment.contentType.toLowerCase()) &&
      attachment.size !== null &&
      attachment.size <= 10_000_000
  )
  return {
    attachments: eligible.slice(0, 10),
    warnings:
      eligible.length > 10 || all.length !== eligible.length
        ? [
            "Some attachment metadata was omitted by the fixed type, size, or ten-item policy; files and URLs were never copied.",
          ]
        : [],
  }
}

function validateSource(
  operation: DurableOperation,
  target: EscalationTarget,
  source: SourceSnapshot,
  firstVerification: boolean
): void {
  const packet = operation.packet
  if (source.kind !== packet.sourceKind || source.id !== packet.sourceId) {
    throw new SafetyError(
      "SOURCE_ID_MISMATCH",
      "Intercom returned a different source.",
      "conflict"
    )
  }
  if (
    firstVerification &&
    source.updatedAt !== packet.expectedSourceUpdatedAt
  ) {
    throw new SafetyError(
      "SOURCE_REVISION_CHANGED",
      "The Intercom source changed after approval; refresh and reapprove the packet.",
      "conflict"
    )
  }
  if (source.state !== packet.expectedSourceState) {
    throw new SafetyError(
      "SOURCE_STATE_CHANGED",
      "The Intercom source state no longer matches the approved packet.",
      "conflict"
    )
  }
  if (!source.contactIds.includes(packet.expectedContactId)) {
    throw new SafetyError(
      "CONTACT_CHANGED",
      "The approved contact is no longer attached to the source.",
      "conflict"
    )
  }
  if (source.companyId && source.companyId !== packet.expectedCompanyId) {
    throw new SafetyError(
      "COMPANY_CHANGED",
      "The Intercom source company differs from approval.",
      "conflict"
    )
  }
  if (
    source.teamAssigneeId !== packet.expectedTeamAssigneeId &&
    source.teamAssigneeId !== target.intercomTeamId
  ) {
    throw new SafetyError(
      "ASSIGNMENT_CHANGED",
      "The Intercom assignment changed to a team outside the approved initial or configured route.",
      "conflict"
    )
  }
}

async function verifyContext(
  operation: DurableOperation,
  target: EscalationTarget,
  config: RuntimeConfig,
  deps: EscalationDependencies,
  firstVerification: boolean
): Promise<VerifiedContext> {
  const approval = await retrieveApproval(deps.notion, operation.input, config)
  verifyApproval(approval, operation.input, config)
  if (!isDeepStrictEqual(approval.packet, operation.packet)) {
    throw new SafetyError(
      "APPROVAL_PACKET_CHANGED",
      "The canonical approved packet changed.",
      "conflict"
    )
  }
  const source = await deps.intercom.getSource(
    operation.input.sourceKind,
    operation.input.sourceId
  )
  validateSource(operation, target, source, firstVerification)
  const guard = sourceGuardFingerprint(
    source,
    operation.marker,
    target.intercomTagId
  )
  if (
    operation.sourceGuardFingerprint &&
    guard !== operation.sourceGuardFingerprint
  ) {
    throw new SafetyError(
      "SOURCE_EVIDENCE_CHANGED",
      "Customer evidence changed after the operation began; no further mutation was attempted.",
      "conflict"
    )
  }
  const contact = await deps.intercom.getContact(
    operation.packet.expectedContactId
  )
  let company: CompanySnapshot | null = null
  if (operation.packet.expectedCompanyId) {
    let companyIds = contact.companyIds
    if (!companyIds.includes(operation.packet.expectedCompanyId)) {
      companyIds = await deps.intercom.listContactCompanyIds(contact.id)
    }
    if (!companyIds.includes(operation.packet.expectedCompanyId)) {
      throw new SafetyError(
        "COMPANY_ASSOCIATION_CHANGED",
        "The approved company is no longer associated with the contact.",
        "conflict"
      )
    }
    company = await deps.intercom.getCompany(operation.packet.expectedCompanyId)
  }
  const selected = safeAttachments(
    source,
    operation.packet.includeSafeAttachmentMetadata
  )
  return {
    source,
    contact,
    company,
    safeAttachments: selected.attachments,
    warnings: selected.warnings,
  }
}

function validateIssue(issue: JiraIssue, operation: DurableOperation): void {
  if (
    issue.projectKey !== operation.packet.jiraProjectKey ||
    issue.issueTypeId !== operation.packet.jiraIssueTypeId
  ) {
    throw new SafetyError(
      "JIRA_TARGET_CHANGED",
      "The mapped Jira issue is outside the approved project or issue type.",
      "conflict"
    )
  }
}

function hasNote(
  source: SourceSnapshot,
  marker: string
): SourceSnapshot["parts"][number] | null {
  return (
    source.parts.find(
      (part) => part.type === "note" && part.body.includes(`[${marker}]`)
    ) ?? null
  )
}

function unknownMutation(
  provider: "Intercom" | "Jira",
  action: string
): ProviderError {
  return new ProviderError(
    "MUTATION_OUTCOME_UNKNOWN",
    `${provider} ${action} crossed the write boundary without a fully validated response; marker reconciliation is required.`,
    null,
    { ambiguous: true }
  )
}

function receiptFromOperation(
  operation: DurableOperation,
  deps: EscalationDependencies
): StoredReceipt {
  if (
    operation.jiraState !== "complete" ||
    operation.tagState !== "complete" ||
    operation.routeState !== "complete" ||
    operation.noteState !== "complete" ||
    !operation.jiraIssueId ||
    !operation.jiraIssueKey ||
    !operation.intercomNotePartId ||
    !operation.mappingGeneration ||
    !operation.completedAt ||
    !operation.policy
  ) {
    throw new SafetyError(
      "RECEIPT_INCOMPLETE",
      "The durable receipt inputs are incomplete.",
      "partial_failure",
      true
    )
  }
  const receipt: StoredReceipt = {
    version: 1,
    operationId: operation.operationId,
    proofHash: "0".repeat(64),
    status: "escalated",
    approvalPageId: operation.input.approvalPageId,
    approvalRevision: operation.input.approvalRevision,
    approvalFingerprint: operation.input.approvalFingerprint,
    mappingId: operation.mappingId,
    mappingGeneration: operation.mappingGeneration,
    intercomTeamId: operation.policy.intercomTeamId,
    intercomTagId: operation.policy.intercomTagId,
    sourceKind: operation.input.sourceKind,
    sourceId: operation.input.sourceId,
    jiraProjectKey: operation.policy.jiraProjectKey,
    jiraIssueTypeId: operation.policy.jiraIssueTypeId,
    jiraIssueId: operation.jiraIssueId,
    jiraIssueKey: operation.jiraIssueKey,
    jiraUrl: deps.jira.issueUrl(operation.jiraIssueKey),
    issueCreated: operation.issueCreated,
    issueEnriched: operation.issueEnriched,
    tagged: true,
    routed: true,
    internalNotePartId: operation.intercomNotePartId,
    customerVisibleReplySent: false,
    completedAt: operation.completedAt,
  }
  receipt.proofHash = receiptProofHash(receipt)
  return receipt
}

async function verifyReceiptAuthority(
  receipt: StoredReceipt,
  operationId: string,
  mappingId: string,
  policy: EscalationPolicy,
  config: RuntimeConfig,
  deps: EscalationDependencies
): Promise<ReceiptProof> {
  const proof = await deps.store.getReceiptProof(operationId)
  if (
    !proof ||
    proof.proofHash !== receipt.proofHash ||
    canonicalReceipt(proof.receipt) !== canonicalReceipt(receipt) ||
    receipt.mappingId !== mappingId ||
    receipt.jiraProjectKey !== policy.jiraProjectKey ||
    receipt.jiraIssueTypeId !== policy.jiraIssueTypeId ||
    receipt.intercomTeamId !== policy.intercomTeamId ||
    receipt.intercomTagId !== policy.intercomTagId ||
    receipt.jiraUrl !== deps.jira.issueUrl(receipt.jiraIssueKey)
  ) {
    throw new SafetyError(
      "RECEIPT_PROOF_MISMATCH",
      "The editable Notion receipt lacks matching permanent coordination proof for the current target policy.",
      "conflict"
    )
  }
  const mapping = await deps.store.getMapping(mappingId)
  if (
    !mapping ||
    mapping.workspaceId !== config.intercomWorkspaceId ||
    mapping.sourceKind !== receipt.sourceKind ||
    mapping.sourceId !== receipt.sourceId ||
    mapping.state !== "mapped" ||
    mapping.generation !== receipt.mappingGeneration ||
    mapping.jiraIssueId !== receipt.jiraIssueId ||
    mapping.jiraIssueKey !== receipt.jiraIssueKey ||
    (receipt.issueCreated && mapping.ownerOperationId !== operationId)
  ) {
    throw new SafetyError(
      "RECEIPT_MAPPING_MISMATCH",
      "The permanent source mapping does not prove the receipt's exact Jira result.",
      "conflict"
    )
  }
  return proof
}

function adoptedOperation(
  input: EscalationInput,
  packet: EscalationPacket,
  policy: EscalationPolicy,
  receipt: StoredReceipt,
  receiptWritten: boolean
): DurableOperation {
  const adopted = newOperation(
    input,
    packet,
    receipt.completedAt,
    receipt.mappingId,
    policy
  )
  adopted.jiraMode = receipt.issueCreated ? "create" : "enrich"
  adopted.mappingGeneration = receipt.mappingGeneration
  adopted.jiraState = "complete"
  adopted.jiraDisposition = "accepted"
  adopted.jiraIssueId = receipt.jiraIssueId
  adopted.jiraIssueKey = receipt.jiraIssueKey
  adopted.issueCreated = receipt.issueCreated
  adopted.issueEnriched = receipt.issueEnriched
  adopted.tagState = "complete"
  adopted.routeState = "complete"
  adopted.noteState = "complete"
  adopted.intercomNotePartId = receipt.internalNotePartId
  adopted.receiptProofHash = receipt.proofHash
  adopted.receiptWritten = receiptWritten
  adopted.completedAt = receipt.completedAt
  return adopted
}

function recordsFor(
  operation: DurableOperation,
  deps: EscalationDependencies,
  replay: boolean,
  effects: InvocationEffects
): ResultRecord[] {
  const records: ResultRecord[] = [
    {
      system: "notion",
      kind: "approval",
      id: operation.input.approvalPageId,
      url: null,
      action:
        replay || !effects.touchedSteps.has("approval")
          ? "unchanged"
          : "verified",
    },
    {
      system: "intercom",
      kind: "source",
      id: operation.input.sourceId,
      url: null,
      action: effects.noted
        ? "noted"
        : effects.routed
          ? "routed"
          : effects.tagged
            ? "tagged"
            : effects.touchedSteps.has("source") && !replay
              ? "verified"
              : "unchanged",
    },
  ]
  if (operation.jiraIssueKey && operation.jiraIssueId) {
    records.push({
      system: "jira",
      kind: "issue",
      id: operation.jiraIssueId,
      url: deps.jira.issueUrl(operation.jiraIssueKey),
      action: effects.issueCreated
        ? "created"
        : effects.issueEnriched
          ? "enriched"
          : effects.touchedSteps.has("jira") && !replay
            ? "verified"
            : "unchanged",
    })
  }
  if (operation.receiptWritten) {
    records.push({
      system: "notion",
      kind: "receipt",
      id: operation.input.approvalPageId,
      url: null,
      action: effects.receiptWritten ? "receipt_written" : "unchanged",
    })
  }
  return records
}

function stepState(state: DurableOperation["jiraState"]): ResultStep["state"] {
  if (state === "complete") return "completed"
  if (state === "rejected") return "failed"
  if (state === "fenced") return "pending"
  return "pending"
}

function stepsFor(
  operation: DurableOperation,
  effects: InvocationEffects,
  errorStep?: ResultStep["name"]
): ResultStep[] {
  const states: Record<ResultStep["name"], ResultStep["state"]> = {
    approval: "completed",
    source: operation.sourceGuardFingerprint ? "completed" : "pending",
    mapping: operation.jiraMode ? "completed" : "pending",
    jira: stepState(operation.jiraState),
    intercom_tag: stepState(operation.tagState),
    intercom_route: stepState(operation.routeState),
    intercom_note: stepState(operation.noteState),
    receipt: operation.receiptWritten ? "completed" : "pending",
  }
  for (const name of Object.keys(states) as ResultStep["name"][]) {
    if (!effects.touchedSteps.has(name) && states[name] === "completed") {
      states[name] = "skipped"
    }
  }
  if (errorStep) states[errorStep] = "failed"
  return (Object.keys(states) as ResultStep["name"][]).map((name) => ({
    name,
    state: states[name],
  }))
}

function result(
  operation: DurableOperation,
  deps: EscalationDependencies,
  options: {
    status: EscalationResult["status"]
    message: string
    replay?: boolean
    changed?: boolean
    retryable?: boolean
    retryAfterMs?: number | null
    repairInstruction?: string | null
    warnings?: string[]
    safeAttachmentCount?: number
    errorStep?: ResultStep["name"]
    effects?: InvocationEffects
  }
): EscalationResult {
  const replay = options.replay ?? false
  const effects = options.effects ?? newEffects()
  const issueUrl = operation.jiraIssueKey
    ? deps.jira.issueUrl(operation.jiraIssueKey)
    : null
  const successful =
    options.status === "completed" || options.status === "no_op"
  return {
    ok: successful,
    status: options.status,
    operationId: operation.operationId,
    idempotencyKey: operation.operationId,
    changed:
      options.changed ??
      (!replay &&
        (effects.issueCreated ||
          effects.issueEnriched ||
          effects.tagged ||
          effects.routed ||
          effects.noted ||
          effects.receiptWritten)),
    replay,
    preconditionsVerified: operation.sourceGuardFingerprint !== null,
    issueCreated: replay ? false : effects.issueCreated,
    issueEnriched: replay ? false : effects.issueEnriched,
    receiptWritten: operation.receiptWritten,
    customerVisibleReplySent: false,
    approvalPageId: operation.input.approvalPageId,
    approvalRevision: operation.input.approvalRevision,
    approvalFingerprint: operation.input.approvalFingerprint,
    mappingId: operation.mappingId,
    intercomTeamId: operation.policy?.intercomTeamId ?? null,
    intercomTagId: operation.policy?.intercomTagId ?? null,
    sourceKind: operation.input.sourceKind,
    sourceId: operation.input.sourceId,
    jiraIssueId: operation.jiraIssueId,
    jiraIssueKey: operation.jiraIssueKey,
    jiraUrl: issueUrl,
    marker: operation.marker,
    safeAttachmentCount: options.safeAttachmentCount ?? 0,
    records: recordsFor(operation, deps, replay, effects),
    steps: stepsFor(operation, effects, options.errorStep),
    warnings: (options.warnings ?? []).slice(0, 10),
    retryable: options.retryable ?? false,
    retryAfterMs: options.retryAfterMs ?? null,
    resumeToken: options.retryable ? operation.operationId : null,
    repairInstruction: options.repairInstruction ?? null,
    startedAt: operation.createdAt,
    completedAt: operation.completedAt,
    message: options.message,
  }
}

function errorStep(operation: DurableOperation): ResultStep["name"] {
  if (!operation.sourceGuardFingerprint) return "source"
  if (!operation.jiraMode) return "mapping"
  if (operation.jiraState !== "complete") return "jira"
  if (operation.tagState !== "complete") return "intercom_tag"
  if (operation.routeState !== "complete") return "intercom_route"
  if (operation.noteState !== "complete") return "intercom_note"
  return "receipt"
}

export async function escalateCustomerIssue(
  input: EscalationInput,
  config: RuntimeConfig,
  deps: EscalationDependencies
): Promise<EscalationResult> {
  validateInput(input)
  const identity = operationIdentity(input)
  const durableMappingId = mappingIdentity(
    config.intercomWorkspaceId,
    input.sourceKind,
    input.sourceId
  )
  let initialApproval
  try {
    initialApproval = await retrieveApproval(deps.notion, input, config)
    verifyApproval(initialApproval, input, config)
  } catch (error) {
    const issue =
      error instanceof SafetyError
        ? error
        : new SafetyError(
            "APPROVAL_UNAVAILABLE",
            "The approval could not be verified.",
            "blocked",
            true
          )
    const provisional = newOperation(
      input,
      fallbackPacket(input),
      iso(deps.now),
      durableMappingId,
      null
    )
    return result(provisional, deps, {
      status: issue.status,
      message: issue.message,
      retryable: issue.retryable,
      retryAfterMs: issue.retryAfterMs,
      repairInstruction: issue.retryable
        ? "Retry the exact approval after Notion is available."
        : "Refresh or reapprove the canonical packet before retrying.",
      errorStep: "approval",
    })
  }
  let target: EscalationTarget
  try {
    target = targetFor(
      config,
      initialApproval.packet.jiraProjectKey,
      initialApproval.packet.jiraIssueTypeId
    )
  } catch (error) {
    const issue =
      error instanceof SafetyError
        ? error
        : new SafetyError(
            "TARGET_NOT_ALLOWED",
            "The provider target is not allowed."
          )
    const provisional = newOperation(
      input,
      initialApproval.packet,
      iso(deps.now),
      durableMappingId,
      null
    )
    return result(provisional, deps, {
      status: issue.status,
      message: issue.message,
      repairInstruction:
        "Choose a configured Jira project and issue type, then create a fresh approval.",
      errorStep: "mapping",
    })
  }

  const policy: EscalationPolicy = {
    jiraProjectKey: target.jiraProjectKey,
    jiraIssueTypeId: initialApproval.packet.jiraIssueTypeId,
    intercomTeamId: target.intercomTeamId,
    intercomTagId: target.intercomTagId,
  }
  const existingReceipt = parseMatchingReceipt(
    initialApproval.receiptText,
    input,
    identity.operationId
  )
  if (existingReceipt) {
    try {
      await verifyReceiptAuthority(
        existingReceipt,
        identity.operationId,
        durableMappingId,
        policy,
        config,
        deps
      )
    } catch (error) {
      const issue =
        error instanceof SafetyError
          ? error
          : new SafetyError(
              "RECEIPT_PROOF_UNAVAILABLE",
              "The permanent receipt proof could not be verified.",
              "conflict",
              true
            )
      return result(
        newOperation(
          input,
          initialApproval.packet,
          iso(deps.now),
          durableMappingId,
          policy
        ),
        deps,
        {
          status: issue.status,
          message: issue.message,
          retryable: issue.retryable,
          repairInstruction:
            "Restore or reconcile the permanent Redis proof and source mapping; do not trust or edit the Notion receipt into completion.",
          errorStep: "receipt",
        }
      )
    }
    const adopted = adoptedOperation(
      input,
      initialApproval.packet,
      policy,
      existingReceipt,
      true
    )
    return result(adopted, deps, {
      status: "no_op",
      message:
        "The exact approved escalation already completed; Redis proof and permanent mapping verified the Notion receipt.",
      replay: true,
      changed: false,
    })
  }
  if (initialApproval.receiptText) {
    const provisional = newOperation(
      input,
      initialApproval.packet,
      iso(deps.now),
      durableMappingId,
      policy
    )
    return result(provisional, deps, {
      status: "conflict",
      message:
        "The Notion receipt property contains different or malformed content.",
      repairInstruction:
        "Move the unrelated content to another property, then retry this exact approval.",
      errorStep: "receipt",
    })
  }

  let durableProofAbsent = false
  try {
    const durableProof = await deps.store.getReceiptProof(identity.operationId)
    if (durableProof) {
      const matching = parseMatchingReceipt(
        canonicalReceipt(durableProof.receipt),
        input,
        identity.operationId
      )
      if (!matching) {
        throw new SafetyError(
          "RECEIPT_PROOF_MISMATCH",
          "Permanent receipt proof belongs to different approval content.",
          "conflict"
        )
      }
      await verifyReceiptAuthority(
        matching,
        identity.operationId,
        durableMappingId,
        policy,
        config,
        deps
      )
      const effects = newEffects()
      effects.touchedSteps.add("receipt")
      const write = await writeReceipt(
        deps.notion,
        input,
        config,
        durableProof.receipt
      )
      effects.receiptWritten = write === "written"
      const adopted = adoptedOperation(
        input,
        initialApproval.packet,
        policy,
        durableProof.receipt,
        true
      )
      return result(adopted, deps, {
        status: write === "written" ? "completed" : "no_op",
        message:
          "Permanent Redis proof restored the exact Notion receipt without repeating provider work.",
        replay: write === "already_written",
        effects,
      })
    }
    durableProofAbsent = true
  } catch (error) {
    const issue =
      error instanceof SafetyError
        ? error
        : new SafetyError(
            "RECEIPT_PROOF_UNAVAILABLE",
            "Permanent receipt proof lookup failed.",
            "blocked",
            true
          )
    return result(
      newOperation(
        input,
        initialApproval.packet,
        iso(deps.now),
        durableMappingId,
        policy
      ),
      deps,
      {
        status: issue.status,
        message: issue.message,
        retryable: issue.retryable,
        repairInstruction: issue.retryable
          ? "Retry the exact approval after Redis is available."
          : null,
        errorStep: "receipt",
      }
    )
  }

  let operation = newOperation(
    input,
    initialApproval.packet,
    iso(deps.now),
    durableMappingId,
    policy
  )
  if (
    !(await deps.store.createOperation(operation, config.operationTtlSeconds))
  ) {
    const stored = await deps.store.getOperation(operation.operationId)
    if (!stored) {
      return result(operation, deps, {
        status: "conflict",
        message:
          "A concurrent operation changed durable state; retry the exact approval.",
        retryable: true,
        errorStep: "mapping",
      })
    }
    if (
      canonicalPacket(stored.packet) !==
        canonicalPacket(initialApproval.packet) ||
      !isDeepStrictEqual(stored.input, input) ||
      stored.mappingId !== durableMappingId ||
      !isDeepStrictEqual(stored.policy, policy)
    ) {
      return result(operation, deps, {
        status: "conflict",
        message:
          "The durable operation identity is occupied by different content.",
        errorStep: "mapping",
      })
    }
    operation = stored
  }
  if (operation.receiptProofHash && durableProofAbsent) {
    return result(operation, deps, {
      status: "conflict",
      message:
        "The operation references a permanent receipt proof that is missing from Redis.",
      repairInstruction:
        "Restore the exact permanent proof from backup or perform an operator reconciliation; do not recreate it from the editable Notion receipt.",
      errorStep: "receipt",
    })
  }

  const leaseKey = leaseIdentity(
    config.intercomWorkspaceId,
    input.sourceKind,
    input.sourceId
  )
  const leaseToken = deps.randomToken()
  if (
    !(await deps.store.acquireLease(leaseKey, leaseToken, config.leaseTtlMs))
  ) {
    return result(operation, deps, {
      status: "conflict",
      message:
        "Another escalation for this Intercom source currently holds the durable lease.",
      retryable: true,
      repairInstruction:
        "Retry the exact approval after the source lease expires.",
      errorStep: errorStep(operation),
    })
  }

  const effects = newEffects()
  let attachmentCount = 0
  let warnings: string[] = []
  const save = async (patch: Partial<DurableOperation>): Promise<void> => {
    if (
      !(await deps.store.renewLease(leaseKey, leaseToken, config.leaseTtlMs))
    ) {
      throw new SafetyError(
        "LEASE_LOST",
        "The source lease was lost before the next durable step; no new provider mutation was attempted.",
        operation.jiraState === "complete" ? "partial_failure" : "conflict",
        true
      )
    }
    const next: DurableOperation = {
      ...operation,
      ...patch,
      updatedAt: iso(deps.now),
    }
    if (
      !(await deps.store.saveOperation(
        operation,
        next,
        config.operationTtlSeconds
      ))
    ) {
      throw new SafetyError(
        "COORDINATION_CONFLICT",
        "Durable operation state changed concurrently.",
        operation.jiraState === "complete" ? "partial_failure" : "conflict",
        true
      )
    }
    operation = next
  }

  const gate = async (): Promise<VerifiedContext> => {
    effects.touchedSteps.add("source")
    const context = await verifyContext(
      operation,
      target,
      config,
      deps,
      operation.sourceGuardFingerprint === null
    )
    const guard = sourceGuardFingerprint(
      context.source,
      operation.marker,
      target.intercomTagId
    )
    if (!operation.sourceGuardFingerprint)
      await save({ sourceGuardFingerprint: guard })
    attachmentCount = context.safeAttachments.length
    warnings = [...new Set([...warnings, ...context.warnings])]
    return context
  }

  try {
    const intercomIdentity = await deps.intercom.getIdentity()
    if (
      intercomIdentity.adminId !== config.intercomAdminId ||
      intercomIdentity.workspaceId !== config.intercomWorkspaceId
    ) {
      throw new SafetyError(
        "INTERCOM_IDENTITY_MISMATCH",
        "The Intercom token identity is not the configured automation identity."
      )
    }
    const jiraIdentity = await deps.jira.getIdentity()
    if (jiraIdentity.accountId !== config.jiraActingAccountId) {
      throw new SafetyError(
        "JIRA_IDENTITY_MISMATCH",
        "The Jira token identity is not the configured automation account."
      )
    }
    let context = await gate()

    const mapId = operation.mappingId
    effects.touchedSteps.add("mapping")
    let mapping = await deps.store.getMapping(mapId)
    if (!mapping) {
      const proposed = mappingRecord(
        mapId,
        operation,
        config.intercomWorkspaceId,
        iso(deps.now)
      )
      if (!(await deps.store.createMapping(proposed))) {
        mapping = await deps.store.getMapping(mapId)
      } else {
        mapping = proposed
      }
    }
    if (!mapping)
      throw new SafetyError(
        "COORDINATION_CONFLICT",
        "The source mapping claim could not be read.",
        "conflict",
        true
      )
    if (
      mapping.workspaceId !== config.intercomWorkspaceId ||
      mapping.sourceKind !== input.sourceKind ||
      mapping.sourceId !== input.sourceId
    ) {
      throw new SafetyError(
        "COORDINATION_CORRUPT",
        "The source mapping identity is inconsistent.",
        "conflict"
      )
    }
    if (
      operation.mappingGeneration !== null &&
      operation.mappingGeneration !== mapping.generation
    ) {
      throw new SafetyError(
        operation.mappingGeneration < mapping.generation
          ? "MAPPING_CLAIM_SUPERSEDED"
          : "COORDINATION_CORRUPT",
        operation.mappingGeneration < mapping.generation
          ? "A newer approval generation owns this source claim; this older operation can never reclaim it."
          : "The operation references a claim generation newer than the permanent mapping.",
        "conflict"
      )
    }
    if (
      operation.packet.destinationIssueKey &&
      mapping.jiraIssueKey &&
      mapping.jiraIssueKey !== operation.packet.destinationIssueKey
    ) {
      throw new SafetyError(
        "MAPPING_CONFLICT",
        "This source is already mapped to a different Jira issue.",
        "conflict"
      )
    }
    if (
      operation.mappingGeneration === null &&
      (mapping.state === "mapped" ||
        mapping.ownerOperationId === operation.operationId)
    ) {
      await save({ mappingGeneration: mapping.generation })
    }
    if (
      mapping.state === "claiming" &&
      mapping.ownerOperationId !== operation.operationId
    ) {
      if (operation.mappingGeneration !== null) {
        throw new SafetyError(
          "MAPPING_CLAIM_OWNER_MISMATCH",
          "This operation already belongs to a different permanent claim owner.",
          "conflict"
        )
      }
      const prior = await deps.store.getOperation(mapping.ownerOperationId)
      const transferable =
        !!prior &&
        prior.mappingId === mapping.mappingId &&
        prior.mappingGeneration === mapping.generation &&
        ((prior.jiraState === "pending" &&
          prior.jiraDisposition === "not_sent") ||
          (prior.jiraState === "rejected" &&
            prior.jiraDisposition === "definitely_rejected"))
      if (!prior || !transferable) {
        throw new SafetyError(
          "MAPPING_IN_PROGRESS",
          "The prior creation claim has no durable definitely-rejected or not-sent proof; unknown outcomes can never transfer.",
          "conflict",
          false
        )
      }
      effects.touchedSteps.add("jira")
      const priorIssueMatches = await deps.jira.findIssueByMarker(
        prior.packet.jiraProjectKey,
        prior.marker
      )
      const priorDestination =
        prior.jiraIssueKey ?? prior.packet.destinationIssueKey
      const priorDestinationMarked = priorDestination
        ? (await deps.jira.hasOperationMarker(
            priorDestination,
            prior.propertyKey,
            prior.marker
          )) ||
          (await deps.jira.findCommentMarker(priorDestination, prior.marker))
        : false
      if (priorIssueMatches.length !== 0 || priorDestinationMarked) {
        throw new SafetyError(
          "MAPPING_TRANSFER_UNSAFE",
          "The prior operation marker is observable in Jira; its permanent claim was not transferred.",
          "conflict"
        )
      }
      if (mapping.generation >= 1_000_000) {
        throw new SafetyError(
          "MAPPING_GENERATION_LIMIT",
          "The permanent source claim reached its transfer generation limit.",
          "conflict"
        )
      }
      const transferred: SourceMapping = {
        ...mapping,
        generation: mapping.generation + 1,
        ownerOperationId: operation.operationId,
        intendedIssueKey: operation.packet.destinationIssueKey,
        updatedAt: iso(deps.now),
      }
      if (!(await deps.store.saveMapping(mapping, transferred))) {
        const reread = await deps.store.getMapping(mapId)
        if (
          !reread ||
          reread.state !== "claiming" ||
          reread.generation !== transferred.generation ||
          reread.ownerOperationId !== operation.operationId ||
          reread.intendedIssueKey !== operation.packet.destinationIssueKey
        ) {
          throw new SafetyError(
            "MAPPING_CONFLICT",
            "The permanent claim changed during its guarded transfer.",
            "conflict",
            true
          )
        }
        mapping = reread
      } else {
        mapping = transferred
      }
      await save({ mappingGeneration: mapping.generation })
    }

    const mapIssue = async (issue: JiraIssue): Promise<void> => {
      validateIssue(issue, operation)
      if (mapping?.state === "mapped") return
      const next: SourceMapping = {
        ...(mapping as SourceMapping),
        state: "mapped",
        jiraIssueId: issue.id,
        jiraIssueKey: issue.key,
        updatedAt: iso(deps.now),
      }
      if (!(await deps.store.saveMapping(mapping as SourceMapping, next))) {
        const reread = await deps.store.getMapping(mapId)
        if (
          !reread ||
          reread.state !== "mapped" ||
          reread.jiraIssueId !== issue.id ||
          reread.jiraIssueKey !== issue.key
        ) {
          throw new SafetyError(
            "MAPPING_CONFLICT",
            "The permanent source mapping changed concurrently.",
            "conflict"
          )
        }
        mapping = reread
      } else {
        mapping = next
      }
    }

    if (operation.jiraState !== "complete") {
      effects.touchedSteps.add("jira")
      const mappedIssueKey =
        mapping.state === "mapped"
          ? mapping.jiraIssueKey
          : operation.packet.destinationIssueKey

      if (mappedIssueKey) {
        if (operation.jiraMode !== "enrich") await save({ jiraMode: "enrich" })
        const issue = await deps.jira.getIssue(mappedIssueKey)
        validateIssue(issue, operation)
        await mapIssue(issue)
        const property = await deps.jira.hasOperationMarker(
          issue.key,
          operation.propertyKey,
          operation.marker
        )
        const comment = property
          ? true
          : await deps.jira.findCommentMarker(issue.key, operation.marker)
        if (comment) {
          if (!property)
            await deps.jira.putOperationMarker(
              issue.key,
              operation.propertyKey,
              operation.marker
            )
          await save({
            jiraState: "complete",
            jiraDisposition: "accepted",
            jiraIssueId: issue.id,
            jiraIssueKey: issue.key,
            issueEnriched: true,
          })
        } else {
          if (operation.jiraState === "fenced") {
            throw new SafetyError(
              "JIRA_COMMENT_OUTCOME_UNKNOWN",
              "The fenced Jira comment is not yet observable; it was not posted again.",
              "ambiguous",
              true,
              null,
              true
            )
          }
          if (operation.jiraAttempts >= 3) {
            throw new SafetyError(
              "MUTATION_ATTEMPT_LIMIT",
              "The Jira mutation reached the three-attempt rejection limit."
            )
          }
          context = await gate()
          await save({
            jiraState: "fenced",
            jiraDisposition: "outcome_unknown",
            jiraAttempts: operation.jiraAttempts + 1,
            jiraIssueId: issue.id,
            jiraIssueKey: issue.key,
          })
          let commentRecovered = false
          try {
            await deps.jira.addEnrichmentComment({
              issueKey: issue.key,
              packet: operation.packet,
              source: context.source,
              contact: context.contact,
              company: context.company,
              marker: operation.marker,
              safeAttachments: context.safeAttachments,
            })
          } catch (error) {
            if (isDefiniteMutationRejection(error)) {
              await save({
                jiraState: "rejected",
                jiraDisposition: "definitely_rejected",
              })
              throw error
            }
            const unknown =
              error instanceof ProviderError && error.ambiguous
                ? error
                : unknownMutation("Jira", "comment")
            commentRecovered = await deps.jira.findCommentMarker(
              issue.key,
              operation.marker
            )
            if (!commentRecovered) throw unknown
          }
          if (
            !commentRecovered &&
            !(await deps.jira.findCommentMarker(issue.key, operation.marker))
          ) {
            throw new SafetyError(
              "JIRA_COMMENT_OUTCOME_UNKNOWN",
              "Jira accepted no observable marker after the write boundary; do not post again.",
              "ambiguous",
              true,
              null,
              true
            )
          }
          await deps.jira.putOperationMarker(
            issue.key,
            operation.propertyKey,
            operation.marker
          )
          await save({
            jiraState: "complete",
            jiraDisposition: "accepted",
            jiraIssueId: issue.id,
            jiraIssueKey: issue.key,
            issueEnriched: true,
          })
          effects.issueEnriched = true
        }
      } else {
        if (operation.jiraMode !== "create") await save({ jiraMode: "create" })
        await deps.jira.verifyCreateTarget(
          operation.packet.jiraProjectKey,
          operation.packet.jiraIssueTypeId
        )
        const matches = await deps.jira.findIssueByMarker(
          operation.packet.jiraProjectKey,
          operation.marker
        )
        if (matches.length > 1) {
          throw new SafetyError(
            "DUPLICATE_JIRA_MARKER",
            "More than one Jira issue has the operation marker.",
            "conflict"
          )
        }
        if (matches.length === 1) {
          const issue = matches[0]
          validateIssue(issue, operation)
          if (
            !(await deps.jira.hasOperationMarker(
              issue.key,
              operation.propertyKey,
              operation.marker
            ))
          ) {
            throw new SafetyError(
              "JIRA_MARKER_MISMATCH",
              "The marker label found an issue without the exact operation property.",
              "conflict"
            )
          }
          await mapIssue(issue)
          await save({
            jiraState: "complete",
            jiraDisposition: "accepted",
            jiraIssueId: issue.id,
            jiraIssueKey: issue.key,
            issueCreated: true,
          })
        } else {
          if (operation.jiraState === "fenced") {
            throw new SafetyError(
              "JIRA_CREATE_OUTCOME_UNKNOWN",
              "The fenced Jira create is not observable by its exact marker; it was not submitted again.",
              "ambiguous",
              true,
              null,
              true
            )
          }
          if (operation.jiraAttempts >= 3) {
            throw new SafetyError(
              "MUTATION_ATTEMPT_LIMIT",
              "The Jira create reached the three-attempt rejection limit."
            )
          }
          context = await gate()
          await save({
            jiraState: "fenced",
            jiraDisposition: "outcome_unknown",
            jiraAttempts: operation.jiraAttempts + 1,
          })
          let created: { id: string; key: string } | null = null
          let recoveredIssue: JiraIssue | null = null
          try {
            created = await deps.jira.createIssue({
              packet: operation.packet,
              source: context.source,
              contact: context.contact,
              company: context.company,
              marker: operation.marker,
              propertyKey: operation.propertyKey,
              safeAttachments: context.safeAttachments,
            })
          } catch (error) {
            if (isDefiniteMutationRejection(error)) {
              await save({
                jiraState: "rejected",
                jiraDisposition: "definitely_rejected",
              })
              throw error
            }
            const unknown =
              error instanceof ProviderError && error.ambiguous
                ? error
                : unknownMutation("Jira", "create")
            const after = await deps.jira.findIssueByMarker(
              operation.packet.jiraProjectKey,
              operation.marker
            )
            if (after.length !== 1) throw unknown
            recoveredIssue = after[0]
          }
          const issue =
            recoveredIssue ??
            (created ? await deps.jira.getIssue(created.key) : null)
          if (!issue) {
            throw new SafetyError(
              "JIRA_CREATE_OUTCOME_UNKNOWN",
              "The Jira create result could not be reconciled.",
              "ambiguous",
              true,
              null,
              true
            )
          }
          if (created && issue.id !== created.id) {
            throw new SafetyError(
              "JIRA_CREATE_MISMATCH",
              "Jira create readback returned a different issue.",
              "ambiguous",
              true,
              null,
              true
            )
          }
          validateIssue(issue, operation)
          if (
            !(await deps.jira.hasOperationMarker(
              issue.key,
              operation.propertyKey,
              operation.marker
            ))
          ) {
            throw new SafetyError(
              "JIRA_CREATE_MISMATCH",
              "Jira did not retain the exact operation property.",
              "ambiguous",
              true,
              null,
              true
            )
          }
          await mapIssue(issue)
          await save({
            jiraState: "complete",
            jiraDisposition: "accepted",
            jiraIssueId: issue.id,
            jiraIssueKey: issue.key,
            issueCreated: true,
          })
          effects.issueCreated = true
        }
      }
    }

    if (!operation.jiraIssueKey || !operation.jiraIssueId) {
      throw new SafetyError(
        "JIRA_RESULT_MISSING",
        "The durable Jira result is incomplete.",
        "ambiguous",
        true
      )
    }
    const jiraUrl = deps.jira.issueUrl(operation.jiraIssueKey)

    if (operation.tagState !== "complete") {
      effects.touchedSteps.add("intercom_tag")
      context = await gate()
      if (context.source.tags.some((tag) => tag.id === target.intercomTagId)) {
        await save({ tagState: "complete" })
      } else {
        if (operation.tagState === "fenced") {
          throw new SafetyError(
            "INTERCOM_TAG_OUTCOME_UNKNOWN",
            "The fenced tag is not observable; it was not added again.",
            "ambiguous",
            true,
            null,
            true
          )
        }
        await save({ tagState: "fenced" })
        let recovered = false
        try {
          await deps.intercom.addTag(
            input.sourceKind,
            input.sourceId,
            target.intercomTagId
          )
        } catch (error) {
          if (isDefiniteMutationRejection(error)) {
            await save({ tagState: "rejected" })
            throw error
          }
          const unknown =
            error instanceof ProviderError && error.ambiguous
              ? error
              : unknownMutation("Intercom", "tag mutation")
          const after = await gate()
          recovered = after.source.tags.some(
            (tag) => tag.id === target.intercomTagId
          )
          if (!recovered) throw unknown
        }
        if (!recovered) {
          const after = await gate()
          recovered = after.source.tags.some(
            (tag) => tag.id === target.intercomTagId
          )
        }
        if (!recovered) {
          throw unknownMutation("Intercom", "tag mutation")
        }
        await save({ tagState: "complete" })
        effects.tagged = true
      }
    }

    if (operation.routeState !== "complete") {
      effects.touchedSteps.add("intercom_route")
      context = await gate()
      if (context.source.teamAssigneeId === target.intercomTeamId) {
        await save({ routeState: "complete" })
      } else {
        if (operation.routeState === "fenced") {
          throw new SafetyError(
            "INTERCOM_ROUTE_OUTCOME_UNKNOWN",
            "The fenced assignment is not observable; it was not sent again.",
            "ambiguous",
            true,
            null,
            true
          )
        }
        await save({ routeState: "fenced" })
        let recovered = false
        try {
          await deps.intercom.routeToTeam(
            input.sourceKind,
            input.sourceId,
            target.intercomTeamId
          )
        } catch (error) {
          if (isDefiniteMutationRejection(error)) {
            await save({ routeState: "rejected" })
            throw error
          }
          const unknown =
            error instanceof ProviderError && error.ambiguous
              ? error
              : unknownMutation("Intercom", "routing mutation")
          const after = await gate()
          recovered = after.source.teamAssigneeId === target.intercomTeamId
          if (!recovered) throw unknown
        }
        if (!recovered) {
          const after = await gate()
          recovered = after.source.teamAssigneeId === target.intercomTeamId
        }
        if (!recovered) {
          throw unknownMutation("Intercom", "routing mutation")
        }
        await save({ routeState: "complete" })
        effects.routed = true
      }
    }

    if (operation.noteState !== "complete") {
      effects.touchedSteps.add("intercom_note")
      context = await gate()
      const existing = hasNote(context.source, operation.marker)
      if (existing) {
        await save({ noteState: "complete", intercomNotePartId: existing.id })
      } else {
        if (operation.noteState === "fenced") {
          throw new SafetyError(
            "INTERCOM_NOTE_OUTCOME_UNKNOWN",
            "The fenced internal note is not observable; it was not posted again.",
            "ambiguous",
            true,
            null,
            true
          )
        }
        await save({ noteState: "fenced" })
        let recovered: SourceSnapshot["parts"][number] | null = null
        try {
          await deps.intercom.addInternalNote(
            input.sourceKind,
            input.sourceId,
            `[${operation.marker}]\nEngineering escalation: ${jiraUrl}\nInternal note only. No customer-visible reply was sent.`
          )
        } catch (error) {
          if (isDefiniteMutationRejection(error)) {
            await save({ noteState: "rejected" })
            throw error
          }
          const unknown =
            error instanceof ProviderError && error.ambiguous
              ? error
              : unknownMutation("Intercom", "internal note")
          const after = await gate()
          recovered = hasNote(after.source, operation.marker)
          if (!recovered) throw unknown
        }
        if (!recovered) {
          context = await gate()
          recovered = hasNote(context.source, operation.marker)
        }
        const created = recovered
        if (!created) {
          throw new SafetyError(
            "INTERCOM_NOTE_OUTCOME_UNKNOWN",
            "Intercom returned from the note request but the fixed marker is not observable; it was not posted again.",
            "ambiguous",
            true,
            null,
            true
          )
        }
        await save({ noteState: "complete", intercomNotePartId: created.id })
        effects.noted = true
      }
    }

    context = await gate()
    if (!context.source.tags.some((tag) => tag.id === target.intercomTagId)) {
      await save({
        tagState: "fenced",
        completedAt: null,
        receiptProofHash: null,
        receiptWritten: false,
      })
      throw new SafetyError(
        "INTERCOM_TAG_OUTCOME_UNKNOWN",
        "The configured escalation tag was absent at final receipt verification; it was not posted again.",
        "ambiguous",
        true,
        null,
        true
      )
    }
    if (context.source.teamAssigneeId !== target.intercomTeamId) {
      await save({
        routeState: "fenced",
        completedAt: null,
        receiptProofHash: null,
        receiptWritten: false,
      })
      throw new SafetyError(
        "INTERCOM_ROUTE_OUTCOME_UNKNOWN",
        "The configured engineering route was absent at final receipt verification; it was not sent again.",
        "ambiguous",
        true,
        null,
        true
      )
    }
    const finalNote = hasNote(context.source, operation.marker)
    if (!finalNote || finalNote.id !== operation.intercomNotePartId) {
      await save({
        noteState: "fenced",
        intercomNotePartId: null,
        completedAt: null,
        receiptProofHash: null,
        receiptWritten: false,
      })
      throw new SafetyError(
        "INTERCOM_NOTE_OUTCOME_UNKNOWN",
        "The exact internal note was absent at final receipt verification; it was not posted again.",
        "ambiguous",
        true,
        null,
        true
      )
    }
    if (!operation.completedAt) await save({ completedAt: iso(deps.now) })
    const receipt = receiptFromOperation(operation, deps)
    const finalMapping = await deps.store.getMapping(operation.mappingId)
    if (
      !finalMapping ||
      finalMapping.state !== "mapped" ||
      finalMapping.workspaceId !== config.intercomWorkspaceId ||
      finalMapping.sourceKind !== input.sourceKind ||
      finalMapping.sourceId !== input.sourceId ||
      finalMapping.generation !== receipt.mappingGeneration ||
      finalMapping.jiraIssueId !== receipt.jiraIssueId ||
      finalMapping.jiraIssueKey !== receipt.jiraIssueKey ||
      (receipt.issueCreated &&
        finalMapping.ownerOperationId !== operation.operationId)
    ) {
      throw new SafetyError(
        "RECEIPT_MAPPING_MISMATCH",
        "The permanent source mapping changed before receipt proof creation.",
        "conflict"
      )
    }
    const proof: ReceiptProof = {
      version: 1,
      operationId: operation.operationId,
      proofHash: receipt.proofHash,
      receipt,
    }
    if (!(await deps.store.createReceiptProof(proof))) {
      const existingProof = await deps.store.getReceiptProof(
        operation.operationId
      )
      if (!existingProof || !isDeepStrictEqual(existingProof, proof)) {
        throw new SafetyError(
          "RECEIPT_PROOF_CONFLICT",
          "A different permanent receipt proof occupies this operation identity.",
          "conflict"
        )
      }
    }
    await verifyReceiptAuthority(
      receipt,
      operation.operationId,
      operation.mappingId,
      policy,
      config,
      deps
    )
    if (operation.receiptProofHash !== receipt.proofHash) {
      if (operation.receiptProofHash) {
        throw new SafetyError(
          "RECEIPT_PROOF_CONFLICT",
          "The operation points at a different permanent receipt proof.",
          "conflict"
        )
      }
      await save({ receiptProofHash: receipt.proofHash })
    }
    effects.touchedSteps.add("receipt")
    const write = await writeReceipt(deps.notion, input, config, receipt)
    effects.receiptWritten = write === "written"
    if (!operation.receiptWritten) {
      try {
        await save({ receiptWritten: true })
      } catch {
        operation = { ...operation, receiptWritten: true }
        warnings = [
          ...new Set([
            ...warnings,
            "The exact Notion receipt and permanent proof were verified, but the expiring operation progress flag could not be updated.",
          ]),
        ]
      }
    }
    return result(operation, deps, {
      status: "completed",
      message: operation.issueCreated
        ? "Created one approved Jira issue, routed the Intercom source, added an internal link note, and wrote the receipt."
        : "Enriched the mapped Jira issue once, routed the Intercom source, added an internal link note, and wrote the receipt.",
      safeAttachmentCount: attachmentCount,
      warnings,
      effects,
    })
  } catch (error) {
    const issue =
      error instanceof SafetyError
        ? error
        : new SafetyError(
            "UNEXPECTED_FAILURE",
            "The bounded escalation failed without exposing provider data.",
            "blocked",
            true
          )
    const afterJira = operation.jiraState === "complete"
    const status = afterJira
      ? issue.status === "ambiguous"
        ? "partial_failure"
        : issue.status === "conflict"
          ? "partial_failure"
          : "partial_failure"
      : issue.status
    const permissionRepair =
      afterJira &&
      issue instanceof ProviderError &&
      (issue.httpStatus === 401 || issue.httpStatus === 403)
    const reconciliationOnly =
      operation.jiraState === "fenced" ||
      operation.tagState === "fenced" ||
      operation.routeState === "fenced" ||
      operation.noteState === "fenced"
    const retryable =
      issue.retryable ||
      issue.ambiguous ||
      permissionRepair ||
      reconciliationOnly
    const publicMessage =
      issue instanceof ProviderError
        ? issue.httpStatus === null
          ? "A provider mutation has an unknown outcome; reconciliation is required before any retry."
          : `A provider request returned HTTP ${issue.httpStatus}; response details were redacted.`
        : issue.message
    return result(operation, deps, {
      status,
      message: publicMessage,
      retryable,
      retryAfterMs: issue.retryAfterMs,
      repairInstruction: permissionRepair
        ? `Repair the Intercom credential's required ticket/conversation write permissions, then call this tool with the identical five inputs and resume token ${operation.operationId}; the completed Jira step will not be repeated.`
        : issue.ambiguous
          ? "Retry only this exact operation to reconcile provider markers; do not create or post manually unless reconciliation remains unresolved."
          : retryable
            ? "Retry this exact approved operation; completed steps will be re-read and skipped."
            : null,
      warnings,
      safeAttachmentCount: attachmentCount,
      errorStep: errorStep(operation),
      effects,
    })
  } finally {
    await deps.store.releaseLease(leaseKey, leaseToken)
  }
}
