import type {
  DeploymentCheckPolicy,
  PromoteInput,
  TargetPolicy,
  WorkerConfig,
} from "./types.js"
import { SafetyError } from "./types.js"

// Provider identifiers are accepted only within the public receipt's bounded
// string budget. Keeping these patterns shared prevents validation failures
// from reflecting an arbitrarily large attacker-controlled identifier.
export const TEAM_ID = /^team_[A-Za-z0-9]{1,95}$/
export const PROJECT_ID = /^prj_[A-Za-z0-9]{1,96}$/
export const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]{1,96}$/
const GIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const FINGERPRINT = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/
export const DEPLOYMENT_HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:vercel\.app|now\.sh)$/
const TARGET_KEYS = new Set([
  "teamId",
  "projectId",
  "productionDomains",
  "deploymentChecks",
  "healthPaths",
])
const CHECK_KEYS = new Set(["id", "name"])

type Environment = Record<string, string | undefined>

function required(env: Environment, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new SafetyError("CONFIGURATION", `${name} is required.`)
  return value
}

function boundedInteger(
  env: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SafetyError(
      "CONFIGURATION",
      `${name} must be an integer from ${minimum} through ${maximum}.`
    )
  }
  return value
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  label: string
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key))
  if (unexpected.length > 0) {
    throw new SafetyError(
      "CONFIGURATION",
      `${label} has unsupported fields: ${unexpected.join(", ")}.`
    )
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() !== value || !value) {
    throw new SafetyError(
      "CONFIGURATION",
      `${label} must be a non-empty string without surrounding whitespace.`
    )
  }
  return value
}

function stringArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): string[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum
  ) {
    throw new SafetyError(
      "CONFIGURATION",
      `${label} must contain ${minimum}–${maximum} strings.`
    )
  }
  const result = value.map((item, index) =>
    nonEmptyString(item, `${label}[${index}]`)
  )
  if (new Set(result).size !== result.length) {
    throw new SafetyError(
      "CONFIGURATION",
      `${label} must not contain duplicates.`
    )
  }
  return result
}

function deploymentCheckArray(
  value: unknown,
  label: string
): DeploymentCheckPolicy[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new SafetyError(
      "CONFIGURATION",
      `${label} must contain 1–20 stable check descriptors.`
    )
  }
  const checks = value.map((item, index): DeploymentCheckPolicy => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new SafetyError(
        "CONFIGURATION",
        `${label}[${index}] must be an object with id and optional name.`
      )
    }
    const object = item as Record<string, unknown>
    assertExactKeys(object, CHECK_KEYS, `${label}[${index}]`)
    const id = nonEmptyString(object.id, `${label}[${index}].id`)
    if (!/^[A-Za-z0-9_]{3,100}$/.test(id)) {
      throw new SafetyError(
        "CONFIGURATION",
        `${label}[${index}].id must be a stable Vercel check ID.`
      )
    }
    let name: string | null = null
    if (object.name !== undefined && object.name !== null) {
      name = nonEmptyString(object.name, `${label}[${index}].name`)
      if (name.length > 100 || /[\u0000-\u001f]/.test(name)) {
        throw new SafetyError(
          "CONFIGURATION",
          `${label}[${index}].name must be a bounded display name.`
        )
      }
    }
    return { id, name }
  })
  if (new Set(checks.map((check) => check.id)).size !== checks.length) {
    throw new SafetyError(
      "CONFIGURATION",
      `${label} must not repeat check IDs.`
    )
  }
  return checks
}

export function parseTargetPolicies(raw: string): TargetPolicy[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new SafetyError(
      "CONFIGURATION",
      "VERCEL_PROMOTION_TARGETS_JSON must be valid JSON."
    )
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 20) {
    throw new SafetyError(
      "CONFIGURATION",
      "VERCEL_PROMOTION_TARGETS_JSON must contain 1–20 target policies."
    )
  }

  const policies = parsed.map((item, index): TargetPolicy => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new SafetyError(
        "CONFIGURATION",
        `Target policy ${index} must be an object.`
      )
    }
    const object = item as Record<string, unknown>
    assertExactKeys(object, TARGET_KEYS, `Target policy ${index}`)
    const teamId = nonEmptyString(
      object.teamId,
      `Target policy ${index}.teamId`
    )
    const projectId = nonEmptyString(
      object.projectId,
      `Target policy ${index}.projectId`
    )
    if (!TEAM_ID.test(teamId) || !PROJECT_ID.test(projectId)) {
      throw new SafetyError(
        "CONFIGURATION",
        `Target policy ${index} must use Vercel team_ and prj_ IDs.`
      )
    }

    const productionDomains = stringArray(
      object.productionDomains,
      `Target policy ${index}.productionDomains`,
      1,
      20
    ).map((domain) => {
      if (domain !== domain.toLowerCase() || !HOSTNAME.test(domain)) {
        throw new SafetyError(
          "CONFIGURATION",
          `Production domain ${JSON.stringify(domain)} must be a lowercase hostname.`
        )
      }
      return domain
    })
    const deploymentChecks = deploymentCheckArray(
      object.deploymentChecks,
      `Target policy ${index}.deploymentChecks`
    )
    const healthPaths = stringArray(
      object.healthPaths,
      `Target policy ${index}.healthPaths`,
      1,
      5
    )
    for (const path of healthPaths) {
      const decoded = decodeURIComponentSafely(path)
      if (
        path.length > 256 ||
        !path.startsWith("/") ||
        path.startsWith("//") ||
        path.includes("?") ||
        path.includes("#") ||
        path.includes("\\") ||
        /[\u0000-\u001f]/.test(path) ||
        decoded.split("/").includes("..")
      ) {
        throw new SafetyError(
          "CONFIGURATION",
          `Health path ${JSON.stringify(path)} must be a bounded path-only value.`
        )
      }
    }

    return {
      teamId,
      projectId,
      productionDomains,
      deploymentChecks,
      healthPaths,
    }
  })

  const identities = policies.map(
    (policy) => `${policy.teamId}:${policy.projectId}`
  )
  if (new Set(identities).size !== identities.length) {
    throw new SafetyError(
      "CONFIGURATION",
      "Each allowlisted team/project pair must be unique."
    )
  }
  return policies
}

