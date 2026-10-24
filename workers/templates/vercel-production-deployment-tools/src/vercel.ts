import {
  DEPLOYMENT_ID,
  GIT_SHA,
  HOSTNAME,
  MAX_HEALTH_DOMAINS,
  MAX_PRODUCTION_DOMAINS,
} from "./config.js"
import type {
  ProductionObservation,
  RollingReleaseState,
  TransitionAction,
  VercelClientLike,
  VercelDeployment,
} from "./types.js"
import { SafetyError, VercelHttpError } from "./types.js"

const API_ORIGIN = "https://api.vercel.com"
const DEPLOYMENT_HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:vercel\.app|now\.sh)$/

export const MAX_VERCEL_RESPONSE_BYTES = 1_048_576
export interface VercelClientOptions {
  token: string
  protectionBypassSecret: string | null
  requestTimeoutMs?: number
  healthTimeoutMs?: number
  fetchImpl?: typeof fetch
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => Date
}

interface RawDeployment {
  id?: string
  projectId?: string
  project?: { id?: string }
  ownerId?: string
  team?: { id?: string }
  url?: string
  target?: string | null
  readyState?: string
  readySubstate?: string
  checksState?: string
  checksConclusion?: string
  gitSource?: { sha?: string }
}

interface VercelProject {
  id?: string
  accountId?: string
  alias?: Array<{
    domain?: string
    target?: string
    environment?: string
    deployment?: { id?: string } | null
    redirect?: string | null
  }>
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
    if (!Number.isNaN(date.getTime())) {
      return Math.max(0, date.getTime() - now.getTime())
    }
  }
  const reset = Number(response.headers.get("x-ratelimit-reset"))
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(0, reset * 1_000 - now.getTime())
  }
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
      { status: response.status }
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
        { status: response.status }
      )
    }
    throw new VercelHttpError("Vercel read retry bound was exhausted.")
  }

  async getDeployment(
    teamId: string,
    projectId: string,
    deploymentId: string
  ): Promise<VercelDeployment> {
    if (!DEPLOYMENT_ID.test(deploymentId)) {
      fail("INVALID_DEPLOYMENT_ID", "The deployment ID must start with dpl_.")
    }
    const raw = (await this.read(
      `/v13/deployments/${encodeURIComponent(deploymentId)}?withGitRepoInfo=true&teamId=${encodeURIComponent(teamId)}`
    )) as RawDeployment
    return normalizeDeployment(raw, teamId, projectId, deploymentId)
  }

  async getRollingReleaseState(
    teamId: string,
    projectId: string
  ): Promise<RollingReleaseState> {
    const [configuration, active] = await Promise.all([
      this.read(
        `/v1/projects/${encodeURIComponent(projectId)}/rolling-release/config?teamId=${encodeURIComponent(teamId)}`
      ),
      this.read(
        `/v1/projects/${encodeURIComponent(projectId)}/rolling-release?teamId=${encodeURIComponent(teamId)}&state=ACTIVE`
      ),
    ])
    if (hasRollingRelease(active)) return "active"
    return hasRollingRelease(configuration) ? "configured" : "none"
  }

  async observeProduction(
    teamId: string,
    projectId: string
  ): Promise<ProductionObservation> {
    const project = (await this.read(
      `/v9/projects/${encodeURIComponent(projectId)}?teamId=${encodeURIComponent(teamId)}`
    )) as VercelProject
    return observeProject(project, teamId, projectId)
  }

  async requestTransition(
    action: TransitionAction,
    teamId: string,
    projectId: string,
    targetDeploymentId: string
  ): Promise<void> {
    const path =
      action === "promote"
        ? `/v10/projects/${encodeURIComponent(projectId)}/promote/${encodeURIComponent(targetDeploymentId)}?teamId=${encodeURIComponent(teamId)}`
        : `/v1/projects/${encodeURIComponent(projectId)}/rollback/${encodeURIComponent(targetDeploymentId)}?teamId=${encodeURIComponent(teamId)}&description=${encodeURIComponent("Rollback requested from Notion")}`
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

    await disposeBody(response)
    const accepted =
      action === "promote"
        ? response.status === 201 || response.status === 202
        : response.status === 201
    if (accepted) return

    const definite =
      action === "promote"
        ? [400, 401, 403, 409, 429]
        : [400, 401, 402, 403, 409, 422, 429]
    throw new VercelHttpError(
      `Vercel ${action} returned HTTP ${response.status}; inspect live state before another request.`,
      {
        status: response.status,
        ambiguous: !definite.includes(response.status),
      }
    )
  }

  async checkDeploymentHealth(
    hostname: string,
    paths: string[]
  ): Promise<void> {
    if (paths.length === 0) return
    if (!DEPLOYMENT_HOSTNAME.test(hostname)) {
      fail(
        "DEPLOYMENT_URL_UNSAFE",
        "Vercel returned an unsafe deployment hostname."
      )
    }
    await this.checkHosts([hostname], paths, true)
  }

  async checkProductionHealth(
    domains: string[],
    paths: string[]
  ): Promise<void> {
    if (paths.length === 0) return
    assertHealthDomains(domains)
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
    raw.ownerId !== teamId ||
    (raw.team?.id !== undefined && raw.team.id !== teamId) ||
    raw.projectId !== projectId ||
    (raw.project?.id !== undefined && raw.project.id !== projectId)
  ) {
    fail(
      "DEPLOYMENT_IDENTITY_MISMATCH",
      "Vercel returned a deployment outside the configured team and project."
    )
  }
  if (!raw.url || !DEPLOYMENT_HOSTNAME.test(raw.url)) {
    fail(
      "DEPLOYMENT_URL_UNSAFE",
      "Vercel returned no safe deployment hostname."
    )
  }
  const gitSha = raw.gitSource?.sha ?? null
  if (gitSha !== null && !GIT_SHA.test(gitSha)) {
    fail("GIT_IDENTITY_INVALID", "Vercel returned an invalid Git SHA.")
  }
  return {
    id: deploymentId,
    projectId,
    teamId,
    url: raw.url,
    target: raw.target ?? null,
    readyState: raw.readyState ?? "UNKNOWN",
    readySubstate: raw.readySubstate ?? null,
    gitSha,
    checksState: raw.checksState ?? null,
    checksConclusion: raw.checksConclusion ?? null,
  }
}

