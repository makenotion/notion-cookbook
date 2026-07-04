import type {
  ProductionObservation,
  TransitionAction,
  VercelClientLike,
  VercelDeployment,
} from "./types.js"
import { SafetyError, VercelHttpError } from "./types.js"
import { DEPLOYMENT_ID, GIT_SHA, HOSTNAME } from "./config.js"

const API_ORIGIN = "https://api.vercel.com"
const DEPLOYMENT_HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:vercel\.app|now\.sh)$/

export const MAX_VERCEL_RESPONSE_BYTES = 1_048_576
export const MAX_CHECK_DEFINITIONS = 100
export const MAX_CHECK_RUNS = 100
export const MAX_PROJECT_ALIAS_INVENTORY = 100
export const MAX_PRODUCTION_HEALTH_DOMAINS = 5

export interface VercelClientOptions {
  token: string
  protectionBypassSecret: string | null
  requestTimeoutMs?: number
  healthTimeoutMs?: number
  fetchImpl?: typeof fetch
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => Date
}

export interface VercelProject {
  id: string
  accountId?: string
  alias?: Array<{
    domain?: string
    target?: string
    environment?: string
    deployment?: { id?: string } | null
  }>
}

export interface VercelCheckDefinition {
  id?: string
  projectId?: string
  deletedAt?: number | null
}

export interface VercelCheckRun {
  checkId?: string
  deploymentId?: string
  projectId?: string
  status?: string
  conclusion?: string
  completedAt?: number
}

interface RawDeployment {
  id?: string
  projectId?: string
  project?: { id?: string }
  teamId?: string
  url?: string
  target?: string | null
  readyState?: string
  readySubstate?: string
  checksState?: string
  checksConclusion?: string
  gitSource?: { sha?: string }
}

function fail(code: string, message: string): never {
  throw new SafetyError(code, message)
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
  if (Number.isFinite(reset) && reset > 0)
    return Math.max(0, reset * 1_000 - now.getTime())
  return 250
}

async function disposeBody(response: Response): Promise<void> {
  if (!response.body) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      response.body.cancel().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 100)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new VercelHttpError("Vercel returned an empty successful response.", {
      status: response.status,
    })
  }
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_VERCEL_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined)
        throw new VercelHttpError(
          `Vercel returned a successful response larger than the ${MAX_VERCEL_RESPONSE_BYTES}-byte limit.`,
          { status: response.status }
        )
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof VercelHttpError) throw error
    throw new VercelHttpError(
      "A successful Vercel response could not be read.",
      {
        status: response.status,
      }
    )
  } finally {
    reader.releaseLock()
  }
  try {
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new VercelHttpError("Vercel returned invalid JSON.", {
      status: response.status,
    })
  }
}

export class VercelClient implements VercelClientLike {
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly now: () => Date

