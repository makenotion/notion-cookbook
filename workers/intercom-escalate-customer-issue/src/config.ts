export interface RuntimeConfig {
  intercomToken: string
  intercomRegion: "us" | "eu" | "au"
  intercomWorkspaceId: string
  intercomAdminId: string
  intercomTeamId: string
  intercomTagId: string
  notionTicketsDataSourceId: string
  requestTimeoutMs: number
}

const PROVIDER_ID = /^[A-Za-z0-9_-]{1,100}$/
const NOTION_ID =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is not set.`)
  return value
}

function providerId(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name)
  if (!PROVIDER_ID.test(value)) {
    throw new Error(`${name} must be a bounded Intercom identifier.`)
  }
  return value
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = env[name]?.trim()
  const value = raw ? Number(raw) : fallback
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`)
  }
  return value
}

function notionId(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name)
  if (!NOTION_ID.test(value)) {
    throw new Error(`${name} must be a Notion ID.`)
  }
  return value.toLowerCase()
}

export function intercomBaseUrl(
  region: RuntimeConfig["intercomRegion"]
): string {
  if (region === "eu") return "https://api.eu.intercom.io"
  if (region === "au") return "https://api.au.intercom.io"
  return "https://api.intercom.io"
}

export function intercomAppBaseUrl(
  region: RuntimeConfig["intercomRegion"]
): string {
  if (region === "eu") return "https://app.eu.intercom.com"
  if (region === "au") return "https://app.au.intercom.com"
  return "https://app.intercom.com"
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env
): RuntimeConfig {
  const region = (env.INTERCOM_REGION?.trim() ||
    "us") as RuntimeConfig["intercomRegion"]
  if (!(region === "us" || region === "eu" || region === "au")) {
    throw new Error("INTERCOM_REGION must be us, eu, or au.")
  }

  return {
    intercomToken: required(env, "INTERCOM_ACCESS_TOKEN"),
    intercomRegion: region,
    intercomWorkspaceId: providerId(env, "INTERCOM_WORKSPACE_ID"),
    intercomAdminId: providerId(env, "INTERCOM_ADMIN_ID"),
    intercomTeamId: providerId(env, "INTERCOM_TEAM_ID"),
    intercomTagId: providerId(env, "INTERCOM_TAG_ID"),
    notionTicketsDataSourceId: notionId(env, "NOTION_TICKETS_DATA_SOURCE_ID"),
    requestTimeoutMs: integer(
      env,
      "ESCALATION_REQUEST_TIMEOUT_MS",
      8_000,
      1_000,
      30_000
    ),
  }
}
