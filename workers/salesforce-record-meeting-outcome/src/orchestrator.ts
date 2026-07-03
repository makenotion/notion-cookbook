import { createHash } from "node:crypto"

import type { RuntimePolicy } from "./policy.js"
import { NotionRequestTimeoutError } from "./notion.js"
import {
  PolicyError,
  inputFingerprint,
  isSalesforceId,
  operationKey,
  taskOperationKeys,
  validateCanonicalInput,
  validateFreshWritePolicy,
  validateOpportunityPreconditions,
} from "./policy.js"
import {
  SalesforceFailure,
  ledgerFollowUpIds,
  parseOperationLedger,
  salesforceRecordUrl,
} from "./salesforce.js"
import type {
  NotionGateway,
  NotionReceipt,
  OperationLedger,
  ReceiptStep,
  RecordMeetingOutcomeInput,
  RecordMeetingOutcomeResult,
  RecordReceipt,
  SalesforceGateway,
  TerminalStatus,
  TransactionReceipt,
} from "./types.js"

export type OrchestratorDependencies = {
  notion: NotionGateway
  salesforce: SalesforceGateway
  policy: RuntimePolicy
  now?: () => Date
}

type ResultOptions = {
  ok: boolean
  status: TerminalStatus
  operationId: string
  inputFingerprint: string
  changed?: boolean
  replay?: boolean
  records?: RecordReceipt[]
  changedFields?: string[]
  steps: ReceiptStep[]
  warnings?: string[]
  retryable?: boolean
  resumeToken?: string | null
  repairInstruction?: string | null
}

function result(options: ResultOptions): RecordMeetingOutcomeResult {
  return {
    ok: options.ok,
    status: options.status,
    operationId: options.operationId,
    idempotencyKey: options.operationId,
    inputFingerprint: options.inputFingerprint,
    changed: options.changed ?? false,
    replay: options.replay ?? false,
    records: options.records ?? [],
    changedFields: options.changedFields ?? [],
    steps: options.steps,
    warnings: options.warnings ?? [],
    retryable: options.retryable ?? false,
    resumeToken: options.resumeToken ?? null,
    repairInstruction: options.repairInstruction ?? null,
  }
}

function failureResult(
  status: TerminalStatus,
  detail: string,
  operationId: string,
  fingerprint: string,
  steps: ReceiptStep[],
  options: {
    changed?: boolean
    retryable?: boolean
    replay?: boolean
    records?: RecordReceipt[]
    changedFields?: string[]
    resumeToken?: string | null
    repairInstruction?: string | null
  } = {}
): RecordMeetingOutcomeResult {
  return result({
    ok: false,
    status,
    operationId,
    inputFingerprint: fingerprint,
    steps: [...steps, { name: "terminal", status: "failed", detail }],
    changed: options.changed,
    retryable: options.retryable,
    replay: options.replay,
    records: options.records,
    changedFields: options.changedFields,
    resumeToken: options.resumeToken,
    repairInstruction: options.repairInstruction,
  })
}

function providerFailureDisposition(error: unknown): {
  status: TerminalStatus
  retryable: boolean
} {
  if (!(error instanceof SalesforceFailure)) {
    if (error instanceof NotionRequestTimeoutError) {
      return { status: "blocked", retryable: true }
    }
    return { status: "blocked", retryable: false }
  }
  if (error.kind === "conflict") {
    return { status: "conflict", retryable: false }
  }
  if (error.kind === "retryable") {
    return { status: "blocked", retryable: true }
  }
  if (error.kind === "ambiguous") {
    return { status: "ambiguous", retryable: true }
  }
  return { status: "blocked", retryable: false }
}

