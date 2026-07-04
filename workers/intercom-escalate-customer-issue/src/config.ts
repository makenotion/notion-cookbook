import { SafetyError } from "./types.js"

export interface EscalationTarget {
  jiraProjectKey: string
  jiraIssueTypeIds: string[]
  intercomTeamId: string
  intercomTagId: string
}

export interface RuntimeConfig {
  intercomToken: string
  intercomRegion: "us" | "eu" | "au"
  intercomWorkspaceId: string
  intercomAdminId: string
  jiraDomain: string
  jiraEmail: string
  jiraToken: string
  jiraActingAccountId: string
  targets: EscalationTarget[]
  redisUrl: string
  redisToken: string
  statusProperty: string
  approvedValue: string
  revisionProperty: string
  fingerprintProperty: string
  packetProperty: string
  receiptProperty: string
  requestTimeoutMs: number
  leaseTtlMs: number
  operationTtlSeconds: number
}

const ID = /^[A-Za-z0-9_-]{1,100}$/
const PROJECT = /^[A-Z][A-Z0-9_]{0,19}$/
const ISSUE_TYPE = /^[0-9]{1,30}$/

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is not set.`)
  return value
}

function name(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key]?.trim() || fallback
  if (value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${key} must be bounded plain text.`)
  }
  return value
}

function integer(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = env[key]?.trim()
  const value = raw ? Number(raw) : fallback
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be an integer from ${minimum} to ${maximum}.`)
  }
  return value
}

export function normalizeRedisUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("UPSTASH_REDIS_REST_URL must be a valid HTTPS origin.")
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL must be an HTTPS origin without credentials or a path."
    )
  }
  return url.origin
}

export function parseTargets(raw: string): EscalationTarget[] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error("ESCALATION_TARGETS_JSON must be valid JSON.")
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) {
    throw new Error("ESCALATION_TARGETS_JSON must contain one to ten targets.")
  }
  const projects = new Set<string>()
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Each escalation target must be an object.")
    }
    const object = entry as Record<string, unknown>
    const keys = [
      "jiraProjectKey",
      "jiraIssueTypeIds",
      "intercomTeamId",
      "intercomTagId",
    ]
    if (
      Object.keys(object).length !== keys.length ||
      Object.keys(object).some((key) => !keys.includes(key)) ||
      typeof object.jiraProjectKey !== "string" ||
      !PROJECT.test(object.jiraProjectKey) ||
      !Array.isArray(object.jiraIssueTypeIds) ||
      object.jiraIssueTypeIds.length < 1 ||
      object.jiraIssueTypeIds.length > 10 ||
      !object.jiraIssueTypeIds.every(
        (item) => typeof item === "string" && ISSUE_TYPE.test(item)
      ) ||
      new Set(object.jiraIssueTypeIds).size !==
        object.jiraIssueTypeIds.length ||
      typeof object.intercomTeamId !== "string" ||
      !ID.test(object.intercomTeamId) ||
      typeof object.intercomTagId !== "string" ||
      !ID.test(object.intercomTagId)
    ) {
      throw new Error("An escalation target is invalid or unbounded.")
    }
    if (projects.has(object.jiraProjectKey)) {
      throw new Error(
        "Each Jira project may appear only once in ESCALATION_TARGETS_JSON."
      )
    }
    projects.add(object.jiraProjectKey)
    return {
      jiraProjectKey: object.jiraProjectKey,
      jiraIssueTypeIds: [...object.jiraIssueTypeIds] as string[],
      intercomTeamId: object.intercomTeamId,
      intercomTagId: object.intercomTagId,
    }
  })
}

export function targetFor(
  config: RuntimeConfig,
  projectKey: string,
  issueTypeId: string
): EscalationTarget {
  const target = config.targets.find(
    (item) => item.jiraProjectKey === projectKey
  )
  if (!target || !target.jiraIssueTypeIds.includes(issueTypeId)) {
    throw new SafetyError(
      "TARGET_NOT_ALLOWED",
      "The approved Jira project and issue type are not allowlisted.",
      "blocked"
    )
  }
  return target
}

export function intercomBaseUrl(region: "us" | "eu" | "au"): string {
  if (region === "eu") return "https://api.eu.intercom.io"
  if (region === "au") return "https://api.au.intercom.io"
  return "https://api.intercom.io"
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env
): RuntimeConfig {
  const region = (env.INTERCOM_REGION?.trim() ||
    "us") as RuntimeConfig["intercomRegion"]
  if (!(["us", "eu", "au"] as string[]).includes(region)) {
    throw new Error("INTERCOM_REGION must be us, eu, or au.")
  }
  const workspaceId = required(env, "INTERCOM_WORKSPACE_ID")
  const adminId = required(env, "INTERCOM_ADMIN_ID")
  if (!ID.test(workspaceId) || !ID.test(adminId)) {
    throw new Error("Intercom workspace and admin IDs are invalid.")
  }
  const domain = required(env, "JIRA_DOMAIN").toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(domain)) {
    throw new Error("JIRA_DOMAIN must be a single Atlassian Cloud subdomain.")
  }
  const accountId = required(env, "JIRA_ACTING_ACCOUNT_ID")
  if (accountId.length > 128 || /[\u0000-\u001f\u007f]/.test(accountId)) {
    throw new Error("JIRA_ACTING_ACCOUNT_ID is invalid.")
  }
  return {
    intercomToken: required(env, "INTERCOM_ACCESS_TOKEN"),
    intercomRegion: region,
    intercomWorkspaceId: workspaceId,
    intercomAdminId: adminId,
    jiraDomain: domain,
    jiraEmail: required(env, "JIRA_EMAIL"),
    jiraToken: required(env, "JIRA_API_TOKEN"),
    jiraActingAccountId: accountId,
    targets: parseTargets(required(env, "ESCALATION_TARGETS_JSON")),
    redisUrl: normalizeRedisUrl(required(env, "UPSTASH_REDIS_REST_URL")),
    redisToken: required(env, "UPSTASH_REDIS_REST_TOKEN"),
    statusProperty: name(
      env,
      "NOTION_ESCALATION_STATUS_PROPERTY",
      "Escalation status"
    ),
    approvedValue: name(env, "NOTION_ESCALATION_APPROVED_VALUE", "Approved"),
    revisionProperty: name(
      env,
      "NOTION_ESCALATION_REVISION_PROPERTY",
      "Escalation revision"
    ),
    fingerprintProperty: name(
      env,
      "NOTION_ESCALATION_FINGERPRINT_PROPERTY",
      "Escalation fingerprint"
    ),
    packetProperty: name(
      env,
      "NOTION_ESCALATION_PACKET_PROPERTY",
      "Escalation packet"
    ),
    receiptProperty: name(
      env,
      "NOTION_ESCALATION_RECEIPT_PROPERTY",
      "Escalation receipt"
    ),
    requestTimeoutMs: integer(
      env,
      "ESCALATION_REQUEST_TIMEOUT_MS",
      8_000,
      1_000,
      30_000
    ),
    leaseTtlMs: integer(
      env,
      "ESCALATION_LEASE_TTL_MS",
      120_000,
      30_000,
      300_000
    ),
    operationTtlSeconds: integer(
      env,
      "ESCALATION_OPERATION_TTL_SECONDS",
      2_592_000,
      86_400,
      31_536_000
    ),
  }
}