  constructor(private readonly options: VercelClientOptions) {
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
            Authorization: `Bearer ${this.options.token}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 10_000),
        })
      } catch {
        if (attempt + 1 < 3) {
          await this.sleep(250 * (attempt + 1))
          continue
        }
        throw new VercelHttpError("A Vercel read request timed out or failed.")
      }
      if (response.ok) return boundedJson(response)
      const retryAfterMs = retryDelay(response, this.now())
      await disposeBody(response)
      if (
        (response.status === 429 || response.status >= 500) &&
        attempt + 1 < 3 &&
        retryAfterMs <= 5_000
      ) {
        await this.sleep(retryAfterMs)
        continue
      }
      throw new VercelHttpError(
        `Vercel read request failed with HTTP ${response.status}.`,
        { status: response.status, retryAfterMs }
      )
    }
    throw new VercelHttpError("Vercel read retry bound was exhausted.")
  }

  private async getRawDeployment(
    teamId: string,
    deploymentId: string
  ): Promise<RawDeployment> {
    return (await this.read(
      `/v13/deployments/${encodeURIComponent(deploymentId)}?withGitRepoInfo=true&teamId=${encodeURIComponent(teamId)}`
    )) as RawDeployment
  }

  private async getCollection<T>(
    path: string,
    key: string,
    limit: number
  ): Promise<T[]> {
    const body = (await this.read(path)) as Record<string, unknown>
    const values = body[key]
    if (!Array.isArray(values)) {
      throw new VercelHttpError(`Vercel returned no ${key} array.`)
    }
    if (values.length > limit) {
      throw new VercelHttpError(`Vercel returned more than ${limit} ${key}.`)
    }
    return values as T[]
  }

  async verifyDeployment(
    teamId: string,
    projectId: string,
    deploymentId: string,
    expectedGitSha: string,
    expectedState: "staged" | "promoted"
  ): Promise<VercelDeployment> {
    const raw = await this.getRawDeployment(teamId, deploymentId)
    const deployment = normalizeDeployment(raw, teamId, projectId, deploymentId)
    if (
      raw.target !== "production" ||
      raw.readyState !== "READY" ||
      raw.readySubstate !== expectedState.toUpperCase()
    ) {
      fail(
        "DEPLOYMENT_STATE_MISMATCH",
        `The deployment must be READY/${expectedState.toUpperCase()} with a production target.`
      )
    }
    if (!GIT_SHA.test(expectedGitSha) || deployment.gitSha !== expectedGitSha) {
      fail(
        "GIT_IDENTITY_MISMATCH",
        "The deployment Git SHA differs from the approved identity."
      )
    }
    return deployment
  }

  async verifyDeploymentChecks(
    teamId: string,
    projectId: string,
    deploymentId: string,
    requiredCheckIds: string[]
  ): Promise<void> {
    if (requiredCheckIds.length === 0) return
    if (
      requiredCheckIds.length > 20 ||
      new Set(requiredCheckIds).size !== requiredCheckIds.length
    ) {
      fail(
        "DEPLOYMENT_CHECKS_INVALID",
        "Required Deployment Check IDs are duplicated or unbounded."
      )
    }
    const [deployment, definitions, runs] = await Promise.all([
      this.getRawDeployment(teamId, deploymentId),
      this.getCollection<VercelCheckDefinition>(
        `/v2/projects/${encodeURIComponent(projectId)}/checks?teamId=${encodeURIComponent(teamId)}`,
        "checks",
        MAX_CHECK_DEFINITIONS
      ),
      this.getCollection<VercelCheckRun>(
        `/v2/deployments/${encodeURIComponent(deploymentId)}/check-runs?teamId=${encodeURIComponent(teamId)}`,
        "runs",
        MAX_CHECK_RUNS
      ),
    ])
    normalizeDeployment(deployment, teamId, projectId, deploymentId)
    if (
      deployment.checksState !== "completed" ||
      deployment.checksConclusion !== "succeeded"
    ) {
      fail(
        "DEPLOYMENT_CHECKS_INCOMPLETE",
        "The deployment aggregate check state is not completed/succeeded."
      )
    }
    verifyCheckRuns(
      definitions,
      runs,
      requiredCheckIds,
      projectId,
      deploymentId
    )
  }

  async assertRollingReleasesDisabled(
    teamId: string,
    projectId: string
  ): Promise<void> {
    const [configuration, activeState] = await Promise.all([
      this.read(
        `/v1/projects/${encodeURIComponent(projectId)}/rolling-release/config?teamId=${encodeURIComponent(teamId)}`
      ),
      this.read(
        `/v1/projects/${encodeURIComponent(projectId)}/rolling-release?teamId=${encodeURIComponent(teamId)}&state=ACTIVE`
      ),
    ])
    assertRollingReleaseWrapper(configuration, "configured")
    assertRollingReleaseWrapper(activeState, "active")
  }

  async observeProduction(
    teamId: string,
    projectId: string,
    productionDomains: string[]
  ): Promise<ProductionObservation> {
    return observeProject(
      (await this.read(
        `/v9/projects/${encodeURIComponent(projectId)}?teamId=${encodeURIComponent(teamId)}`
      )) as VercelProject,
      teamId,
      projectId,
      productionDomains
    )
  }

  async requestTransition(
    action: TransitionAction,
    teamId: string,
    projectId: string,
    targetDeploymentId: string
  ): Promise<void> {
    const description = `Notion-approved rollback to ${targetDeploymentId}`
    const path =
      action === "promote"
        ? `/v10/projects/${encodeURIComponent(projectId)}/promote/${encodeURIComponent(targetDeploymentId)}?teamId=${encodeURIComponent(teamId)}`
        : `/v1/projects/${encodeURIComponent(projectId)}/rollback/${encodeURIComponent(targetDeploymentId)}?teamId=${encodeURIComponent(teamId)}&description=${encodeURIComponent(description)}`
    let response: Response
    try {
      response = await this.fetchImpl(`${API_ORIGIN}${path}`, {
        method: "POST",
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 10_000),
      })
    } catch {
      throw new VercelHttpError(
        `The ${action} request outcome is unknown because the connection failed or timed out.`,
        { ambiguous: true }
      )
    }
    const retryAfterMs = retryDelay(response, this.now())
    await disposeBody(response)
    const accepted =
      action === "promote"
        ? response.status === 201 || response.status === 202
        : response.status === 201
    if (accepted) return
    const definite =
      action === "promote"
        ? [400, 401, 403, 429]
        : [400, 401, 402, 403, 422, 429]
    throw new VercelHttpError(
      `Vercel ${action} returned HTTP ${response.status}; reconcile before retrying.`,
      {
        status: response.status,
        retryAfterMs: Math.min(retryAfterMs, 300_000),
        ambiguous: !definite.includes(response.status),
      }
    )
  }

  async checkDeploymentHealth(
    hostname: string,
    paths: string[]
  ): Promise<void> {
    if (!DEPLOYMENT_HOSTNAME.test(hostname)) {
      fail(
        "DEPLOYMENT_URL_UNSAFE",
        "The deployment hostname is outside vercel.app/now.sh."
      )
    }
    await this.checkHosts([hostname], paths, true)
  }

  async checkProductionHealth(
    domains: string[],
    paths: string[]
  ): Promise<void> {
    assertDomains(domains)
    await this.checkHosts(domains, paths, false)
  }

  private async checkHosts(
    hosts: string[],
    paths: string[],
    useProtectionBypass: boolean
  ): Promise<void> {
    assertHealthPaths(paths)
    await Promise.all(
      hosts.flatMap((host) =>
        paths.map(async (path) => {
          let response: Response
          try {
            response = await this.fetchImpl(`https://${host}${path}`, {
              method: "GET",
              redirect: "manual",
              headers:
                useProtectionBypass && this.options.protectionBypassSecret
                  ? {
                      "x-vercel-protection-bypass":
                        this.options.protectionBypassSecret,
                    }
                  : undefined,
              signal: AbortSignal.timeout(
                this.options.healthTimeoutMs ?? 5_000
              ),
            })
          } catch {
            fail(
              "HEALTH_CHECK_FAILED",
              `Health check ${JSON.stringify(host + path)} timed out or failed.`
            )
          }
          await disposeBody(response)
          if (response.status < 200 || response.status >= 300) {
            fail(
              "HEALTH_CHECK_FAILED",
              `Health check ${JSON.stringify(host + path)} returned HTTP ${response.status}.`
            )
          }
        })
      )
    )
  }
}

