import type {
  DeploymentCheckPolicy,
  PromotionObservation,
  TargetPolicy,
  VercelCheckDefinition,
  VercelCheckRun,
  VercelClientLike,
  VercelDeployment,
  VercelProject,
  VercelProjectAlias,
} from "./types.js"
import {
  isDefinitePromotionRejectionStatus,
  SafetyError,
  VercelHttpError,
} from "./types.js"
import { DEPLOYMENT_HOSTNAME, DEPLOYMENT_ID, HOSTNAME } from "./config.js"

const API_ORIGIN = "https://api.vercel.com"
export const MAX_PROJECT_ALIAS_INVENTORY = 100

interface ClientOptions {
  token: string
  protectionBypassSecret: string | null
  requestTimeoutMs: number
  healthTimeoutMs: number
  fetchImpl?: typeof fetch
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => Date
}

function retryDelay(response: Response, now: Date): number {
  const retryAfter = response.headers.get("retry-after")
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000)
    const date = new Date(retryAfter)
    if (!Number.isNaN(date.getTime()))
      return Math.max(0, date.getTime() - now.getTime())
  }
  const reset = Number(response.headers.get("x-ratelimit-reset"))
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(0, reset * 1_000 - now.getTime())
  }
  return 250
}

async function jsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new VercelHttpError(
      `Vercel returned invalid JSON for a successful HTTP ${response.status} response.`,
      { status: response.status }
    )
  }
}

export class VercelClient implements VercelClientLike {
  private readonly token: string
  private readonly bypass: string | null
  private readonly requestTimeoutMs: number
  private readonly healthTimeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly now: () => Date

  constructor(options: ClientOptions) {
    this.token = options.token
    this.bypass = options.protectionBypassSecret
    this.requestTimeoutMs = options.requestTimeoutMs
    this.healthTimeoutMs = options.healthTimeoutMs
    this.fetchImpl = options.fetchImpl ?? fetch
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.now = options.now ?? (() => new Date())
  }

