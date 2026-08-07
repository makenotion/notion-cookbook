export type Environment = Record<string, string | undefined>

export type RuntimeConfig = {
  cloudId: string
  siteUrl: string
  email: string
  apiToken: string
  projectId: string
  projectKey: string
  blocksLinkTypeId: string
  estimateFieldId: string | null
}

const NUMERIC_ID = /^[1-9][0-9]{0,31}$/
const CLOUD_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,19}$/
const FIELD_ID = /^customfield_[1-9][0-9]{0,15}$/

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

function jiraSiteUrl(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    !url.hostname.endsWith(".atlassian.net")
  ) {
    throw new Error(
      "JIRA_SITE_URL must be an atlassian.net HTTPS origin without credentials or a path"
    )
  }
  return url.origin
}

function numericId(env: Environment, name: string): string {
  const value = required(env, name)
  if (!NUMERIC_ID.test(value)) throw new Error(`${name} must be numeric`)
  return value
}

function optionalFieldId(env: Environment, name: string): string | null {
  const value = env[name]?.trim()
  if (!value) return null
  if (!FIELD_ID.test(value)) {
    throw new Error(`${name} must be a Jira customfield ID`)
  }
  return value
}

export function normalizeProjectKey(value: string): string {
  const key = value.trim().toUpperCase()
  if (!PROJECT_KEY.test(key)) {
    throw new Error("JIRA_PROJECT_KEY is invalid")
  }
  return key
}

export function loadConfig(env: Environment = process.env): RuntimeConfig {
  const email = credential(env, "JIRA_EMAIL", 254)
  if (!email.includes("@") || /\s/.test(email)) {
    throw new Error("JIRA_EMAIL must be a bounded email address")
  }
  return {
    cloudId: (() => {
      const value = required(env, "JIRA_CLOUD_ID")
      if (!CLOUD_ID.test(value)) {
        throw new Error("JIRA_CLOUD_ID must be a UUID")
      }
      return value.toLowerCase()
    })(),
    siteUrl: jiraSiteUrl(required(env, "JIRA_SITE_URL")),
    email,
    apiToken: credential(env, "JIRA_API_TOKEN", 4_096),
    projectId: numericId(env, "JIRA_PROJECT_ID"),
    projectKey: normalizeProjectKey(required(env, "JIRA_PROJECT_KEY")),
    blocksLinkTypeId: numericId(env, "JIRA_BLOCKS_LINK_TYPE_ID"),
    estimateFieldId: optionalFieldId(env, "JIRA_ESTIMATE_FIELD_ID"),
  }
}