function decodeURIComponentSafely(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return ".."
  }
}

function validateRedisUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SafetyError(
      "CONFIGURATION",
      "UPSTASH_REDIS_REST_URL must be a valid HTTPS URL."
    )
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new SafetyError(
      "CONFIGURATION",
      "UPSTASH_REDIS_REST_URL must be an HTTPS origin without credentials, query, or fragment."
    )
  }
  return url.href.replace(/\/$/, "")
}

export function loadConfig(env: Environment = process.env): WorkerConfig {
  const receiptProperty =
    env.NOTION_PROMOTION_RECEIPT_PROPERTY?.trim() || "Promotion receipt"
  if (receiptProperty.length > 100 || /[\u0000-\u001f]/.test(receiptProperty)) {
    throw new SafetyError(
      "CONFIGURATION",
      "NOTION_PROMOTION_RECEIPT_PROPERTY must be at most 100 characters."
    )
  }

  return {
    vercelToken: required(env, "VERCEL_ACCESS_TOKEN"),
    redisUrl: validateRedisUrl(required(env, "UPSTASH_REDIS_REST_URL")),
    redisToken: required(env, "UPSTASH_REDIS_REST_TOKEN"),
    protectionBypassSecret: env.VERCEL_PROTECTION_BYPASS_SECRET?.trim() || null,
    receiptProperty,
    pollTimeoutMs: boundedInteger(
      env,
      "VERCEL_PROMOTION_POLL_TIMEOUT_MS",
      90_000,
      5_000,
      90_000
    ),
    pollIntervalMs: 1_000,
    pollMaxAttempts: 30,
    leaseTtlMs: boundedInteger(
      env,
      "VERCEL_PROMOTION_LEASE_TTL_MS",
      120_000,
      90_000,
      300_000
    ),
    operationTtlSeconds: boundedInteger(
      env,
      "VERCEL_PROMOTION_OPERATION_TTL_SECONDS",
      604_800,
      3_600,
      2_592_000
    ),
    requestTimeoutMs: 10_000,
    healthTimeoutMs: 5_000,
    checkMaxAgeMs: boundedInteger(
      env,
      "VERCEL_PROMOTION_CHECK_MAX_AGE_MS",
      3_600_000,
      60_000,
      3_600_000
    ),
    targets: parseTargetPolicies(
      required(env, "VERCEL_PROMOTION_TARGETS_JSON")
    ),
  }
}

function exactString(value: unknown, label: string, maximum = 256): void {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.length > maximum ||
    /[\u0000-\u001f]/.test(value)
  ) {
    throw new SafetyError(
      "INVALID_INPUT",
      `${label} must be a non-empty, bounded exact value.`
    )
  }
}

export function validatePromoteInput(input: PromoteInput): void {
  if (
    typeof input.approvalPageId !== "string" ||
    !UUID.test(input.approvalPageId)
  ) {
    throw new SafetyError("INVALID_INPUT", "approvalPageId must be a UUID.")
  }
  exactString(input.approvalRevision, "approvalRevision", 100)
  if (
    typeof input.approvalFingerprint !== "string" ||
    !FINGERPRINT.test(input.approvalFingerprint)
  ) {
    throw new SafetyError(
      "INVALID_INPUT",
      "approvalFingerprint must be a lowercase SHA-256 digest."
    )
  }
  if (typeof input.teamId !== "string" || !TEAM_ID.test(input.teamId)) {
    throw new SafetyError("INVALID_INPUT", "teamId must be a Vercel team_ ID.")
  }
  if (
    typeof input.projectId !== "string" ||
    !PROJECT_ID.test(input.projectId)
  ) {
    throw new SafetyError(
      "INVALID_INPUT",
      "projectId must be a Vercel prj_ ID."
    )
  }
  for (const [label, value] of [
    ["deploymentId", input.deploymentId],
    ["expectedCurrentDeploymentId", input.expectedCurrentDeploymentId],
  ] as const) {
    if (typeof value !== "string" || !DEPLOYMENT_ID.test(value)) {
      throw new SafetyError(
        "INVALID_INPUT",
        `${label} must be a Vercel dpl_ ID.`
      )
    }
  }
  if (
    typeof input.expectedGitSha !== "string" ||
    !GIT_SHA.test(input.expectedGitSha)
  ) {
    throw new SafetyError(
      "INVALID_INPUT",
      "expectedGitSha must be a lowercase 40- or 64-character Git SHA."
    )
  }
  exactString(input.expectedGitBranch, "expectedGitBranch")
}

export function findTargetPolicy(
  config: WorkerConfig,
  input: PromoteInput
): TargetPolicy {
  const policy = config.targets.find(
    (candidate) =>
      candidate.teamId === input.teamId &&
      candidate.projectId === input.projectId
  )
  if (!policy) {
    throw new SafetyError(
      "TARGET_NOT_ALLOWLISTED",
      "The exact team/project pair is not in VERCEL_PROMOTION_TARGETS_JSON."
    )
  }
  return policy
}
