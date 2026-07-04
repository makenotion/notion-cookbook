export type TransitionAction = "promote" | "rollback"
export type ApprovalAction = "Promote" | "Rollback"
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export type TransitionStatus =
  | "completed"
  | "no_op"
  | "blocked"
  | "conflict"
  | "ambiguous"

export interface TransitionInput {
  approvalPageId: string
}

export interface TransitionResult extends Record<string, JsonValue> {
  ok: boolean
  status: TransitionStatus
  action: TransitionAction
  operationId: string
  changed: boolean
  requestAttempted: boolean
  receiptState: "none" | TransitionReceipt["state"]
  targetDeploymentId: string | null
  currentDeploymentId: string | null
  retryable: boolean
  nextStep: string | null
  message: string
}

export interface WorkerConfig {
  vercelToken: string
  teamId: string
  projectId: string
  productionDomains: string[]
  deploymentCheckIds: string[]
  healthPaths: string[]
  approvalParentId: string
  protectionBypassSecret: string | null
}

/** Values read from the configured Notion approval database. */
export interface ApprovalSnapshot {
  pageId: string
  action: ApprovalAction
  revision: string
  teamId: string
  projectId: string
  expectedCurrentDeploymentId: string
  targetDeploymentId: string
  gitSha: string
  operationId: string
  receipt: TransitionReceipt | null
}

/** A compact receipt doubles as the durable no-repost marker on the page. */
export interface TransitionReceipt {
  version: 1
  operationId: string
  state: "request_started" | "completed" | "rejected" | "cancelled"
  action: ApprovalAction
  approvalRevision: string
  targetDeploymentId: string
  updatedAt: string
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

export interface VercelDeployment {
  id: string
  projectId: string
  teamId: string
  url: string
  readyState: string
  gitSha: string
}

export interface ProductionObservation {
  currentDeploymentId: string | null
  domainDeploymentIds: Record<string, string | null>
  exactDomainSet: boolean
}

/** Provider operations required by the shared transition workflow. */
export interface VercelClientLike {
  assertRollingReleasesDisabled(
    teamId: string,
    projectId: string
  ): Promise<void>
  verifyDeployment(
    teamId: string,
    projectId: string,
    deploymentId: string,
    expectedGitSha: string,
    expectedState: "staged" | "promoted"
  ): Promise<VercelDeployment>
  verifyDeploymentChecks(
    teamId: string,
    projectId: string,
    deploymentId: string,
    requiredCheckIds: string[]
  ): Promise<void>
  observeProduction(
    teamId: string,
    projectId: string,
    productionDomains: string[]
  ): Promise<ProductionObservation>
  checkDeploymentHealth(hostname: string, paths: string[]): Promise<void>
  checkProductionHealth(domains: string[], paths: string[]): Promise<void>
  requestTransition(
    action: TransitionAction,
    teamId: string,
    projectId: string,
    targetDeploymentId: string
  ): Promise<void>
}

export interface TransitionDependencies {
  notion: NotionClientLike
  vercel: VercelClientLike
  now: () => Date
  sleep: (milliseconds: number) => Promise<void>
}

export class SafetyError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "SafetyError"
    this.code = code
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
