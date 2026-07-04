import { SafetyError, type WorkerConfig } from "./types.js"

export const TEAM_ID = /^team_[A-Za-z0-9]{1,95}$/
export const PROJECT_ID = /^prj_[A-Za-z0-9]{1,96}$/
export const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]{1,96}$/
export const GIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
export const MAX_HEALTH_DOMAINS = 10
export const MAX_PRODUCTION_DOMAINS = 100
export const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
type Environment = Record<string, string | undefined>

function required(env: Environment, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new SafetyError("CONFIGURATION", `${name} is required.`)
  return value
}

function healthPath(path: string): string {
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
    CONTROL_CHARACTER.test(path) ||
    decoded.split("/").includes("..")
  ) {
    throw new SafetyError(
      "CONFIGURATION",
      "VERCEL_HEALTH_PATHS_JSON must contain path-only values without traversal, query, or fragment components."
    )
  }
  return path
}

function parseHealthPaths(env: Environment): string[] {
  const raw = env.VERCEL_HEALTH_PATHS_JSON?.trim()
  if (!raw) return []
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new SafetyError(
      "CONFIGURATION",
      "VERCEL_HEALTH_PATHS_JSON must be valid JSON."
    )
  }
  if (
    !Array.isArray(value) ||
    value.length > 3 ||
    value.some((item) => typeof item !== "string")
  ) {
    throw new SafetyError(
      "CONFIGURATION",
      "VERCEL_HEALTH_PATHS_JSON must contain 0–3 strings."
    )
  }
  const paths = value.map((path) => healthPath(path as string))
  if (new Set(paths).size !== paths.length) {
    throw new SafetyError(
      "CONFIGURATION",
      "VERCEL_HEALTH_PATHS_JSON must not contain duplicates."
    )
  }
  return paths
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
    healthPaths: parseHealthPaths(env),
    protectionBypassSecret,
  }
}
