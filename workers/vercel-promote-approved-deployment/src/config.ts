import { SafetyError, type WorkerConfig } from "./types.js"

export const TEAM_ID = /^team_[A-Za-z0-9]{1,95}$/
export const PROJECT_ID = /^prj_[A-Za-z0-9]{1,96}$/
export const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]{1,96}$/
export const GIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
export const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/

const NOTION_PARENT_ID =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
const CHECK_ID = /^[A-Za-z0-9_]{3,100}$/
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

type Environment = Record<string, string | undefined>

function required(env: Environment, name: string): string {
  const value = env[name]?.trim()
  if (!value) {
    throw new SafetyError("CONFIGURATION", `${name} is required.`)
  }
  return value
}

function parseStringArray(
  env: Environment,
  name: string,
  minimum: number,
  maximum: number
): string[] {
  let value: unknown
  try {
    value = JSON.parse(required(env, name))
  } catch (error) {
    if (error instanceof SafetyError) throw error
    throw new SafetyError("CONFIGURATION", `${name} must be valid JSON.`)
  }
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum
  ) {
    throw new SafetyError(
      "CONFIGURATION",
      `${name} must contain ${minimum}–${maximum} strings.`
    )
  }
  const strings = value.map((item, index) => {
    if (
      typeof item !== "string" ||
      !item ||
      item.trim() !== item ||
      CONTROL_CHARACTER.test(item)
    ) {
      throw new SafetyError(
        "CONFIGURATION",
        `${name}[${index}] must be a non-empty exact string.`
      )
    }
    return item
  })
  if (new Set(strings).size !== strings.length) {
    throw new SafetyError(
      "CONFIGURATION",
      `${name} must not contain duplicates.`
    )
  }
  return strings
}

function approvalParentId(env: Environment): string {
  const value = required(env, "NOTION_VERCEL_APPROVAL_PARENT_ID")
  if (!NOTION_PARENT_ID.test(value)) {
    throw new SafetyError(
      "CONFIGURATION",
      "NOTION_VERCEL_APPROVAL_PARENT_ID must be a Notion data source or database UUID."
    )
  }
  return value.replaceAll("-", "").toLowerCase()
}

function healthPath(path: string, name: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    decoded = ".."
  }
  if (
    path.length > 256 ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("\\") ||
    decoded.split("/").includes("..")
  ) {
    throw new SafetyError(
      "CONFIGURATION",
      `${name} must contain path-only values without traversal, query, or fragment components.`
    )
  }
  return path
}

export function loadConfig(env: Environment = process.env): WorkerConfig {
  const teamId = required(env, "VERCEL_TEAM_ID")
  const projectId = required(env, "VERCEL_PROJECT_ID")
  if (!TEAM_ID.test(teamId)) {
    throw new SafetyError(
      "CONFIGURATION",
      "VERCEL_TEAM_ID must be a Vercel team_ identifier."
    )
  }
  if (!PROJECT_ID.test(projectId)) {
    throw new SafetyError(
      "CONFIGURATION",
      "VERCEL_PROJECT_ID must be a Vercel prj_ identifier."
    )
  }

  const productionDomains = parseStringArray(
    env,
    "VERCEL_PRODUCTION_DOMAINS_JSON",
    1,
    5
  )
    .map((domain) => {
      if (domain !== domain.toLowerCase() || !HOSTNAME.test(domain)) {
        throw new SafetyError(
          "CONFIGURATION",
          `Production domain ${JSON.stringify(domain)} must be a lowercase hostname.`
        )
      }
      return domain
    })
    .sort()

  const deploymentCheckIds = parseStringArray(
    env,
    "VERCEL_DEPLOYMENT_CHECK_IDS_JSON",
    0,
    20
  ).map((id) => {
    if (!CHECK_ID.test(id)) {
      throw new SafetyError(
        "CONFIGURATION",
        `Deployment Check ID ${JSON.stringify(id)} is invalid.`
      )
    }
    return id
  })

  const healthPaths = parseStringArray(
    env,
    "VERCEL_HEALTH_PATHS_JSON",
    1,
    3
  ).map((path) => healthPath(path, "VERCEL_HEALTH_PATHS_JSON"))

  const protectionBypassSecret =
    env.VERCEL_PROTECTION_BYPASS_SECRET?.trim() || null
  if (
    protectionBypassSecret !== null &&
    (protectionBypassSecret.length > 500 ||
      CONTROL_CHARACTER.test(protectionBypassSecret))
  ) {
    throw new SafetyError(
      "CONFIGURATION",
      "VERCEL_PROTECTION_BYPASS_SECRET is invalid or oversized."
    )
  }

  return {
    vercelToken: required(env, "VERCEL_ACCESS_TOKEN"),
    teamId,
    projectId,
    productionDomains,
    deploymentCheckIds,
    healthPaths,
    approvalParentId: approvalParentId(env),
    protectionBypassSecret,
  }
}
