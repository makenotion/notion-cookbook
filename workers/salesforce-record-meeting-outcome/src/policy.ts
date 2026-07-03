import { createHash } from "node:crypto"

import type { OpportunityRecord, RecordMeetingOutcomeInput } from "./types.js"

export const MAX_FOLLOW_UPS = 5
export const MAX_INPUT_BYTES = 32 * 1024
export const MAX_SUMMARY_LENGTH = 4_000
export const MAX_SUBJECT_LENGTH = 255
export const MAX_FOLLOW_UP_DESCRIPTION_LENGTH = 1_000

export type RuntimePolicy = {
  allowedTaskOwnerIds: Set<string>
  allowedStageTransitions: Map<string, Set<string>>
}

export class PolicyError extends Error {
  constructor(
    message: string,
    readonly kind: "blocked" | "conflict" = "blocked"
  ) {
    super(message)
    this.name = "PolicyError"
  }
}

export function isSalesforceId(value: string, prefix?: string): boolean {
  return (
    /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(value) &&
    (prefix === undefined || value.startsWith(prefix))
  )
}

function assertPlainText(name: string, value: string, maximum: number): void {
  if (
    value.trim().length < 1 ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new PolicyError(
      `${name} must be plain text of at most ${maximum} characters.`
    )
  }
}

function parseDateOnly(name: string, value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new PolicyError(`${name} must use YYYY-MM-DD.`)
  }
  const date = new Date(`${value}T00:00:00.000Z`)
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new PolicyError(`${name} is not a valid calendar date.`)
  }
  return date
}

function startOfUtcDay(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())
  )
}

function daysBetween(left: Date, right: Date): number {
  return Math.floor((right.getTime() - left.getTime()) / 86_400_000)
}

export function normalizeNotionPageId(value: string): string {
  if (
    !/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8a-fA-F0-9][a-fA-F0-9]{3}-[89abABa-fA-F0-9][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$/.test(
      value
    )
  ) {
    throw new PolicyError("notionPageId must be a UUID, not a URL.")
  }
  return value.replace(/-/g, "").toLowerCase()
}

export function normalizeTimestamp(name: string, value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new PolicyError(`${name} must be an ISO 8601 date-time.`)
  }
  return parsed.toISOString()
}

/** Validate every bounded field that contributes to the stable operation key or
 * canonical fingerprint. This intentionally excludes policy that can change
 * after a provider commit, such as relative date windows and owner allowlists. */
export function validateCanonicalInput(input: RecordMeetingOutcomeInput): void {
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_INPUT_BYTES) {
    throw new PolicyError(`Tool input exceeds ${MAX_INPUT_BYTES} bytes.`)
  }

  normalizeNotionPageId(input.notionPageId)
  assertPlainText("approvedRevision", input.approvedRevision, 100)
  if (!/^[a-f0-9]{64}$/.test(input.approvalFingerprint)) {
    throw new PolicyError(
      "approvalFingerprint must be the lowercase SHA-256 fingerprint of the approved packet."
    )
  }
  if (!isSalesforceId(input.opportunityId, "006")) {
    throw new PolicyError("opportunityId must be a Salesforce Opportunity ID.")
  }
  normalizeTimestamp(
    "expectedOpportunityLastModifiedAt",
    input.expectedOpportunityLastModifiedAt
  )

  assertPlainText("meetingSubject", input.meetingSubject, MAX_SUBJECT_LENGTH)
  assertPlainText("outcomeSummary", input.outcomeSummary, MAX_SUMMARY_LENGTH)
  parseDateOnly("occurredOn", input.occurredOn)

  if (
    input.primaryContactId !== null &&
    !isSalesforceId(input.primaryContactId, "003")
  ) {
    throw new PolicyError("primaryContactId must be null or a Contact ID.")
  }

  if (input.opportunityUpdates.nextStep !== null) {
    assertPlainText(
      "opportunityUpdates.nextStep",
      input.opportunityUpdates.nextStep,
      255
    )
  }
  if (input.opportunityUpdates.closeDate !== null) {
    parseDateOnly(
      "opportunityUpdates.closeDate",
      input.opportunityUpdates.closeDate
    )
  }
  if (input.opportunityUpdates.stageName !== null) {
    assertPlainText(
      "opportunityUpdates.stageName",
      input.opportunityUpdates.stageName,
      80
    )
  }

  if (input.followUps.length > MAX_FOLLOW_UPS) {
    throw new PolicyError(`followUps is limited to ${MAX_FOLLOW_UPS} items.`)
  }
  const semanticKeys = new Set<string>()
  for (const [index, followUp] of input.followUps.entries()) {
    assertPlainText(
      `followUps[${index}].subject`,
      followUp.subject,
      MAX_SUBJECT_LENGTH
    )
    if (followUp.description !== null) {
      assertPlainText(
        `followUps[${index}].description`,
        followUp.description,
        MAX_FOLLOW_UP_DESCRIPTION_LENGTH
      )
    }
    if (!isSalesforceId(followUp.ownerId, "005")) {
      throw new PolicyError(`followUps[${index}].ownerId must be a User ID.`)
    }
    if (
      followUp.contactId !== null &&
      !isSalesforceId(followUp.contactId, "003")
    ) {
      throw new PolicyError(
        `followUps[${index}].contactId must be null or a Contact ID.`
      )
    }
    parseDateOnly(`followUps[${index}].dueDate`, followUp.dueDate)
    const semanticKey = [
      followUp.subject.trim().toLowerCase(),
      followUp.dueDate,
      followUp.ownerId,
      followUp.contactId ?? "",
    ].join("|")
    if (semanticKeys.has(semanticKey)) {
      throw new PolicyError("followUps contains a duplicate task.")
    }
    semanticKeys.add(semanticKey)
  }
}

