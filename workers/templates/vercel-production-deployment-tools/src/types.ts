export type TransitionAction = "promote" | "rollback"

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface WorkerConfig {
  vercelToken: string
  teamId: string
  projectId: string
  healthPaths: string[]
  protectionBypassSecret: string | null
}

export interface InspectInput {
  action: TransitionAction
  targetDeploymentId: string
}

export interface TransitionInput {
  targetDeploymentId: string
  expectedCurrentDeploymentId: string
  expectedGitSha: string | null
}

export interface InspectionResult extends Record<string, JsonValue> {
  ok: boolean
  status: "ready" | "already_live" | "blocked" | "conflict"
  action: TransitionAction
  targetDeploymentId: string
  targetUrl: string | null
  expectedGitSha: string | null
  targetReadySubstate: string | null
  expectedCurrentDeploymentId: string | null
  productionDomains: string[]
  deploymentChecks: "not_reported" | "passed" | "blocked"
  warning: string | null
  message: string
}

export interface TransitionResult extends Record<string, JsonValue> {
  ok: boolean
  status:
    | "completed"
    | "no_op"
    | "blocked"
    | "conflict"
    | "ambiguous"
    | "unhealthy"
  action: TransitionAction
  targetDeploymentId: string
  currentDeploymentId: string | null
  requestAttempted: boolean
  nextStep: string | null
  message: string
}

export interface VercelDeployment {
  id: string
  projectId: string
  teamId: string
  url: string
  target: string | null
  readyState: string
  readySubstate: string | null
  gitSha: string | null
  checksState: string | null
  checksConclusion: string | null
}

export interface ProductionObservation {
  currentDeploymentId: string | null
  domainDeploymentIds: Record<string, string>
  productionDomains: string[]
}

export type RollingReleaseState = "none" | "configured" | "active"

export interface VercelClientLike {
  getDeployment(
    teamId: string,
    projectId: string,
    deploymentId: string
  ): Promise<VercelDeployment>
  getRollingReleaseState(
    teamId: string,
    projectId: string
  ): Promise<RollingReleaseState>
  observeProduction(
    teamId: string,
    projectId: string
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
  vercel: VercelClientLike
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
  readonly ambiguous: boolean

  constructor(
    message: string,
    options: {
      status?: number | null
      ambiguous?: boolean
    } = {}
  ) {
    super(message)
    this.name = "VercelHttpError"
    this.status = options.status ?? null
    this.ambiguous = options.ambiguous ?? false
  }
}
