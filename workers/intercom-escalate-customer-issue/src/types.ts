export type SourceKind = "ticket" | "conversation"
export type Severity = "sev1" | "sev2" | "sev3" | "sev4"
export type ResultStatus =
  | "completed"
  | "no_op"
  | "blocked"
  | "conflict"
  | "partial_failure"
  | "ambiguous"

export interface EscalationInput {
  approvalPageId: string
  approvalRevision: string
  approvalFingerprint: string
  sourceKind: SourceKind
  sourceId: string
}

export interface EscalationPacket {
  version: 1
  sourceKind: SourceKind
  sourceId: string
  expectedSourceUpdatedAt: number
  expectedSourceState:
    | "open"
    | "closed"
    | "snoozed"
    | "submitted"
    | "in_progress"
    | "waiting_on_customer"
    | "resolved"
  expectedContactId: string
  expectedCompanyId: string | null
  expectedTeamAssigneeId: string | null
  jiraProjectKey: string
  jiraIssueTypeId: string
  destinationIssueKey: string | null
  severity: Severity
  summary: string
  impact: string
  environment: string
  reproductionSteps: string[]
  accountTier: string | null
  entitlement: string | null
  incidentKey: string | null
  includeSafeAttachmentMetadata: boolean
}

export interface EscalationPolicy {
  jiraProjectKey: string
  jiraIssueTypeId: string
  intercomTeamId: string
  intercomTagId: string
}

export interface ApprovalSnapshot {
  pageId: string
  pageLastEditedTime: string
  status: string
  revision: string
  fingerprint: string
  packetText: string
  packet: EscalationPacket
  receiptText: string | null
}

export interface SourceAttachment {
  name: string
  contentType: string | null
  size: number | null
}

export interface SourcePart {
  id: string
  type: string
  body: string
  attachments: SourceAttachment[]
}

export interface SourceSnapshot {
  kind: SourceKind
  id: string
  updatedAt: number
  state: string
  title: string
  openingBody: string
  contactIds: string[]
  companyId: string | null
  teamAssigneeId: string | null
  adminAssigneeId: string | null
  slaStatus: string | null
  tags: { id: string; name: string }[]
  parts: SourcePart[]
  totalParts: number
}

export interface ContactSnapshot {
  id: string
  name: string | null
  companyIds: string[]
}

export interface CompanySnapshot {
  id: string
  name: string | null
}

export interface JiraIssue {
  id: string
  key: string
  projectKey: string
  issueTypeId: string
  labels: string[]
}

export type MutationState = "pending" | "fenced" | "rejected" | "complete"
export type RequestDisposition =
  | "not_sent"
  | "outcome_unknown"
  | "accepted"
  | "definitely_rejected"

export interface DurableOperation {
  version: 1
  operationId: string
  marker: string
  propertyKey: string
  mappingId: string
  mappingGeneration: number | null
  policy: EscalationPolicy | null
  input: EscalationInput
  packet: EscalationPacket
  createdAt: string
  updatedAt: string
  sourceGuardFingerprint: string | null
  jiraMode: "create" | "enrich" | null
  jiraState: MutationState
  jiraDisposition: RequestDisposition
  jiraAttempts: number
  jiraIssueId: string | null
  jiraIssueKey: string | null
  issueCreated: boolean
  issueEnriched: boolean
  tagState: MutationState
  routeState: MutationState
  noteState: MutationState
  intercomNotePartId: string | null
  receiptProofHash: string | null
  receiptWritten: boolean
  completedAt: string | null
}

export interface SourceMapping {
  version: 1
  mappingId: string
  workspaceId: string
  sourceKind: SourceKind
  sourceId: string
  generation: number
  state: "claiming" | "mapped"
  ownerOperationId: string
  intendedIssueKey: string | null
  jiraIssueId: string | null
  jiraIssueKey: string | null
  createdAt: string
  updatedAt: string
}

export interface StoredReceipt {
  version: 1
  operationId: string
  proofHash: string
  status: "escalated"
  approvalPageId: string
  approvalRevision: string
  approvalFingerprint: string
  mappingId: string
  mappingGeneration: number
  intercomTeamId: string
  intercomTagId: string
  sourceKind: SourceKind
  sourceId: string
  jiraProjectKey: string
  jiraIssueTypeId: string
  jiraIssueId: string
  jiraIssueKey: string
  jiraUrl: string
  issueCreated: boolean
  issueEnriched: boolean
  tagged: true
  routed: true
  internalNotePartId: string
  customerVisibleReplySent: false
  completedAt: string
}

export interface ReceiptProof {
  version: 1
  operationId: string
  proofHash: string
  receipt: StoredReceipt
}

export interface ResultRecord {
  system: "notion" | "intercom" | "jira"
  kind: "approval" | "source" | "issue" | "receipt"
  id: string
  url: string | null
  action:
    | "verified"
    | "created"
    | "enriched"
    | "tagged"
    | "routed"
    | "noted"
    | "receipt_written"
    | "unchanged"
}

