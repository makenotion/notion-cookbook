import { normalizeRepository, PolicyError } from "./policy.js"

export type Environment = Record<string, string | undefined>

export type RuntimeConfig = {
  allowedRepositories: Map<string, number>
  redisUrl: string
  redisToken: string
  approvalStatusProperty: string
  approvedStatus: string
  approvalRevisionProperty: string
  approvalFingerprintProperty: string
  receiptProperty: string
  githubRequestTimeoutMs: number
  notionRequestTimeoutMs: number
  redisRequestTimeoutMs: number
  leaseTtlMs: number
}

function required(env: Environment, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is not set`)
  return value
}

function propertyName(
  env: Environment,
  name: string,
  fallback: string
): string {
  const value = env[name]?.trim() || fallback
  if (value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must be at most 100 printable characters`)
  }
  return value
}

export function parseAllowedRepositories(value: string): Map<string, number> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new PolicyError("GITHUB_ALLOWED_REPOSITORIES_JSON must be valid JSON")
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 20) {
    throw new PolicyError(
      "GITHUB_ALLOWED_REPOSITORIES_JSON must contain 1-20 entries"
    )
  }
  const repos = new Map<string, number>()
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") {
      throw new PolicyError("repository allowlist entries must be objects")
    }
    const candidate = entry as Record<string, unknown>
    if (
      typeof candidate.repository !== "string" ||
      typeof candidate.repositoryId !== "number" ||
      !Number.isSafeInteger(candidate.repositoryId) ||
      candidate.repositoryId <= 0 ||
      Object.keys(candidate).some(
        (key) => key !== "repository" && key !== "repositoryId"
      )
    ) {
      throw new PolicyError(
        "each allowlist entry needs only repository and positive repositoryId"
      )
    }
    const repository = normalizeRepository(candidate.repository)
    if (repos.has(repository)) {
      throw new PolicyError(
        `duplicate repository allowlist entry: ${repository}`
      )
    }
    repos.set(repository, candidate.repositoryId)
  }
  return repos
}

export function loadConfig(env: Environment = process.env): RuntimeConfig {
  const redisUrl = required(env, "UPSTASH_REDIS_REST_URL")
  const parsedRedisUrl = new URL(redisUrl)
  if (
    parsedRedisUrl.protocol !== "https:" ||
    parsedRedisUrl.username !== "" ||
    parsedRedisUrl.password !== "" ||
    parsedRedisUrl.search !== "" ||
    parsedRedisUrl.hash !== "" ||
    (parsedRedisUrl.pathname !== "" && parsedRedisUrl.pathname !== "/")
  ) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL must be an HTTPS origin without credentials, path, query, or fragment"
    )
  }

  return {
    allowedRepositories: parseAllowedRepositories(
      required(env, "GITHUB_ALLOWED_REPOSITORIES_JSON")
    ),
    redisUrl: parsedRedisUrl.origin,
    redisToken: required(env, "UPSTASH_REDIS_REST_TOKEN"),
    approvalStatusProperty: propertyName(
      env,
      "NOTION_APPROVAL_STATUS_PROPERTY",
      "Approval status"
    ),
    approvedStatus: propertyName(env, "NOTION_APPROVED_STATUS", "Approved"),
    approvalRevisionProperty: propertyName(
      env,
      "NOTION_APPROVAL_REVISION_PROPERTY",
      "Approval revision"
    ),
    approvalFingerprintProperty: propertyName(
      env,
      "NOTION_APPROVAL_FINGERPRINT_PROPERTY",
      "Approval fingerprint"
    ),
    receiptProperty: propertyName(
      env,
      "NOTION_RELEASE_RECEIPT_PROPERTY",
      "Release receipt"
    ),
    githubRequestTimeoutMs: 8_000,
    notionRequestTimeoutMs: 10_000,
    redisRequestTimeoutMs: 3_000,
    leaseTtlMs: 120_000,
  }
}

export function assertAllowedRepository(
  repository: string,
  allowed: Map<string, number>
): { repository: string; repositoryId: number } {
  const normalized = normalizeRepository(repository)
  const repositoryId = allowed.get(normalized)
  if (repositoryId === undefined) {
    throw new PolicyError(
      "repository is not in GITHUB_ALLOWED_REPOSITORIES_JSON"
    )
  }
  return { repository: normalized, repositoryId }
}
