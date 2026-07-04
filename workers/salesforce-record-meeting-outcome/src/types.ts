export type OpportunityUpdates = {
  nextStep: string | null
  closeDate: string | null
  stageName: string | null
}

export type FollowUpInput = {
  subject: string
  description: string | null
  dueDate: string
  ownerId: string
  contactId: string | null
}

export type RecordMeetingOutcomeInput = {
  notionPageId: string
  approvedRevision: string
  approvalFingerprint: string
  opportunityId: string
  expectedOpportunityLastModifiedAt: string
  meetingSubject: string
  occurredOn: string
  outcomeSummary: string
  primaryContactId: string | null
  opportunityUpdates: OpportunityUpdates
  followUps: FollowUpInput[]
}

export type TerminalStatus =
  | "completed"
  | "no_op"
  | "blocked"
  | "conflict"
  | "partial_failure"
  | "ambiguous"

export type StepStatus = "completed" | "skipped" | "failed"

export type ReceiptStep = {
  name: string
  status: StepStatus
  detail: string | null
}

export type RecordAction =
  | "created"
  | "updated"
  | "verified"
  | "written"
  | "unchanged"

export type RecordReceipt = {
  system: "salesforce" | "notion"
  kind: string
  id: string
  url: string | null
  action: RecordAction
}

export type RecordMeetingOutcomeResult = {
  ok: boolean
  status: TerminalStatus
  operationId: string
  idempotencyKey: string
  inputFingerprint: string
  changed: boolean
  replay: boolean
  records: RecordReceipt[]
  changedFields: string[]
  steps: ReceiptStep[]
  warnings: string[]
  retryable: boolean
  retryAfterSeconds: number | null
  resumeToken: string | null
  repairInstruction: string | null
}

export type NotionPageState = {
  pageId: string
  url: string
  approved: boolean
  approvedRevision: string
  approvedFingerprint: string
  currentReceipt: string
}

export type NotionReceipt = {
  version: 1
  operationId: string
  idempotencyKey: string
  inputFingerprint: string
  opportunityId: string
  activityId: string
  followUpIds: string[]
}

export type OpportunityRecord = {
  Id: string
  OwnerId: string
  StageName: string
  CloseDate: string
  NextStep: string | null
  LastModifiedDate: string
  lastModifiedHeader: string
}

export type LedgerStatus = "Claimed" | "SalesforceCommitted" | "Completed"

export type OperationLedger = {
  Id: string
  OperationKey__c: string
  InputFingerprint__c: string
  Status__c: LedgerStatus
  NotionPageId__c: string
  ApprovedRevision__c: string
  OpportunityId__c: string
  ActivityId__c: string | null
  FollowUp1Id__c: string | null
  FollowUp2Id__c: string | null
  FollowUp3Id__c: string | null
  FollowUp4Id__c: string | null
  FollowUp5Id__c: string | null
  ChangedFields__c: string | null
}

export type TransactionPlan = {
  operationKey: string
  inputFingerprint: string
  notionPageId: string
  approvedRevision: string
  notionUrl: string
  opportunity: OpportunityRecord
  opportunityChanges: Record<string, string>
  meeting: {
    subject: string
    occurredOn: string
    outcomeSummary: string
    ownerId: string
    primaryContactId: string | null
  }
  followUps: FollowUpInput[]
  committedAt: string
}

export type TransactionReceipt = {
  ledger: OperationLedger
  opportunityChanged: boolean
  activityId: string
  followUpIds: string[]
}

export interface NotionGateway {
  readPage(pageId: string): Promise<NotionPageState>
  ensureReceipt(
    pageId: string,
    approvedRevision: string,
    receipt: NotionReceipt
  ): Promise<"written" | "unchanged">
}

export interface SalesforceGateway {
  readonly instanceUrl: string
  getLedger(operationKey: string): Promise<OperationLedger | null>
  getOpportunity(opportunityId: string): Promise<OpportunityRecord>
  getOpportunityContactIds(
    opportunityId: string,
    contactIds: string[]
  ): Promise<Set<string>>
  getActiveUserIds(userIds: string[]): Promise<Set<string>>
  getTasksByOperationKeys(keys: string[]): Promise<Map<string, string>>
  executeTransaction(plan: TransactionPlan): Promise<TransactionReceipt>
  markCompleted(ledgerId: string, notionReceiptHash: string): Promise<void>
}