  private async read(path: string): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response
      try {
        response = await this.fetchImpl(`${API_ORIGIN}${path}`, {
          redirect: "manual",
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        })
      } catch {
        if (attempt < 2) {
          await this.sleep(250 * (attempt + 1))
          continue
        }
        throw new VercelHttpError("A Vercel read request timed out or failed.")
      }
      if (response.ok) return jsonBody(response)
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await this.sleep(Math.min(retryDelay(response, this.now()), 5_000))
        continue
      }
      throw new VercelHttpError(
        `Vercel read request failed with HTTP ${response.status}.`,
        {
          status: response.status,
          retryAfterMs: retryDelay(response, this.now()),
        }
      )
    }
    throw new VercelHttpError("Vercel read retry bound was exhausted.")
  }

  async getProject(teamId: string, projectId: string): Promise<VercelProject> {
    return (await this.read(
      `/v9/projects/${encodeURIComponent(projectId)}?teamId=${encodeURIComponent(teamId)}`
    )) as VercelProject
  }

  async getDeployment(
    teamId: string,
    deploymentId: string
  ): Promise<VercelDeployment> {
    return (await this.read(
      `/v13/deployments/${encodeURIComponent(deploymentId)}?withGitRepoInfo=true&teamId=${encodeURIComponent(teamId)}`
    )) as VercelDeployment
  }

  async getCheckDefinitions(
    teamId: string,
    projectId: string
  ): Promise<VercelCheckDefinition[]> {
    const response = (await this.read(
      `/v2/projects/${encodeURIComponent(projectId)}/checks?teamId=${encodeURIComponent(teamId)}`
    )) as { checks?: unknown }
    if (!Array.isArray(response.checks)) {
      throw new VercelHttpError("Vercel returned no check definitions array.")
    }
    return response.checks as VercelCheckDefinition[]
  }

  async getCheckRuns(
    teamId: string,
    deploymentId: string
  ): Promise<VercelCheckRun[]> {
    const response = (await this.read(
      `/v2/deployments/${encodeURIComponent(deploymentId)}/check-runs?teamId=${encodeURIComponent(teamId)}`
    )) as { runs?: unknown }
    if (!Array.isArray(response.runs)) {
      throw new VercelHttpError(
        "Vercel returned no deployment check-runs array."
      )
    }
    return response.runs as VercelCheckRun[]
  }

  async requestPromotion(
    teamId: string,
    projectId: string,
    deploymentId: string
  ): Promise<{ status: number }> {
    let response: Response
    try {
      response = await this.fetchImpl(
        `${API_ORIGIN}/v10/projects/${encodeURIComponent(projectId)}/promote/${encodeURIComponent(deploymentId)}?teamId=${encodeURIComponent(teamId)}`,
        {
          method: "POST",
          redirect: "manual",
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        }
      )
    } catch {
      throw new VercelHttpError(
        "The promotion request outcome is unknown because the connection failed or timed out.",
        { ambiguous: true }
      )
    }
    if (response.status === 201 || response.status === 202) {
      // Do not parse or expose the provider response; reconciliation is authoritative.
      await response.body?.cancel().catch(() => undefined)
      return { status: response.status }
    }
    await response.body?.cancel().catch(() => undefined)
    throw new VercelHttpError(
      `Vercel promotion returned HTTP ${response.status}; the Worker will reconcile before any future action.`,
      {
        status: response.status,
        retryAfterMs: retryDelay(response, this.now()),
        ambiguous: !isDefinitePromotionRejectionStatus(response.status),
      }
    )
  }

  async checkHealth(deploymentUrl: string, paths: string[]): Promise<void> {
    if (!DEPLOYMENT_HOSTNAME.test(deploymentUrl)) {
      throw new SafetyError(
        "DEPLOYMENT_URL_UNSAFE",
        "Vercel returned a deployment URL outside the fixed vercel.app/now.sh host boundary."
      )
    }
    for (const path of paths) {
      const url = `https://${deploymentUrl}${path}`
      let response: Response
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          redirect: "manual",
          headers: this.bypass
            ? { "x-vercel-protection-bypass": this.bypass }
            : undefined,
          signal: AbortSignal.timeout(this.healthTimeoutMs),
        })
      } catch {
        throw new SafetyError(
          "HEALTH_CHECK_FAILED",
          `The fixed health path ${JSON.stringify(path)} timed out or failed.`
        )
      }
      await response.body?.cancel().catch(() => undefined)
      if (response.status < 200 || response.status >= 300) {
        throw new SafetyError(
          "HEALTH_CHECK_FAILED",
          `The fixed health path ${JSON.stringify(path)} returned HTTP ${response.status}.`
        )
      }
    }
  }
}

function deploymentProjectId(deployment: VercelDeployment): string | undefined {
  return deployment.projectId ?? deployment.project?.id
}

interface ProductionAliasInventory {
  productionDomains: string[]
  domainDeploymentIds: Record<string, string | null>
  exactPolicyMatch: boolean
}

export class ProjectAliasSetMismatchError extends SafetyError {
  readonly productionDomains: string[]
  readonly domainDeploymentIds: Record<string, string | null>

  constructor(inventory: ProductionAliasInventory) {
    super(
      "PROJECT_ALIAS_SET_MISMATCH",
      "Vercel's complete production alias set does not exactly equal the fixed production-domain policy."
    )
    this.name = "ProjectAliasSetMismatchError"
    this.productionDomains = [...inventory.productionDomains]
    this.domainDeploymentIds = { ...inventory.domainDeploymentIds }
  }
}

function isProductionAlias(alias: VercelProjectAlias): boolean {
  return (
    alias.target?.toUpperCase() === "PRODUCTION" ||
    alias.environment?.toLowerCase() === "production"
  )
}

