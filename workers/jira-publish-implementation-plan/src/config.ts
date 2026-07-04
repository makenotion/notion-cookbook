import {
  assertSafeFieldId,
  normalizeProjectKey,
  PolicyError,
} from "./policy.js"
import type { ProjectPolicy } from "./types.js"

export type Environment = Record<string, string | undefined>

export type RuntimeConfig = {
  cloudId: string
  siteUrl: string
  email: string
  apiToken: string
  projects: Map<string, ProjectPolicy>
  dependencyLinkTypeId: string
  dependencyLinkTypeName: string
  redisUrl: string
  redisToken: string
  approvalStatusProperty: string
  approvedStatus: string
  approvalRevisionProperty: string
  planHashProperty: string
  receiptProperty: string
  jiraRequestTimeoutMs: number
  redisRequestTimeoutMs: number
  notionRequestTimeoutMs: number
  leaseTtlMs: number
}

const NUMERIC_ID = /^[1-9][0-9]{0,31}$/
const CLOUD_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const ACCOUNT_ID = /^[^\u0000-\u001f\u007f]{1,128}$/
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function required(env: Environment, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is not set`)
  return value
}

function credential(env: Environment, name: string, maxBytes: number): string {
  const value = required(env, name)
  if (
    Buffer.byteLength(value, "utf8") > maxBytes ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${name} is oversized or contains control characters`)
  }
  return value
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: string[],
  name: string
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new PolicyError(`${name} contains unsupported fields`)
  }
}

function stringArray(
  value: unknown,
  name: string,
  predicate: (item: string) => boolean,
  max = 100
): string[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new PolicyError(`${name} must be an array with at most ${max} items`)
  }
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== "string" || !predicate(item)) {
      throw new PolicyError(`${name} contains an invalid value`)
    }
    result.push(item)
  }
  if (new Set(result).size !== result.length) {
    throw new PolicyError(`${name} contains duplicates`)
  }
  return result
}

function numberArray(value: unknown, name: string, max = 100): number[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new PolicyError(`${name} must be an array with at most ${max} items`)
  }
  const result = value.map((item) => {
    if (!Number.isSafeInteger(item) || (item as number) <= 0) {
      throw new PolicyError(`${name} contains an invalid positive integer`)
    }
    return item as number
  })
  if (new Set(result).size !== result.length) {
    throw new PolicyError(`${name} contains duplicates`)
  }
  return result
}

function nullableFieldId(value: unknown, name: string): string | null {
  if (value === null) return null
  if (typeof value !== "string") {
    throw new PolicyError(`${name} must be a Jira field ID or null`)
  }
  const fieldId = assertSafeFieldId(value, name)
  if (!fieldId.startsWith("customfield_")) {
    throw new PolicyError(`${name} must be a Jira customfield ID or null`)
  }
  return fieldId
}

export function parseAllowedProjects(
  value: string
): Map<string, ProjectPolicy> {
  let decoded: unknown
  try {
    decoded = JSON.parse(value)
  } catch {
    throw new PolicyError("JIRA_ALLOWED_PROJECTS_JSON must be valid JSON")
  }
  if (!Array.isArray(decoded) || decoded.length < 1 || decoded.length > 10) {
    throw new PolicyError(
      "JIRA_ALLOWED_PROJECTS_JSON must contain 1-10 project policies"
    )
  }
  const policies = new Map<string, ProjectPolicy>()
  for (const raw of decoded) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new PolicyError("project policies must be objects")
    }
    const item = raw as Record<string, unknown>
    exactKeys(
      item,
      [
        "projectKey",
        "projectId",
        "issueTypeIds",
        "parentTypePairs",
        "assigneeAccountIds",
        "labels",
        "fixVersionIds",
        "sprintIds",
        "fieldIds",
      ],
      "project policy"
    )
    if (typeof item.projectKey !== "string") {
      throw new PolicyError("project policy needs projectKey")
    }
    const projectKey = normalizeProjectKey(item.projectKey)
    if (policies.has(projectKey)) {
      throw new PolicyError(`duplicate project policy: ${projectKey}`)
    }
    if (
      typeof item.projectId !== "string" ||
      !NUMERIC_ID.test(item.projectId)
    ) {
      throw new PolicyError(`${projectKey}: projectId must be numeric`)
    }
    const issueTypeIds = stringArray(
      item.issueTypeIds,
      `${projectKey}.issueTypeIds`,
      (entry) => NUMERIC_ID.test(entry),
      20
    )
    if (issueTypeIds.length < 1) {
      throw new PolicyError(
        `${projectKey}: at least one issue type is required`
      )
    }
    const issueTypes = new Set(issueTypeIds)
    const parentTypePairs = stringArray(
      item.parentTypePairs,
      `${projectKey}.parentTypePairs`,
      (entry) => {
        const [parent, child, extra] = entry.split(">")
        return (
          extra === undefined &&
          parent !== child &&
          issueTypes.has(parent) &&
          issueTypes.has(child)
        )
      },
      30
    )
    const fieldIds = item.fieldIds
    if (!fieldIds || typeof fieldIds !== "object" || Array.isArray(fieldIds)) {
      throw new PolicyError(`${projectKey}: fieldIds must be an object`)
    }
    const fields = fieldIds as Record<string, unknown>
    exactKeys(fields, ["estimate", "sprint"], `${projectKey}.fieldIds`)
    const estimateFieldId = nullableFieldId(
      fields.estimate,
      `${projectKey}.fieldIds.estimate`
    )
    const sprintFieldId = nullableFieldId(
      fields.sprint,
      `${projectKey}.fieldIds.sprint`
    )
    if (estimateFieldId !== null && estimateFieldId === sprintFieldId) {
      throw new PolicyError(
        `${projectKey}: estimate and sprint must use different field IDs`
      )
    }
    policies.set(projectKey, {
      projectKey,
      projectId: item.projectId,
      issueTypeIds: issueTypes,
      parentTypePairs: new Set(parentTypePairs),
      assigneeAccountIds: new Set(
        stringArray(
          item.assigneeAccountIds,
          `${projectKey}.assigneeAccountIds`,
          (entry) => ACCOUNT_ID.test(entry),
          50
        )
      ),
      labels: new Set(
        stringArray(
          item.labels,
          `${projectKey}.labels`,
          (entry) => LABEL.test(entry),
          50
        )
      ),
      fixVersionIds: new Set(
        stringArray(
          item.fixVersionIds,
          `${projectKey}.fixVersionIds`,
          (entry) => NUMERIC_ID.test(entry),
          50
        )
      ),
      sprintIds: new Set(
        numberArray(item.sprintIds, `${projectKey}.sprintIds`, 50)
      ),
      fieldIds: {
        estimate: estimateFieldId,
        sprint: sprintFieldId,
      },
    })
  }
  return policies
}