function normalizeDeployment(
  raw: RawDeployment,
  teamId: string,
  projectId: string,
  deploymentId: string
): VercelDeployment {
  if (
    raw.id !== deploymentId ||
    raw.teamId !== teamId ||
    (raw.projectId ?? raw.project?.id) !== projectId
  ) {
    fail(
      "DEPLOYMENT_IDENTITY_MISMATCH",
      "Vercel returned a deployment outside the configured team/project identity."
    )
  }
  if (!raw.url || !DEPLOYMENT_HOSTNAME.test(raw.url)) {
    fail(
      "DEPLOYMENT_URL_UNSAFE",
      "Vercel returned no safe canonical deployment hostname."
    )
  }
  if (!raw.gitSource?.sha || !GIT_SHA.test(raw.gitSource.sha)) {
    fail(
      "GIT_IDENTITY_MISMATCH",
      "Vercel returned no valid deployment Git SHA."
    )
  }
  return {
    id: deploymentId,
    projectId,
    teamId,
    url: raw.url,
    readyState: raw.readyState ?? "UNKNOWN",
    gitSha: raw.gitSource.sha,
  }
}

function verifyCheckRuns(
  definitions: VercelCheckDefinition[],
  runs: VercelCheckRun[],
  requiredCheckIds: string[],
  projectId: string,
  deploymentId: string
): void {
  for (const checkId of requiredCheckIds) {
    const matchingDefinitions = definitions.filter(
      (definition) =>
        definition.id === checkId &&
        definition.deletedAt == null &&
        (definition.projectId === undefined ||
          definition.projectId === projectId)
    )
    const latest = runs
      .filter(
        (run) =>
          run.checkId === checkId &&
          run.deploymentId === deploymentId &&
          run.projectId === projectId
      )
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))[0]
    if (
      matchingDefinitions.length !== 1 ||
      typeof latest?.completedAt !== "number" ||
      latest?.status !== "completed" ||
      latest.conclusion !== "succeeded"
    ) {
      fail(
        "DEPLOYMENT_CHECK_FAILED",
        `Required Deployment Check ${checkId} is missing or unsuccessful.`
      )
    }
  }
}