export interface ResultStep {
  name:
    | "approval"
    | "source"
    | "mapping"
    | "jira"
    | "intercom_tag"
    | "intercom_route"
    | "intercom_note"
    | "receipt"
  state: "completed" | "skipped" | "blocked" | "failed" | "pending"
}

export interface EscalationResult {
  ok: boolean
  status: ResultStatus
  operationId: string
  idempotencyKey: string
  changed: boolean
  replay: boolean
  preconditionsVerified: boolean
  issueCreated: boolean
  issueEnriched: boolean
  receiptWritten: boolean
  customerVisibleReplySent: false
  approvalPageId: string
  approvalRevision: string
  approvalFingerprint: string
  mappingId: string
  intercomTeamId: string | null
  intercomTagId: string | null
  sourceKind: SourceKind
  sourceId: string
  jiraIssueId: string | null
  jiraIssueKey: string | null
  jiraUrl: string | null
  marker: string
  safeAttachmentCount: number
  records: ResultRecord[]
  steps: ResultStep[]
  warnings: string[]
  retryable: boolean
  retryAfterMs: number | null
  resumeToken: string | null
  repairInstruction: string | null
  startedAt: string
  completedAt: string | null
  message: string
}

export interface NotionClientLike {
  pages: {
    retrieve(args: { page_id: string }): Promise<unknown>
    update(args: {
      page_id: string
      properties: Record<string, unknown>
    }): Promise<unknown>
  }
}

export interface OperationStore {
  createOperation(
    record: DurableOperation,
    ttlSeconds: number
  ): Promise<boolean>
  getOperation(operationId: string): Promise<DurableOperation | null>
  saveOperation(
    previous: DurableOperation,
    next: DurableOperation,
    ttlSeconds: number
  ): Promise<boolean>
  getMapping(mappingId: string): Promise<SourceMapping | null>
  createMapping(mapping: SourceMapping): Promise<boolean>
  saveMapping(previous: SourceMapping, next: SourceMapping): Promise<boolean>
  getReceiptProof(operationId: string): Promise<ReceiptProof | null>
  createReceiptProof(proof: ReceiptProof): Promise<boolean>
  acquireLease(key: string, token: string, ttlMs: number): Promise<boolean>
  renewLease(key: string, token: string, ttlMs: number): Promise<boolean>
  releaseLease(key: string, token: string): Promise<void>
}

export interface IntercomGateway {
  getIdentity(): Promise<{ adminId: string; workspaceId: string }>
  getSource(kind: SourceKind, id: string): Promise<SourceSnapshot>
  getContact(id: string): Promise<ContactSnapshot>
  getCompany(id: string): Promise<CompanySnapshot>
  listContactCompanyIds(id: string): Promise<string[]>
  addTag(kind: SourceKind, id: string, tagId: string): Promise<void>
  routeToTeam(kind: SourceKind, id: string, teamId: string): Promise<void>
  addInternalNote(kind: SourceKind, id: string, body: string): Promise<void>
}

export interface JiraGateway {
  getIdentity(): Promise<{ accountId: string }>
  verifyCreateTarget(projectKey: string, issueTypeId: string): Promise<void>
  getIssue(issueKey: string): Promise<JiraIssue>
  createIssue(args: {
    packet: EscalationPacket
    source: SourceSnapshot
    contact: ContactSnapshot
    company: CompanySnapshot | null
    marker: string
    propertyKey: string
    safeAttachments: SourceAttachment[]
  }): Promise<{ id: string; key: string }>
  findIssueByMarker(projectKey: string, marker: string): Promise<JiraIssue[]>
  hasOperationMarker(
    issueKey: string,
    propertyKey: string,
    marker: string
  ): Promise<boolean>
  addEnrichmentComment(args: {
    issueKey: string
    packet: EscalationPacket
    source: SourceSnapshot
    contact: ContactSnapshot
    company: CompanySnapshot | null
    marker: string
    safeAttachments: SourceAttachment[]
  }): Promise<void>
  findCommentMarker(issueKey: string, marker: string): Promise<boolean>
  putOperationMarker(
    issueKey: string,
    propertyKey: string,
    marker: string
  ): Promise<void>
  issueUrl(issueKey: string): string
}

export interface EscalationDependencies {
  notion: NotionClientLike
  store: OperationStore
  intercom: IntercomGateway
  jira: JiraGateway
  now: () => Date
  randomToken: () => string
}

export class SafetyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: Exclude<
      ResultStatus,
      "completed" | "no_op"
    > = "blocked",
    public readonly retryable = false,
    public readonly retryAfterMs: number | null = null,
    public readonly ambiguous = false
  ) {
    super(message)
    this.name = "SafetyError"
  }
}

export class ProviderError extends SafetyError {
  constructor(
    code: string,
    message: string,
    public readonly httpStatus: number | null,
    options: {
      retryable?: boolean
      retryAfterMs?: number | null
      ambiguous?: boolean
      status?: Exclude<ResultStatus, "completed" | "no_op">
    } = {}
  ) {
    super(
      code,
      message,
      options.status ?? (options.ambiguous ? "ambiguous" : "blocked"),
      options.retryable ?? false,
      options.retryAfterMs ?? null,
      options.ambiguous ?? false
    )
  }
}