function hasRollingRelease(value: unknown): boolean {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Object.hasOwn(value, "rollingRelease")
  ) {
    fail(
      "ROLLING_RELEASE_RESPONSE_INVALID",
      "Vercel returned an invalid rolling-release response."
    )
  }
  const rollingRelease = (value as { rollingRelease: unknown }).rollingRelease
  if (
    rollingRelease !== null &&
    (typeof rollingRelease !== "object" || Array.isArray(rollingRelease))
  ) {
    fail(
      "ROLLING_RELEASE_RESPONSE_INVALID",
      "Vercel returned an invalid rolling-release response."
    )
  }
  return rollingRelease !== null
}

function observeProject(
  project: VercelProject,
  teamId: string,
  projectId: string
): ProductionObservation {
  if (project.id !== projectId || project.accountId !== teamId) {
    fail(
      "PROJECT_IDENTITY_MISMATCH",
      "Vercel returned a project outside the configured team and project."
    )
  }
  if (!Array.isArray(project.alias)) {
    fail("PROJECT_ALIASES_MISSING", "Vercel did not return project aliases.")
  }
  const directProductionAliases = project.alias.filter(
    (alias) =>
      alias.redirect == null &&
      (alias.target?.toUpperCase() === "PRODUCTION" ||
        alias.environment?.toLowerCase() === "production")
  )
  if (
    directProductionAliases.length < 1 ||
    directProductionAliases.length > MAX_PRODUCTION_DOMAINS
  ) {
    fail(
      "PRODUCTION_DOMAINS_UNSUPPORTED",
      `The project must expose 1–${MAX_PRODUCTION_DOMAINS} direct Production domains.`
    )
  }

  const domainDeploymentIds: Record<string, string> = {}
  for (const alias of directProductionAliases) {
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
        "PROJECT_ALIAS_MALFORMED",
        "Vercel returned an invalid Production alias mapping."
      )
    }
    if (Object.hasOwn(domainDeploymentIds, domain)) {
      fail("PROJECT_ALIAS_MALFORMED", "Vercel returned duplicate aliases.")
    }
    domainDeploymentIds[domain] = deploymentId
  }

  const productionDomains = Object.keys(domainDeploymentIds).sort()
  const deploymentIds = Object.values(domainDeploymentIds)
  return {
    domainDeploymentIds,
    productionDomains,
    currentDeploymentId:
      new Set(deploymentIds).size === 1 ? deploymentIds[0] : null,
  }
}

function assertHealthDomains(domains: string[]): void {
  if (
    domains.length < 1 ||
    domains.length > MAX_HEALTH_DOMAINS ||
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
