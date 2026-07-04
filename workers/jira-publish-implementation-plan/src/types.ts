export type PlanNode = {
  nodeKey: string
  issueTypeId: string
  parentNodeKey: string | null
  summary: string
  description: string
  assigneeAccountId: string | null
  labels: string[]
  estimatePoints: number | null
  sprintId: number | null
  fixVersionId: string | null
}

export type PlanDependency = {
  blockerNodeKey: string
  blockedNodeKey: string
}

export type PublishImplementationPlanInput = {
  approvalPageId: string
  approvalRevision: string
  planHash: string
  projectKey: string
  nodes: PlanNode[]
  dependencies: PlanDependency[]
}

export type ReceiptStatus =
  | "completed"
  | "no_op"
  | "blocked"
  | "conflict"
  | "partial_failure"
  | "ambiguous"

export type NodeAction = "created" | "existing" | "failed" | "unknown"

export type NodeRecord = {
  nodeKey: string
  issueId: string | null
  issueKey: string | null
  url: string | null
  action: NodeAction
}

export type DependencyRecord = {
  blockerNodeKey: string
  blockedNodeKey: string
  action: "created" | "existing" | "failed" | "unknown"
}

export type ReceiptStep = {
  name:
    | "approval"
    | "claim"
    | "metadata"
    | "nodes"
    | "dependencies"
    | "notion_receipt"
  status: "completed" | "skipped" | "failed" | "unknown"
  detail: string
}

export type PublishReceipt = {
  ok: boolean
  status: ReceiptStatus
  operationId: string
  idempotencyKey: string
  changed: boolean
  replay: boolean
  projectKey: string
  planHash: string
  approvalPageId: string
  approvalRevision: string
  providerPolicyFingerprint: string
  startedAt: string
  completedAt: string | null
  nodes: NodeRecord[]
  dependencies: DependencyRecord[]
  notionReceiptWritten: boolean
  steps: ReceiptStep[]
  warnings: string[]
  retryable: boolean
  retryAfterSeconds: number | null
  repair: string | null
}

export type RequestDisposition =
  | "not_sent"
  | "fenced"
  | "outcome_unknown"
  | "accepted"
  | "definitely_rejected"

export type DurableNode = {
  nodeKey: string
  issueId: string | null
  issueKey: string | null
  url: string | null
  marker: string
  status: "pending" | "unknown" | "created" | "existing"
  attempt: number
  requestDisposition: RequestDisposition
}

export type DurableDependency = {
  blockerNodeKey: string
  blockedNodeKey: string
  status: "pending" | "unknown" | "created" | "existing"
  attempt: number
  requestDisposition: RequestDisposition
}

export type OperationStage =
  | "claimed"
  | "publishing_nodes"
  | "publishing_dependencies"
  | "writing_receipt"
  | "completed"

export type OperationState = {
  version: 2
  operationId: string
  idempotencyKey: string
  planHash: string
  sourcePageId: string
  approvalRevision: string
  projectKey: string
  providerPolicyFingerprint: string
  stage: OperationStage
  nodes: DurableNode[]
  dependencies: DurableDependency[]
  receipt: PublishReceipt | null
  receiptJson: string | null
  startedAt: string
  updatedAt: string
}

export type ProjectPolicy = {
  projectKey: string
  projectId: string
  issueTypeIds: Set<string>
  parentTypePairs: Set<string>
  assigneeAccountIds: Set<string>
  labels: Set<string>
  fixVersionIds: Set<string>
  sprintIds: Set<number>
  fieldIds: {
    estimate: string | null
    sprint: string | null
  }
}
