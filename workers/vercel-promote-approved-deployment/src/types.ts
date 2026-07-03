export const APPROVAL_PROPERTIES = {
  status: "Approval status",
  revision: "Approval revision",
  teamId: "Vercel team ID",
  projectId: "Vercel project ID",
  deploymentId: "Vercel deployment ID",
  gitSha: "Git SHA",
  gitBranch: "Git branch",
  expectedCurrentDeploymentId: "Expected current deployment ID",
  fingerprint: "Approval fingerprint",
} as const

export const ROLLBACK_APPROVAL_PROPERTIES = {
  status: "Rollback approval status",
  revision: "Rollback approval revision",
  originalPromotionOperationId: "Original promotion operation ID",
  promotionIncidentPageId: "Promotion incident page ID",
  originalIncidentReceiptHash: "Original incident receipt hash",
  teamId: "Rollback Vercel team ID",
  projectId: "Rollback Vercel project ID",
  candidateDeploymentId: "Rollback candidate deployment ID",
  rollbackDeploymentId: "Rollback target deployment ID",
  fingerprint: "Rollback approval fingerprint",
} as const

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export const DEFINITE_PROMOTION_REJECTION_STATUSES = [
  400, 401, 403, 429,
] as const

export function isDefinitePromotionRejectionStatus(
  status: number | null
): boolean {
  return (
    status !== null &&
    (DEFINITE_PROMOTION_REJECTION_STATUSES as readonly number[]).includes(
      status
    )
  )
}

export interface PromoteInput {
  approvalPageId: string
  approvalRevision: string
  approvalFingerprint: string
  teamId: string
  projectId: string
  deploymentId: string
  expectedGitSha: string
  expectedGitBranch: string
  expectedCurrentDeploymentId: string
}

export interface ApprovalPacket {
  approvalStatus: "Approved"
  approvalRevision: string
  teamId: string
  projectId: string
  deploymentId: string
  gitSha: string
  gitBranch: string
  expectedCurrentDeploymentId: string
}

export interface ApprovalSnapshot {
  pageId: string
  revision: string
  pageLastEditedTime: string
  fingerprint: string
  packet: ApprovalPacket
  receiptText: string
}

export interface TargetPolicy {
  teamId: string
  projectId: string
  productionDomains: string[]
  deploymentChecks: DeploymentCheckPolicy[]
  healthPaths: string[]
}

export interface DeploymentCheckPolicy {
  id: string
  name: string | null
}

export interface WorkerConfig {
  vercelToken: string
  redisUrl: string
  redisToken: string
  protectionBypassSecret: string | null
  receiptProperty: string
  incidentProperty?: string
  rollbackReceiptProperty?: string
  pollTimeoutMs: number
  pollIntervalMs: number
  pollMaxAttempts: number
  leaseTtlMs: number
  operationTtlSeconds: number
  requestTimeoutMs: number
  healthTimeoutMs: number
  checkMaxAgeMs: number
  targets: TargetPolicy[]
}

export type ResultStatus =
  | "completed"
  | "no_op"
  | "blocked"
  | "conflict"
  | "partial_failure"
  | "ambiguous"
  | "rollback_recommended"

export interface HealthFailureEvidence extends Record<string, JsonValue> {
  path: string
  outcome: "transport_error" | "http_status"
  status: number | null
}

export interface AliasStateEvidence extends Record<string, JsonValue> {
  domain: string
  deploymentId: string | null
}

export interface PromotionIncidentReceipt {
  version: 1
  operationId: string
  status: "promotion_health_failed"
  teamId: string
  projectId: string
  candidateDeploymentId: string
  expectedPriorDeploymentId: string
  promotionApprovalPageId: string
  promotionApprovalRevision: string
  promotionApprovalFingerprint: string
  candidateGitSha: string
  candidateGitBranch: string
  rollbackTargetGitSha: string
  rollbackTargetGitBranch: string
  healthFailure: HealthFailureEvidence
  productionDomains: string[]
  aliasState: AliasStateEvidence[]
  observedAt: string
}

export interface PromotionResult extends Record<string, JsonValue> {
  ok: boolean
  operationId: string
  idempotencyKey: string
  status: ResultStatus
  changed: boolean
  replay: boolean
  preconditionsVerified: boolean
  promotionRequested: boolean
  receiptWritten: boolean
  records: ReceiptRecord[]
  steps: ReceiptStep[]
  warnings: string[]
  retryable: boolean
  retryAfterMs: number | null
  resumeToken: string | null
  repairInstruction: string | null
  teamId: string
  projectId: string
  deploymentId: string
  deploymentUrl: string | null
  previousDeploymentId: string | null
  currentDeploymentId: string | null
  gitSha: string
  gitBranch: string
  approvalPageId: string
  approvalRevision: string
  approvalFingerprint: string
  checkIds: string[]
  checkNames: string[]
  healthPaths: string[]
  productionDomains: string[]
  aliasState: AliasStateEvidence[]
  healthFailure: HealthFailureEvidence | null
  rollbackRequested: boolean
  incidentReceiptHash: string | null
  freshApprovalInstruction: string | null
  rollbackTargetGitSha: string | null
  rollbackTargetGitBranch: string | null
  residualRaceWarning: string
  startedAt: string
  completedAt: string | null
  message: string
}