function propertyName(
  env: Environment,
  name: string,
  fallback: string
): string {
  const value = env[name]?.trim() || fallback
  if (
    Buffer.byteLength(value, "utf8") > 100 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${name} must be at most 100 printable characters`)
  }
  return value
}

function httpsOrigin(value: string, name: string): string {
  const url = new URL(value)
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error(
      `${name} must be an HTTPS origin without credentials or path`
    )
  }
  return url.origin
}

export function loadConfig(env: Environment = process.env): RuntimeConfig {
  const cloudId = required(env, "JIRA_CLOUD_ID")
  if (!CLOUD_ID.test(cloudId)) throw new Error("JIRA_CLOUD_ID must be a UUID")
  const siteUrl = httpsOrigin(required(env, "JIRA_SITE_URL"), "JIRA_SITE_URL")
  if (!new URL(siteUrl).hostname.endsWith(".atlassian.net")) {
    throw new Error("JIRA_SITE_URL must be an atlassian.net site origin")
  }
  const email = credential(env, "JIRA_EMAIL", 254)
  if (!email.includes("@") || /\s/.test(email)) {
    throw new Error("JIRA_EMAIL must be a bounded email address")
  }
  const apiToken = credential(env, "JIRA_API_TOKEN", 1_024)
  const dependencyLinkTypeId = required(env, "JIRA_DEPENDENCY_LINK_TYPE_ID")
  if (!NUMERIC_ID.test(dependencyLinkTypeId)) {
    throw new Error("JIRA_DEPENDENCY_LINK_TYPE_ID must be numeric")
  }
  const dependencyLinkTypeName = required(env, "JIRA_DEPENDENCY_LINK_TYPE_NAME")
  if (
    Buffer.byteLength(dependencyLinkTypeName, "utf8") > 100 ||
    /[\u0000-\u001f\u007f]/.test(dependencyLinkTypeName)
  ) {
    throw new Error("JIRA_DEPENDENCY_LINK_TYPE_NAME is invalid")
  }
  return {
    cloudId: cloudId.toLowerCase(),
    siteUrl,
    email,
    apiToken,
    projects: parseAllowedProjects(required(env, "JIRA_ALLOWED_PROJECTS_JSON")),
    dependencyLinkTypeId,
    dependencyLinkTypeName,
    redisUrl: httpsOrigin(
      required(env, "UPSTASH_REDIS_REST_URL"),
      "UPSTASH_REDIS_REST_URL"
    ),
    redisToken: credential(env, "UPSTASH_REDIS_REST_TOKEN", 4_096),
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
    planHashProperty: propertyName(
      env,
      "NOTION_PLAN_HASH_PROPERTY",
      "Approved plan hash"
    ),
    receiptProperty: propertyName(
      env,
      "NOTION_JIRA_RECEIPT_PROPERTY",
      "Jira publication receipt"
    ),
    jiraRequestTimeoutMs: 8_000,
    redisRequestTimeoutMs: 3_000,
    notionRequestTimeoutMs: 10_000,
    leaseTtlMs: 120_000,
  }
}
