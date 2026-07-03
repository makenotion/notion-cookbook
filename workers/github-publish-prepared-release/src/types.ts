export type CheckKind = "check_run"
export type MakeLatest = "true" | "false" | "legacy"

export type RequiredCheck = {
  kind: CheckKind
  name: string
  appId: number
}

export type RequiredAsset = {
  name: string
  sizeBytes: number
  sha256: string
}

export type PublishPreparedReleaseInput = {
  approvalPageId: string
  approvalRevision: string
  approvalFingerprint: string
  repository: string
  releaseId: number
  tag: string
  targetCommit: string
  nameSha256: string
  bodySha256: string
  prerelease: boolean
  makeLatest: MakeLatest
  requiredChecks: RequiredCheck[]
  requiredAssets: RequiredAsset[]
}

export type ReceiptStatus =
  | "completed"
  | "no_op"
  | "blocked"
  | "conflict"
  | "partial_failure"
  | "ambiguous"

export type StepStatus = "completed" | "skipped" | "failed" | "unknown"

export type ReceiptStep = {
  name: string
  status: StepStatus
  detail: string
}

export type ReceiptRecord = {
  system: "github" | "notion"
  kind: "release" | "release_packet"
  id: string
  url: string
  action: "published" | "observed" | "receipt_written"
}

export type PublishReceipt = {
  ok: boolean
  status: ReceiptStatus
  operationId: string
  idempotencyKey: string
  changed: boolean
  replay: boolean
  published: boolean
  records: ReceiptRecord[]
  steps: ReceiptStep[]
  warnings: string[]
  retryable: boolean
  resumeToken: string | null
  repair: string | null
}

export type ReleaseRecord = {
  releaseId: number
  repositoryId: number
  repository: string
  tag: string
  targetCommit: string
  url: string
  nameSha256: string
  bodySha256: string
  prerelease: boolean
  publishedAt: string
}

export type OperationStage = "claimed" | "published" | "completed"

export type OperationState = {
  version: 1
  operationId: string
  idempotencyKey: string
  inputFingerprint: string
  stage: OperationStage
  release: ReleaseRecord | null
  receipt: PublishReceipt | null
  receiptJson: string | null
  updatedAt: string
}