export interface ReceiptRecord extends Record<string, JsonValue> {
  kind: "approval" | "project" | "deployment" | "production_domain"
  system: "notion" | "vercel"
  id: string
  url: string | null
  action: "verified" | "promoted" | "observed" | "routed" | "receipt_written"
  state: string
}

export interface ReceiptStep extends Record<string, JsonValue> {
  name: "approval" | "preflight" | "promotion" | "reconciliation" | "receipt"
  state: "completed" | "skipped" | "blocked" | "failed" | "pending"
}

export type OperationState =
  | "prepared"
  | "mutation_started"
  | "mutation_unknown"
  | "receipt_pending"
  | "complete"

export interface OperationRecord {
  version: 1
  operationId: string
  state: OperationState
  input: PromoteInput
  policy: TargetPolicy
  createdAt: string
  updatedAt: string
  mutationStartedAt: string | null
  promotionAcceptedAt: string | null
  mutationAttempts: number
  lastMutationStatus: number | null
  lastIssue: string | null
  result: PromotionResult | null
}

export interface RollbackInput {
  rollbackApprovalPageId: string
  rollbackApprovalRevision: string
  rollbackApprovalFingerprint: string
  originalPromotionOperationId: string
  promotionIncidentPageId: string
  originalIncidentReceiptHash: string
  teamId: string
  projectId: string
  candidateDeploymentId: string
  rollbackDeploymentId: string
}

export interface RollbackApprovalPacket {
  approvalStatus: "Approved"
  approvalRevision: string
  originalPromotionOperationId: string
  promotionIncidentPageId: string
  originalIncidentReceiptHash: string
  teamId: string
  projectId: string
  candidateDeploymentId: string
  rollbackDeploymentId: string
}

export interface RollbackApprovalSnapshot {
  pageId: string
  revision: string
  pageLastEditedTime: string
  fingerprint: string
  packet: RollbackApprovalPacket
  receiptText: string
}

export type RollbackResultStatus =
  | "completed"
  | "no_op"
  | "blocked"
  | "conflict"
  | "partial_failure"
  | "ambiguous"

export interface RollbackResult extends Record<string, JsonValue> {
  ok: boolean
  operationId: string
  idempotencyKey: string
  status: RollbackResultStatus
  changed: boolean
  replay: boolean
  preconditionsVerified: boolean
  rollbackRequested: boolean
  receiptWritten: boolean
  causality: "provider_accepted" | "observed_only" | "none"
  disposition:
    | "rolled_back"
    | "observed_restored"
    | "candidate_unchanged"
    | "split"
    | "third_deployment"
    | "unknown"
  rollbackRequestAccepted: boolean
  requestDisposition: "accepted" | "outcome_unknown" | "not_sent"
  resumeMode: "none" | "reconcile_only" | "receipt_only" | "complete"
  retryable: boolean
  retryAfterMs: number | null
  resumeToken: string | null
  repairInstruction: string | null
  originalPromotionOperationId: string
  originalIncidentReceiptHash: string
  teamId: string
  projectId: string
  candidateDeploymentId: string
  rollbackDeploymentId: string
  currentDeploymentId: string | null
  rollbackDeploymentUrl: string | null
  rollbackGitSha: string
  rollbackGitBranch: string
  promotionApprovalPageId: string
  promotionIncidentPageId: string
  rollbackApprovalPageId: string
  rollbackApprovalRevision: string
  rollbackApprovalFingerprint: string
  productionDomains: string[]
  aliasState: AliasStateEvidence[]
  healthPaths: string[]
  healthFailure: HealthFailureEvidence | null
  receiptWrittenAt: string | null
  startedAt: string
  completedAt: string | null
  warnings: string[]
  residualRaceWarning: string
  steps: Array<{
    name:
      | "incident"
      | "approval"
      | "preflight"
      | "rollback"
      | "reconciliation"
      | "receipt"
    state: "completed" | "skipped" | "blocked" | "failed" | "pending"
  }>
  message: string
}

export type RollbackOperationState =
  | "prepared"
  | "rollback_started"
  | "reconciliation_only"
  | "receipt_pending"
  | "complete"

export interface RollbackOperationRecord {
  version: 2
  kind: "rollback"
  operationId: string
  state: RollbackOperationState
  input: RollbackInput
  policy: TargetPolicy
  incident: PromotionIncidentReceipt
  claimId: string
  promotionOperationId: string
  promotionIncidentHash: string
  createdAt: string
  updatedAt: string
  rollbackStartedAt: string | null
  rollbackAcceptedAt: string | null
  mutationAttempts: 0 | 1
  requestDisposition: "accepted" | "outcome_unknown" | "not_sent"
  lastMutationStatus: number | null
  lastRetryAfterMs: number | null
  lastIssue: string | null
  result: RollbackResult | null
}

export type RollbackMutationClaimState =
  | "available"
  | "operation_fenced"
  | "sent"
  | "definitely_rejected"