function assertRollingReleaseWrapper(value: unknown, state: string): void {
  const wrapper = value as Record<string, unknown> | null
  if (
    !wrapper ||
    Array.isArray(wrapper) ||
    Object.keys(wrapper).length !== 1 ||
    !Object.hasOwn(wrapper, "rollingRelease")
  ) {
    fail(
      "ROLLING_RELEASE_RESPONSE_INVALID",
      "Vercel returned an invalid rolling-release wrapper."
    )
  }
  if (wrapper.rollingRelease !== null) {
    fail(
      state === "configured"
        ? "ROLLING_RELEASE_CONFIGURED"
        : "ROLLING_RELEASE_ACTIVE",
      `A rolling release is ${state} for this project; the transition is disabled.`
    )
  }
}

function observeProject(
  project: VercelProject,
  teamId: string,
  projectId: string,
  productionDomains: string[]
): ProductionObservation {
  if (project.id !== projectId || project.accountId !== teamId) {
    fail(
      "PROJECT_IDENTITY_MISMATCH",
      "Vercel returned a project outside the configured team/project identity."
    )
  }
  if (!Array.isArray(project.alias)) {
    fail("PROJECT_ALIASES_MISSING", "Vercel did not return project aliases.")
  }
  if (project.alias.length > MAX_PROJECT_ALIAS_INVENTORY) {
    fail(
      "PROJECT_ALIAS_INVENTORY_TOO_LARGE",
      `Vercel returned more than ${MAX_PROJECT_ALIAS_INVENTORY} aliases.`
    )
  }
  assertDomains(productionDomains)
  const configured = [...productionDomains].sort()
  const aliases = project.alias.filter(
    (alias) =>
      alias.target?.toUpperCase() === "PRODUCTION" ||
      alias.environment?.toLowerCase() === "production"
  )
  const domainDeploymentIds: Record<string, string | null> = {}
  for (const alias of aliases) {
    const domain = alias.domain
    const deploymentId = alias.deployment?.id
    if (
      typeof domain !== "string" ||
      domain !== domain.toLowerCase() ||
      !HOSTNAME.test(domain) ||
      typeof deploymentId !== "string" ||
      !DEPLOYMENT_ID.test(deploymentId)
    ) {
      fail(
        "PROJECT_ALIAS_SET_MALFORMED",
        "Vercel returned an invalid production alias mapping."
      )
    }
    if (Object.hasOwn(domainDeploymentIds, domain)) {
      fail("PROJECT_ALIAS_SET_MISMATCH", "Vercel returned duplicate aliases.")
    }
    domainDeploymentIds[domain] = deploymentId
  }
  const observed = Object.keys(domainDeploymentIds).sort()
  if (
    observed.length !== configured.length ||
    configured.some((domain, index) => domain !== observed[index])
  ) {
    fail(
      "PROJECT_ALIAS_SET_MISMATCH",
      "Vercel production aliases do not exactly match configured domains."
    )
  }
  const values = Object.values(domainDeploymentIds)
  return {
    domainDeploymentIds,
    exactDomainSet: true,
    currentDeploymentId: new Set(values).size === 1 ? values[0] : null,
  }
}

function assertDomains(domains: string[]): void {
  if (
    domains.length < 1 ||
    domains.length > MAX_PRODUCTION_HEALTH_DOMAINS ||
    new Set(domains).size !== domains.length ||
    domains.some(
      (domain) => domain !== domain.toLowerCase() || !HOSTNAME.test(domain)
    )
  ) {
    fail("PRODUCTION_DOMAINS_INVALID", "Production domains are invalid.")
  }
}

function assertHealthPaths(paths: string[]): void {
  if (
    paths.length < 1 ||
    paths.length > 3 ||
    paths.some(
      (path) =>
        path.length > 256 ||
        !path.startsWith("/") ||
        path.startsWith("//") ||
        path.includes("?") ||
        path.includes("#") ||
        path.includes("\\") ||
        /[\u0000-\u001f]/.test(path)
    )
  ) {
    fail("HEALTH_PATHS_INVALID", "Health paths are invalid or unbounded.")
  }
}