function aliasesForPolicy(
  project: VercelProject,
  policy: TargetPolicy
): ProductionAliasInventory {
  if (!Array.isArray(project.alias)) {
    throw new SafetyError(
      "PROJECT_ALIASES_MISSING",
      "Vercel did not return the project's configured alias mappings."
    )
  }
  if (project.alias.length > MAX_PROJECT_ALIAS_INVENTORY) {
    throw new SafetyError(
      "PROJECT_ALIAS_INVENTORY_TOO_LARGE",
      `Vercel returned more than the supported ${MAX_PROJECT_ALIAS_INVENTORY} project aliases; no alias values were retained.`
    )
  }
  const productionAliases = project.alias.filter(isProductionAlias)
  for (const alias of productionAliases) {
    if (
      typeof alias.domain !== "string" ||
      alias.domain !== alias.domain.toLowerCase() ||
      !HOSTNAME.test(alias.domain)
    ) {
      throw new SafetyError(
        "PROJECT_ALIAS_SET_MALFORMED",
        "Vercel returned an invalid or unbounded production alias domain."
      )
    }
    const deployment = alias.deployment
    if (
      deployment !== undefined &&
      (deployment === null ||
        typeof deployment !== "object" ||
        Array.isArray(deployment))
    ) {
      throw new SafetyError(
        "PROJECT_ALIAS_SET_MALFORMED",
        "Vercel returned an invalid production alias deployment mapping."
      )
    }
    const deploymentId = deployment?.id
    if (
      deploymentId !== undefined &&
      (typeof deploymentId !== "string" || !DEPLOYMENT_ID.test(deploymentId))
    ) {
      throw new SafetyError(
        "PROJECT_ALIAS_SET_MALFORMED",
        "Vercel returned an invalid or unbounded production alias deployment ID."
      )
    }
  }

  const observedDomains = productionAliases.map((alias) => alias.domain!)
  const productionDomains = [
    ...new Set([...policy.productionDomains, ...observedDomains]),
  ].sort()
  const domainDeploymentIds: Record<string, string | null> = {}
  let noDuplicates = true
  for (const domain of productionDomains) {
    const matches = productionAliases.filter((alias) => alias.domain === domain)
    if (matches.length !== 1) noDuplicates = false
    domainDeploymentIds[domain] =
      matches.length === 1 ? (matches[0].deployment?.id ?? null) : null
  }

  const configured = [...policy.productionDomains].sort()
  const observed = [...new Set(observedDomains)].sort()
  const exactPolicyMatch =
    noDuplicates &&
    configured.length === observed.length &&
    configured.every((domain, index) => domain === observed[index])
  return {
    productionDomains,
    domainDeploymentIds,
    exactPolicyMatch,
  }
}

function assertProjectIdentity(
  project: VercelProject,
  teamId: string,
  projectId: string
): void {
  if (project.id !== projectId || project.accountId !== teamId) {
    throw new SafetyError(
      "PROJECT_IDENTITY_MISMATCH",
      "Vercel returned a project outside the exact approved team/project identity."
    )
  }
}

function assertDeploymentIdentity(
  deployment: VercelDeployment,
  teamId: string,
  projectId: string,
  deploymentId: string
): void {
  if (
    deployment.id !== deploymentId ||
    deployment.teamId !== teamId ||
    deploymentProjectId(deployment) !== projectId
  ) {
    throw new SafetyError(
      "DEPLOYMENT_IDENTITY_MISMATCH",
      "Vercel returned a deployment outside the exact approved team/project identity."
    )
  }
  if (deployment.url === undefined) {
    throw new SafetyError(
      "DEPLOYMENT_URL_MISSING",
      "Vercel returned no canonical deployment URL for verification."
    )
  }
  if (!DEPLOYMENT_HOSTNAME.test(deployment.url)) {
    throw new SafetyError(
      "DEPLOYMENT_URL_UNSAFE",
      "Vercel returned a deployment URL outside the canonical vercel.app/now.sh hostname boundary."
    )
  }
}