export interface RollbackMutationClaim {
  version: 1
  kind: "rollback_mutation_claim"
  claimId: string
  state: RollbackMutationClaimState
  promotionOperationId: string
  promotionIncidentHash: string
  teamId: string
  projectId: string
  candidateDeploymentId: string
  rollbackDeploymentId: string
  activeOperationId: string | null
  attempts: number
  createdAt: string
  updatedAt: string
  sentAt: string | null
  definitelyRejectedAt: string | null
  lastMutationStatus: number | null
  lastRetryAfterMs: number | null
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

export interface RedisOperationStoreLike {
  acquireLease(key: string, token: string, ttlMs: number): Promise<boolean>
  renewLease(key: string, token: string, ttlMs: number): Promise<boolean>
  releaseLease(key: string, token: string): Promise<boolean>
  getOperation(operationId: string): Promise<OperationRecord | null>
  putOperation(
    record: OperationRecord,
    ttlSeconds: number | null
  ): Promise<void>
}

export interface RollbackRedisOperationStoreLike
  extends RedisOperationStoreLike {
  getRollbackOperation(
    operationId: string
  ): Promise<RollbackOperationRecord | null>
  putRollbackOperation(record: RollbackOperationRecord): Promise<void>
  getRollbackMutationClaim(
    claimId: string
  ): Promise<RollbackMutationClaim | null>
  putRollbackMutationClaim(claim: RollbackMutationClaim): Promise<void>
}

export interface VercelDeployment {
  id: string
  projectId?: string
  project?: { id?: string }
  teamId?: string
  readyState?: string
  readySubstate?: string
  target?: string | null
  url?: string
  checksState?: string
  checksConclusion?: string
  createdAt?: number
  readyAt?: number
  gitSource?: { ref?: string; sha?: string }
}

export interface VercelProjectAlias {
  domain?: string
  target?: string
  environment?: string
  deployment?: { id?: string }
}

export interface VercelProject {
  id: string
  accountId?: string
  alias?: VercelProjectAlias[]
  autoAssignCustomDomains?: boolean
}

export interface VercelCheckDefinition {
  id: string
  name: string
  projectId?: string
  targets?: string[]
  deletedAt?: number | null
}

export interface VercelCheckRun {
  id: string
  checkId?: string
  name: string
  deploymentId?: string
  projectId?: string
  status?: string
  conclusion?: string
  completedAt?: number
}

export interface PromotionObservation {
  project: VercelProject
  deployment: VercelDeployment
  productionDomains: string[]
  domainDeploymentIds: Record<string, string | null>
  aliasSetExact: boolean
  currentDeploymentId: string | null
  classification:
    | "target_current"
    | "expected_current"
    | "other_current"
    | "partial"
}

export interface VercelClientLike {
  getProject(teamId: string, projectId: string): Promise<VercelProject>
  getDeployment(teamId: string, deploymentId: string): Promise<VercelDeployment>
  getCheckDefinitions(
    teamId: string,
    projectId: string
  ): Promise<VercelCheckDefinition[]>
  getCheckRuns(teamId: string, deploymentId: string): Promise<VercelCheckRun[]>
  requestPromotion(
    teamId: string,
    projectId: string,
    deploymentId: string
  ): Promise<{ status: number }>
  checkHealth(deploymentUrl: string, paths: string[]): Promise<void>
}

export interface RollbackVercelClientLike extends VercelClientLike {
  getRollingRelease(teamId: string, projectId: string): Promise<unknown | null>
  requestRollback(
    teamId: string,
    projectId: string,
    deploymentId: string
  ): Promise<{ status: 201 }>
}

export interface RuntimeDependencies {
  notion: NotionClientLike
  store: RedisOperationStoreLike
  vercel: VercelClientLike
  now: () => Date
  sleep: (milliseconds: number) => Promise<void>
  randomToken: () => string
}

export interface RollbackRuntimeDependencies
  extends Omit<RuntimeDependencies, "store" | "vercel"> {
  store: RollbackRedisOperationStoreLike
  vercel: RollbackVercelClientLike
}

export class SafetyError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "SafetyError"
    this.code = code
  }
}

export class HealthCheckFailure extends SafetyError {
  readonly evidence: HealthFailureEvidence

  constructor(evidence: HealthFailureEvidence) {
    super(
      "HEALTH_CHECK_FAILED",
      evidence.outcome === "transport_error"
        ? `The fixed health path ${JSON.stringify(evidence.path)} timed out or failed.`
        : `The fixed health path ${JSON.stringify(evidence.path)} returned HTTP ${evidence.status}.`
    )
    this.name = "HealthCheckFailure"
    this.evidence = { ...evidence }
  }
}

export class VercelHttpError extends Error {
  readonly status: number | null
  readonly retryAfterMs: number | null
  readonly ambiguous: boolean

  constructor(
    message: string,
    options: {
      status?: number | null
      retryAfterMs?: number | null
      ambiguous?: boolean
    } = {}
  ) {
    super(message)
    this.name = "VercelHttpError"
    this.status = options.status ?? null
    this.retryAfterMs = options.retryAfterMs ?? null
    this.ambiguous = options.ambiguous ?? false
  }
}