/** Apply policy that is relevant only before a new provider mutation. Replays
 * and resumptions use the immutable validated packet plus durable ledger. */
export function validateFreshWritePolicy(
  input: RecordMeetingOutcomeInput,
  policy: RuntimePolicy,
  now: Date = new Date()
): void {
  const expectedModified = normalizeTimestamp(
    "expectedOpportunityLastModifiedAt",
    input.expectedOpportunityLastModifiedAt
  )
  if (new Date(expectedModified).getTime() > now.getTime() + 5 * 60_000) {
    throw new PolicyError(
      "expectedOpportunityLastModifiedAt cannot be in the future."
    )
  }

  const today = startOfUtcDay(now)
  const occurredOn = parseDateOnly("occurredOn", input.occurredOn)
  const meetingAge = daysBetween(occurredOn, today)
  if (meetingAge < 0 || meetingAge > 365) {
    throw new PolicyError("occurredOn must be within the past 365 days.")
  }

  if (input.opportunityUpdates.closeDate !== null) {
    const closeDate = parseDateOnly(
      "opportunityUpdates.closeDate",
      input.opportunityUpdates.closeDate
    )
    const closeOffset = daysBetween(today, closeDate)
    if (closeOffset < -365 || closeOffset > 730) {
      throw new PolicyError(
        "opportunityUpdates.closeDate must be within one year past or two years future."
      )
    }
  }

  for (const [index, followUp] of input.followUps.entries()) {
    if (!policy.allowedTaskOwnerIds.has(followUp.ownerId)) {
      throw new PolicyError(`followUps[${index}].ownerId is not allowlisted.`)
    }
    const dueDate = parseDateOnly(
      `followUps[${index}].dueDate`,
      followUp.dueDate
    )
    const dueOffset = daysBetween(today, dueDate)
    if (dueOffset < 0 || dueOffset > 180) {
      throw new PolicyError(
        `followUps[${index}].dueDate must be within the next 180 days.`
      )
    }
  }
}

export function validateInput(
  input: RecordMeetingOutcomeInput,
  policy: RuntimePolicy,
  now: Date = new Date()
): void {
  validateCanonicalInput(input)
  validateFreshWritePolicy(input, policy, now)
}

export function validateOpportunityPreconditions(
  input: RecordMeetingOutcomeInput,
  opportunity: OpportunityRecord,
  policy: RuntimePolicy
): Record<string, string> {
  if (opportunity.Id !== input.opportunityId) {
    throw new PolicyError(
      "Salesforce returned a different Opportunity.",
      "conflict"
    )
  }
  if (
    normalizeTimestamp(
      "Opportunity.LastModifiedDate",
      opportunity.LastModifiedDate
    ) !==
    normalizeTimestamp(
      "expectedOpportunityLastModifiedAt",
      input.expectedOpportunityLastModifiedAt
    )
  ) {
    throw new PolicyError(
      "The Opportunity changed after approval; review the meeting outcome again.",
      "conflict"
    )
  }

  const changes: Record<string, string> = {}
  const updates = input.opportunityUpdates
  if (updates.nextStep !== null && updates.nextStep !== opportunity.NextStep) {
    changes.NextStep = updates.nextStep
  }
  if (
    updates.closeDate !== null &&
    updates.closeDate !== opportunity.CloseDate
  ) {
    changes.CloseDate = updates.closeDate
  }
  if (
    updates.stageName !== null &&
    updates.stageName !== opportunity.StageName
  ) {
    const allowedTargets = policy.allowedStageTransitions.get(
      opportunity.StageName
    )
    if (!allowedTargets?.has(updates.stageName)) {
      throw new PolicyError(
        "The requested Opportunity stage transition is not allowlisted.",
        "conflict"
      )
    }
    changes.StageName = updates.stageName
  }
  return changes
}

function canonicalInput(input: RecordMeetingOutcomeInput): unknown {
  return {
    notionPageId: normalizeNotionPageId(input.notionPageId),
    approvedRevision: input.approvedRevision,
    // approvalFingerprint is deliberately excluded: it is the expected hash
    // of this canonical payload and including it would make the hash circular.
    opportunityId: input.opportunityId,
    expectedOpportunityLastModifiedAt: normalizeTimestamp(
      "expectedOpportunityLastModifiedAt",
      input.expectedOpportunityLastModifiedAt
    ),
    meetingSubject: input.meetingSubject,
    occurredOn: input.occurredOn,
    outcomeSummary: input.outcomeSummary,
    primaryContactId: input.primaryContactId,
    opportunityUpdates: input.opportunityUpdates,
    followUps: input.followUps,
  }
}

export function operationKey(input: RecordMeetingOutcomeInput): string {
  return createHash("sha256")
    .update(
      `${normalizeNotionPageId(input.notionPageId)}:${input.opportunityId}`,
      "utf8"
    )
    .digest("hex")
}

export function inputFingerprint(input: RecordMeetingOutcomeInput): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalInput(input)), "utf8")
    .digest("hex")
}

export function taskOperationKeys(key: string, count: number): string[] {
  return [
    `${key}:meeting`,
    ...Array.from(
      { length: count },
      (_, index) => `${key}:followup:${index + 1}`
    ),
  ]
}