export function verifyStagedDeployment(options: {
  project: VercelProject
  deployment: VercelDeployment
  policy: TargetPolicy
  teamId: string
  projectId: string
  deploymentId: string
  expectedGitSha: string
  expectedGitBranch: string
  expectedCurrentDeploymentId: string
}): Record<string, string | null> {
  const {
    project,
    deployment,
    policy,
    teamId,
    projectId,
    deploymentId,
    expectedGitSha,
    expectedGitBranch,
    expectedCurrentDeploymentId,
  } = options
  assertProjectIdentity(project, teamId, projectId)
  assertDeploymentIdentity(deployment, teamId, projectId, deploymentId)
  if (deployment.target !== "production") {
    throw new SafetyError(
      "DEPLOYMENT_NOT_PRODUCTION",
      "The exact deployment target must be production."
    )
  }
  if (
    deployment.readyState !== "READY" ||
    deployment.readySubstate !== "STAGED"
  ) {
    throw new SafetyError(
      "DEPLOYMENT_NOT_STAGED",
      "The exact deployment must be READY with readySubstate STAGED."
    )
  }
  if (
    deployment.gitSource?.sha !== expectedGitSha ||
    deployment.gitSource?.ref !== expectedGitBranch
  ) {
    throw new SafetyError(
      "GIT_IDENTITY_MISMATCH",
      "The deployment Git SHA or branch differs from the approved identity."
    )
  }
  const inventory = aliasesForPolicy(project, policy)
  if (!inventory.exactPolicyMatch) {
    throw new ProjectAliasSetMismatchError(inventory)
  }
  const mappings = inventory.domainDeploymentIds
  if (
    Object.values(mappings).some(
      (current) => current !== expectedCurrentDeploymentId
    )
  ) {
    throw new SafetyError(
      "EXPECTED_CURRENT_MISMATCH",
      "At least one production domain no longer points to the approved current deployment."
    )
  }
  return mappings
}

export function verifyPromotedDeploymentIdentity(options: {
  deployment: VercelDeployment
  teamId: string
  projectId: string
  deploymentId: string
  expectedGitSha: string
  expectedGitBranch: string
}): void {
  const {
    deployment,
    teamId,
    projectId,
    deploymentId,
    expectedGitSha,
    expectedGitBranch,
  } = options
  assertDeploymentIdentity(deployment, teamId, projectId, deploymentId)
  if (
    deployment.target !== "production" ||
    deployment.readyState !== "READY" ||
    deployment.readySubstate !== "PROMOTED"
  ) {
    throw new SafetyError(
      "DEPLOYMENT_NOT_PROMOTED",
      "The exact deployment must be a READY/PROMOTED production deployment."
    )
  }
  if (
    deployment.gitSource?.sha !== expectedGitSha ||
    deployment.gitSource?.ref !== expectedGitBranch
  ) {
    throw new SafetyError(
      "GIT_IDENTITY_MISMATCH",
      "The promoted deployment Git SHA or branch differs from the approved identity."
    )
  }
}

function findDefinition(
  definitions: VercelCheckDefinition[],
  check: DeploymentCheckPolicy,
  projectId: string
): VercelCheckDefinition {
  const matches = definitions.filter(
    (definition) =>
      definition.id === check.id &&
      definition.deletedAt == null &&
      (definition.projectId === undefined || definition.projectId === projectId)
  )
  if (matches.length !== 1) {
    throw new SafetyError(
      "CHECK_DEFINITION_MISMATCH",
      `Expected exactly one active Deployment Check definition for stable ID ${check.id}.`
    )
  }
  const definition = matches[0]
  if (check.name !== null && definition.name !== check.name) {
    throw new SafetyError(
      "CHECK_DEFINITION_MISMATCH",
      `Deployment Check ${check.id} was renamed from the configured name.`
    )
  }
  return definition
}