function changedFields(ledger: OperationLedger): string[] {
  return (ledger.ChangedFields__c ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
}

function notionReceipt(
  ledger: OperationLedger,
  operationId: string,
  fingerprint: string
): NotionReceipt {
  if (!ledger.ActivityId__c) {
    throw new SalesforceFailure(
      "The Salesforce operation ledger is missing its activity ID.",
      "ambiguous"
    )
  }
  return {
    version: 1,
    operationId,
    idempotencyKey: operationId,
    inputFingerprint: fingerprint,
    opportunityId: ledger.OpportunityId__c,
    activityId: ledger.ActivityId__c,
    followUpIds: ledgerFollowUpIds(ledger),
  }
}

function receiptHash(receipt: NotionReceipt): string {
  return createHash("sha256")
    .update(JSON.stringify(receipt), "utf8")
    .digest("hex")
}

function providerRecords(
  salesforce: SalesforceGateway,
  receipt: NotionReceipt,
  opportunityAction: "updated" | "verified",
  taskAction: "created" | "verified"
): RecordReceipt[] {
  return [
    {
      system: "salesforce",
      kind: "opportunity",
      id: receipt.opportunityId,
      url: salesforceRecordUrl(
        salesforce.instanceUrl,
        "Opportunity",
        receipt.opportunityId
      ),
      action: opportunityAction,
    },
    {
      system: "salesforce",
      kind: "meeting_activity",
      id: receipt.activityId,
      url: salesforceRecordUrl(
        salesforce.instanceUrl,
        "Task",
        receipt.activityId
      ),
      action: taskAction,
    },
    ...receipt.followUpIds.map<RecordReceipt>((id) => ({
      system: "salesforce",
      kind: "follow_up_task",
      id,
      url: salesforceRecordUrl(salesforce.instanceUrl, "Task", id),
      action: taskAction,
    })),
  ]
}

function orphanTaskRecords(
  salesforce: SalesforceGateway,
  expectedKeys: string[],
  evidence: Map<string, string>
): RecordReceipt[] {
  const allowedKeys = new Set(expectedKeys)
  if (
    evidence.size > expectedKeys.length ||
    [...evidence].some(
      ([key, id]) => !allowedKeys.has(key) || !isSalesforceId(id, "00T")
    )
  ) {
    throw new SalesforceFailure(
      "Salesforce Task evidence failed its operation correlation contract.",
      "conflict"
    )
  }
  return expectedKeys.flatMap((key) => {
    const id = evidence.get(key)
    return id
      ? [
          {
            system: "salesforce" as const,
            kind: "orphan_task",
            id,
            url: salesforceRecordUrl(salesforce.instanceUrl, "Task", id),
            action: "verified" as const,
          },
        ]
      : []
  })
}

function assertLedgerMatches(
  ledger: OperationLedger,
  input: RecordMeetingOutcomeInput,
  operationId: string,
  fingerprint: string
): OperationLedger {
  const validated = parseOperationLedger(ledger)
  if (
    validated.OperationKey__c !== operationId ||
    validated.InputFingerprint__c !== fingerprint ||
    validated.NotionPageId__c.replace(/-/g, "").toLowerCase() !==
      input.notionPageId.replace(/-/g, "").toLowerCase() ||
    validated.ApprovedRevision__c !== input.approvedRevision ||
    validated.OpportunityId__c !== input.opportunityId
  ) {
    throw new PolicyError(
      "The stable meeting operation key is already bound to a different approved payload.",
      "conflict"
    )
  }
  if (validated.Status__c === "Claimed") {
    throw new SalesforceFailure(
      "The operation claim exists without a committed receipt.",
      "ambiguous"
    )
  }
  const expectedFollowUps = input.followUps.length
  const positionedFollowUps = [
    validated.FollowUp1Id__c,
    validated.FollowUp2Id__c,
    validated.FollowUp3Id__c,
    validated.FollowUp4Id__c,
    validated.FollowUp5Id__c,
  ]
  if (
    positionedFollowUps.some((id, index) =>
      index < expectedFollowUps ? id === null : id !== null
    ) ||
    new Set([
      validated.ActivityId__c,
      ...positionedFollowUps.filter((id): id is string => id !== null),
    ]).size !==
      1 + expectedFollowUps
  ) {
    throw new SalesforceFailure(
      "Salesforce ledger Task IDs do not match the approved follow-up positions.",
      "conflict"
    )
  }
  const requestedFields = new Set(
    [
      input.opportunityUpdates.closeDate !== null ? "CloseDate" : null,
      input.opportunityUpdates.nextStep !== null ? "NextStep" : null,
      input.opportunityUpdates.stageName !== null ? "StageName" : null,
    ].filter((field): field is string => field !== null)
  )
  if (changedFields(validated).some((field) => !requestedFields.has(field))) {
    throw new SalesforceFailure(
      "Salesforce ledger changed-field evidence exceeds the approved update set.",
      "conflict"
    )
  }
  return validated
}

async function finishFromLedger(
  input: RecordMeetingOutcomeInput,
  ledger: OperationLedger,
  operationId: string,
  fingerprint: string,
  deps: OrchestratorDependencies,
  steps: ReceiptStep[],
  replay: boolean
): Promise<RecordMeetingOutcomeResult> {
  ledger = assertLedgerMatches(ledger, input, operationId, fingerprint)
  const compactReceipt = notionReceipt(ledger, operationId, fingerprint)
  const providerReceipt = providerRecords(
    deps.salesforce,
    compactReceipt,
    replay
      ? "verified"
      : changedFields(ledger).length > 0
        ? "updated"
        : "verified",
    replay ? "verified" : "created"
  )
  steps.push({
    name: "salesforce_reconciliation",
    status: "completed",
    detail: replay
      ? `Recovered ${1 + compactReceipt.followUpIds.length} Task IDs from the durable ledger.`
      : `Verified ${1 + compactReceipt.followUpIds.length} canonical Task IDs from the committed Composite response.`,
  })

  let notionAction: "written" | "unchanged"
  try {
    notionAction = await deps.notion.ensureReceipt(
      input.notionPageId,
      input.approvedRevision,
      compactReceipt
    )
  } catch (error) {
    if (error instanceof PolicyError) {
      return failureResult(
        "partial_failure",
        error.message,
        operationId,
        fingerprint,
        steps,
        {
          changed: !replay,
          replay,
          records: providerReceipt,
          changedFields: changedFields(ledger),
          resumeToken: operationId,
          repairInstruction:
            "Restore the approved Notion revision/fingerprint or clear the conflicting receipt, then retry the exact same input.",
        }
      )
    }
    return failureResult(
      "partial_failure",
      "Salesforce committed, but the Notion receipt was not confirmed.",
      operationId,
      fingerprint,
      steps,
      {
        changed: !replay,
        retryable: true,
        replay,
        records: providerReceipt,
        changedFields: changedFields(ledger),
        resumeToken: operationId,
        repairInstruction:
          "Retry the exact same input; the Worker will resume at Notion writeback without creating Salesforce records again.",
      }
    )
  }

  const records: RecordReceipt[] = [
    ...providerReceipt,
    {
      system: "notion",
      kind: "meeting_page",
      id: input.notionPageId,
      url: null,
      action: notionAction,
    },
  ]
  steps.push({
    name: "notion_receipt",
    status: notionAction === "written" ? "completed" : "skipped",
    detail:
      notionAction === "written"
        ? "Wrote the compact canonical receipt."
        : "The matching compact receipt was already present.",
  })

  let ledgerCompletedNow = false
  if (ledger.Status__c !== "Completed") {
    try {
      await deps.salesforce.markCompleted(
        ledger.Id,
        receiptHash(compactReceipt)
      )
      steps.push({
        name: "ledger_completion",
        status: "completed",
        detail: "Marked the durable operation ledger completed.",
      })
      ledgerCompletedNow = true
    } catch {
      return failureResult(
        "partial_failure",
        "Salesforce records and the Notion receipt are complete, but ledger finalization was not confirmed.",
        operationId,
        fingerprint,
        steps,
        {
          changed: !replay || notionAction === "written",
          retryable: true,
          replay,
          records,
          changedFields: changedFields(ledger),
          resumeToken: operationId,
          repairInstruction:
            "Retry the exact same input; the Worker will verify both systems and finalize the ledger only.",
        }
      )
    }
  } else {
    steps.push({
      name: "ledger_completion",
      status: "skipped",
      detail: "The durable operation ledger was already completed.",
    })
  }

  const changed = !replay || notionAction === "written" || ledgerCompletedNow
  return result({
    ok: true,
    status: changed ? "completed" : "no_op",
    operationId,
    inputFingerprint: fingerprint,
    changed,
    replay,
    records,
    changedFields: changedFields(ledger),
    steps,
  })
}

async function reconcileAmbiguousMutation(
  input: RecordMeetingOutcomeInput,
  operationId: string,
  fingerprint: string,
  deps: OrchestratorDependencies,
  steps: ReceiptStep[]
): Promise<RecordMeetingOutcomeResult> {
  try {
    const ledger = await deps.salesforce.getLedger(operationId)
    if (ledger) {
      return finishFromLedger(
        input,
        ledger,
        operationId,
        fingerprint,
        deps,
        steps,
        true
      )
    }
    const expectedTaskKeys = taskOperationKeys(
      operationId,
      input.followUps.length
    )
    const orphanedTasks =
      await deps.salesforce.getTasksByOperationKeys(expectedTaskKeys)
    if (orphanedTasks.size > 0) {
      const records = orphanTaskRecords(
        deps.salesforce,
        expectedTaskKeys,
        orphanedTasks
      )
      steps.push({
        name: "orphan_task_evidence",
        status: "failed",
        detail: `Found ${records.length} Task records correlated to this operationId without its ledger.`,
      })
      return failureResult(
        "ambiguous",
        "Task records exist without the durable operation ledger.",
        operationId,
        fingerprint,
        steps,
        {
          retryable: false,
          records,
          repairInstruction:
            "Use the returned Task IDs and operationId to inspect Notion_Operation_Item_Key__c. Restore the matching ledger or remove only confirmed orphan Tasks, then retry the exact input.",
        }
      )
    }
  } catch (error) {
    if (error instanceof PolicyError) {
      return failureResult(
        error.kind,
        error.message,
        operationId,
        fingerprint,
        steps
      )
    }
    if (error instanceof SalesforceFailure && error.kind === "conflict") {
      return failureResult(
        "conflict",
        error.message,
        operationId,
        fingerprint,
        steps,
        {
          repairInstruction:
            "Inspect and repair the durable Salesforce ledger or Task evidence before retrying.",
        }
      )
    }
  }
  return failureResult(
    "ambiguous",
    "Salesforce did not confirm the Composite result and no committed ledger is visible yet.",
    operationId,
    fingerprint,
    steps,
    {
      retryable: true,
      resumeToken: operationId,
      repairInstruction:
        "Retry the exact same input. The unique ledger claim and Task keys prevent duplicate creation.",
    }
  )
}

export async function recordMeetingOutcome(
  input: RecordMeetingOutcomeInput,
  deps: OrchestratorDependencies
): Promise<RecordMeetingOutcomeResult> {
  const steps: ReceiptStep[] = []
  let operationId = ""
  let fingerprint = ""

  try {
    validateCanonicalInput(input)
    operationId = operationKey(input)
    fingerprint = inputFingerprint(input)
    if (input.approvalFingerprint !== fingerprint) {
      throw new PolicyError(
        "The supplied approval fingerprint does not match the canonical packet.",
        "conflict"
      )
    }
    steps.push({
      name: "input_policy",
      status: "completed",
      detail:
        "Validated bounded canonical input and its explicit approval fingerprint.",
    })
  } catch (error) {
    const detail =
      error instanceof PolicyError ? error.message : "Input validation failed."
    return failureResult(
      error instanceof PolicyError ? error.kind : "blocked",
      detail,
      operationId,
      fingerprint,
      steps
    )
  }

  // Salesforce is the durable source of truth for whether the compound write
  // already committed. Read it before the current Notion approval gate so a
  // revoked, revised, or unavailable page cannot hide known provider records.
  let existingLedger: OperationLedger | null
  try {
    existingLedger = await deps.salesforce.getLedger(operationId)
    steps.push({
      name: "salesforce_ledger_lookup",
      status: "completed",
      detail: existingLedger
        ? "Found the durable Salesforce operation checkpoint before Notion writeback."
        : "Confirmed that no durable Salesforce operation checkpoint exists.",
    })
  } catch (error) {
    const disposition = providerFailureDisposition(error)
    return failureResult(
      disposition.status,
      error instanceof SalesforceFailure
        ? error.message
        : "The Salesforce operation ledger could not be read.",
      operationId,
      fingerprint,
      steps,
      { retryable: disposition.retryable }
    )
  }
  if (existingLedger) {
    try {
      return await finishFromLedger(
        input,
        existingLedger,
        operationId,
        fingerprint,
        deps,
        steps,
        true
      )
    } catch (error) {
      if (error instanceof PolicyError) {
        return failureResult(
          error.kind,
          error.message,
          operationId,
          fingerprint,
          steps
        )
      }
      const disposition = providerFailureDisposition(error)
      return failureResult(
        disposition.status,
        error instanceof SalesforceFailure
          ? error.message
          : "The durable Salesforce operation could not be reconciled.",
        operationId,
        fingerprint,
        steps,
        {
          retryable: disposition.retryable,
          resumeToken: disposition.retryable ? operationId : null,
          repairInstruction: disposition.retryable
            ? "Retry the exact same input to reconcile the durable ledger."
            : "Inspect and repair the durable Salesforce ledger before retrying.",
        }
      )
    }
  }

  try {
    validateFreshWritePolicy(
      input,
      deps.policy,
      (deps.now ?? (() => new Date()))()
    )
    steps.push({
      name: "fresh_write_policy",
      status: "completed",
      detail:
        "Validated current date windows and task-owner allowlists for a new write.",
    })
  } catch (error) {
    return failureResult(
      error instanceof PolicyError ? error.kind : "blocked",
      error instanceof PolicyError
        ? error.message
        : "Fresh-write policy validation failed.",
      operationId,
      fingerprint,
      steps
    )
  }

  let page
  try {
    page = await deps.notion.readPage(input.notionPageId)
  } catch (error) {
    const disposition = providerFailureDisposition(error)
    const detail =
      error instanceof PolicyError
        ? error.message
        : error instanceof NotionRequestTimeoutError
          ? "The Notion approval page timed out before any provider write."
          : "The Notion approval page could not be verified."
    return failureResult(
      disposition.status,
      detail,
      operationId,
      fingerprint,
      steps,
      { retryable: disposition.retryable }
    )
  }
  if (!page.approved) {
    return failureResult(
      "blocked",
      "The Notion meeting outcome is not approved.",
      operationId,
      fingerprint,
      steps
    )
  }
  if (page.approvedRevision !== input.approvedRevision) {
    return failureResult(
      "conflict",
      "The approved Notion revision does not match the tool input.",
      operationId,
      fingerprint,
      steps
    )
  }
  if (
    input.approvalFingerprint !== fingerprint ||
    page.approvedFingerprint !== fingerprint
  ) {
    return failureResult(
      "conflict",
      "The tool input does not match the fingerprint of the approved Notion packet.",
      operationId,
      fingerprint,
      steps
    )
  }
  steps.push({
    name: "notion_approval",
    status: "completed",
    detail: "Verified approval, revision, and canonical packet fingerprint.",
  })

  if (page.currentReceipt.trim()) {
    return failureResult(
      "conflict",
      "The Notion receipt property is already occupied but Salesforce has no matching durable ledger.",
      operationId,
      fingerprint,
      steps
    )
  }

  const taskKeys = taskOperationKeys(operationId, input.followUps.length)
  try {
    const orphanedTasks =
      await deps.salesforce.getTasksByOperationKeys(taskKeys)
    if (orphanedTasks.size > 0) {
      const records = orphanTaskRecords(
        deps.salesforce,
        taskKeys,
        orphanedTasks
      )
      steps.push({
        name: "orphan_task_evidence",
        status: "failed",
        detail: `Found ${records.length} Task records correlated to this operationId without its ledger.`,
      })
      return failureResult(
        "ambiguous",
        "Task records already use this operation key without a matching ledger.",
        operationId,
        fingerprint,
        steps,
        {
          records,
          repairInstruction:
            "Use the returned Task IDs and operationId to inspect Notion_Operation_Item_Key__c. Restore the matching ledger or remove only confirmed orphan Tasks, then retry the exact input.",
        }
      )
    }
  } catch (error) {
    const disposition = providerFailureDisposition(error)
    return failureResult(
      disposition.status,
      error instanceof SalesforceFailure
        ? error.message
        : "Existing Task operation keys could not be checked.",
      operationId,
      fingerprint,
      steps,
      { retryable: disposition.retryable }
    )
  }

  let opportunity
  let opportunityChanges: Record<string, string>
  try {
    opportunity = await deps.salesforce.getOpportunity(input.opportunityId)
    opportunityChanges = validateOpportunityPreconditions(
      input,
      opportunity,
      deps.policy
    )
    steps.push({
      name: "opportunity_precondition",
      status: "completed",
      detail:
        "Re-read the Opportunity and validated current state and transition policy.",
    })
  } catch (error) {
    if (error instanceof PolicyError) {
      return failureResult(
        error.kind,
        error.message,
        operationId,
        fingerprint,
        steps
      )
    }
    const disposition = providerFailureDisposition(error)
    return failureResult(
      disposition.status,
      error instanceof SalesforceFailure
        ? error.message
        : "The Opportunity could not be verified.",
      operationId,
      fingerprint,
      steps,
      { retryable: disposition.retryable }
    )
  }

  const contactIds = [
    input.primaryContactId,
    ...input.followUps.map((followUp) => followUp.contactId),
  ].filter((value): value is string => value !== null)
  const ownerIds = [
    ...new Set(input.followUps.map((followUp) => followUp.ownerId)),
  ]
  try {
    const [authorizedContacts, activeUsers] = await Promise.all([
      deps.salesforce.getOpportunityContactIds(input.opportunityId, contactIds),
      deps.salesforce.getActiveUserIds(ownerIds),
    ])
    const missingContact = contactIds.find((id) => !authorizedContacts.has(id))
    if (missingContact) {
      throw new PolicyError(
        "A supplied Contact is not an Opportunity Contact Role on the target Opportunity.",
        "conflict"
      )
    }
    const inactiveOwner = ownerIds.find((id) => !activeUsers.has(id))
    if (inactiveOwner) {
      throw new PolicyError(
        "A follow-up owner is inactive or unreadable in Salesforce.",
        "conflict"
      )
    }
    steps.push({
      name: "identity_resolution",
      status: "completed",
      detail: `Verified ${contactIds.length} Contact references and ${ownerIds.length} follow-up owners.`,
    })
  } catch (error) {
    if (error instanceof PolicyError) {
      return failureResult(
        error.kind,
        error.message,
        operationId,
        fingerprint,
        steps
      )
    }
    const disposition = providerFailureDisposition(error)
    return failureResult(
      disposition.status,
      error instanceof SalesforceFailure
        ? error.message
        : "Salesforce identities could not be verified.",
      operationId,
      fingerprint,
      steps,
      { retryable: disposition.retryable }
    )
  }

  let transaction: TransactionReceipt
  // Identity resolution can take long enough for a human or automation to
  // revoke approval or change the Opportunity. Re-read both authorities at the
  // last possible point; the Composite conditional header then closes the
  // remaining Opportunity race during the write itself.
  try {
    const [latestPage, latestOpportunity] = await Promise.all([
      deps.notion.readPage(input.notionPageId),
      deps.salesforce.getOpportunity(input.opportunityId),
    ])
    if (
      !latestPage.approved ||
      latestPage.approvedRevision !== input.approvedRevision ||
      latestPage.approvedFingerprint !== fingerprint ||
      latestPage.currentReceipt.trim()
    ) {
      throw new PolicyError(
        "The Notion approval, fingerprint, or empty receipt precondition changed during resolution.",
        "conflict"
      )
    }
    opportunity = latestOpportunity
    opportunityChanges = validateOpportunityPreconditions(
      input,
      latestOpportunity,
      deps.policy
    )
    steps.push({
      name: "immediate_prewrite_check",
      status: "completed",
      detail:
        "Re-read Notion approval and Salesforce Opportunity immediately before the Composite mutation.",
    })
  } catch (error) {
    if (error instanceof PolicyError) {
      return failureResult(
        error.kind,
        error.message,
        operationId,
        fingerprint,
        steps
      )
    }
    const disposition = providerFailureDisposition(error)
    return failureResult(
      disposition.status,
      error instanceof SalesforceFailure
        ? error.message
        : "Immediate pre-write state could not be verified.",
      operationId,
      fingerprint,
      steps,
      { retryable: disposition.retryable }
    )
  }

  try {
    transaction = await deps.salesforce.executeTransaction({
      operationKey: operationId,
      inputFingerprint: fingerprint,
      notionPageId: input.notionPageId,
      approvedRevision: input.approvedRevision,
      notionUrl: page.url,
      opportunity,
      opportunityChanges,
      meeting: {
        subject: input.meetingSubject,
        occurredOn: input.occurredOn,
        outcomeSummary: input.outcomeSummary,
        ownerId: opportunity.OwnerId,
        primaryContactId: input.primaryContactId,
      },
      followUps: input.followUps,
      committedAt: (deps.now ?? (() => new Date()))().toISOString(),
    })
    steps.push({
      name: "salesforce_transaction",
      status: "completed",
      detail: `Committed the unique ledger claim, activity, ${transaction.followUpIds.length} follow-ups, and allowlisted Opportunity changes in one all-or-none Composite request.`,
    })
  } catch (error) {
    if (
      error instanceof SalesforceFailure &&
      ["duplicate_claim", "ambiguous"].includes(error.kind)
    ) {
      return reconcileAmbiguousMutation(
        input,
        operationId,
        fingerprint,
        deps,
        steps
      )
    }
    if (error instanceof SalesforceFailure) {
      const status: TerminalStatus =
        error.kind === "conflict" ? "conflict" : "blocked"
      return failureResult(
        status,
        error.message,
        operationId,
        fingerprint,
        steps,
        { retryable: error.kind === "retryable" }
      )
    }
    return reconcileAmbiguousMutation(
      input,
      operationId,
      fingerprint,
      deps,
      steps
    )
  }

  return finishFromLedger(
    input,
    transaction.ledger,
    operationId,
    fingerprint,
    deps,
    steps,
    false
  )
}