export function verifyDeploymentChecks(options: {
  definitions: VercelCheckDefinition[]
  runs: VercelCheckRun[]
  policy: TargetPolicy
  deployment: VercelDeployment
  projectId: string
  now: Date
  maxAgeMs: number
}): void {
  const { definitions, runs, policy, deployment, projectId, now, maxAgeMs } =
    options
  if (
    deployment.checksState !== "completed" ||
    deployment.checksConclusion !== "succeeded"
  ) {
    throw new SafetyError(
      "DEPLOYMENT_CHECKS_INCOMPLETE",
      "The deployment aggregate check state must be completed/succeeded."
    )
  }
  const earliest = deployment.createdAt ?? deployment.readyAt
  if (earliest === undefined) {
    throw new SafetyError(
      "DEPLOYMENT_CHECKS_INCOMPLETE",
      "The deployment has no timestamp for check-run freshness validation."
    )
  }

  for (const policyCheck of policy.deploymentChecks) {
    const definition = findDefinition(definitions, policyCheck, projectId)
    const candidates = runs
      .filter(
        (run) =>
          run.checkId === definition.id &&
          run.deploymentId === deployment.id &&
          run.projectId === projectId
      )
      .sort((left, right) => (right.completedAt ?? 0) - (left.completedAt ?? 0))
    const run = candidates[0]
    if (!run) {
      throw new SafetyError(
        "DEPLOYMENT_CHECK_MISSING",
        `Deployment Check ${definition.id} has no run for this deployment.`
      )
    }
    if (
      run.name !== definition.name ||
      run.status !== "completed" ||
      run.conclusion !== "succeeded" ||
      run.completedAt === undefined ||
      run.completedAt < earliest ||
      run.completedAt < now.getTime() - maxAgeMs ||
      run.completedAt > now.getTime() + 300_000
    ) {
      throw new SafetyError(
        "DEPLOYMENT_CHECK_FAILED",
        `Deployment Check ${definition.id} is not a fresh completed/succeeded run.`
      )
    }
  }
}

export async function observePromotion(
  vercel: VercelClientLike,
  policy: TargetPolicy,
  expectedCurrentDeploymentId: string,
  deploymentId: string
): Promise<PromotionObservation> {
  const [project, deployment] = await Promise.all([
    vercel.getProject(policy.teamId, policy.projectId),
    vercel.getDeployment(policy.teamId, deploymentId),
  ])
  assertProjectIdentity(project, policy.teamId, policy.projectId)
  assertDeploymentIdentity(
    deployment,
    policy.teamId,
    policy.projectId,
    deploymentId
  )
  const inventory = aliasesForPolicy(project, policy)
  const { domainDeploymentIds } = inventory
  const ids = Object.values(domainDeploymentIds)
  const unique = new Set(ids)
  const allTarget = ids.every((id) => id === deploymentId)
  const allExpected = ids.every((id) => id === expectedCurrentDeploymentId)
  let classification: PromotionObservation["classification"]
  if (!inventory.exactPolicyMatch) classification = "partial"
  else if (allTarget) classification = "target_current"
  else if (allExpected) classification = "expected_current"
  else if (unique.size === 1 && ids[0] !== null)
    classification = "other_current"
  else classification = "partial"
  return {
    project,
    deployment,
    productionDomains: inventory.productionDomains,
    domainDeploymentIds,
    aliasSetExact: inventory.exactPolicyMatch,
    currentDeploymentId: unique.size === 1 ? ids[0] : null,
    classification,
  }
}

export function verifyPromotedObservation(
  observation: PromotionObservation
): void {
  if (
    observation.classification !== "target_current" ||
    observation.deployment.readyState !== "READY" ||
    observation.deployment.readySubstate !== "PROMOTED"
  ) {
    throw new SafetyError(
      "PROMOTION_NOT_CONVERGED",
      "Production aliases and the deployment did not converge to READY/PROMOTED."
    )
  }
}
