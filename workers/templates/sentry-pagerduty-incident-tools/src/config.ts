export type Severity = "sev1" | "sev2" | "sev3"

export interface WorkerConfig {
  sentryToken: string
  sentryOrgSlug: string
  sentryProjectSlug: string
  sentryEnvironment: string
  sentryBaseUrl: string
  pagerDutyToken: string
  pagerDutyFromEmail: string
  pagerDutyServiceId: string
  pagerDutyPriorityIds: Record<Severity, string>
  pagerDutyBaseUrl: string
  requestTimeoutMs: number
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/

function required(
  env: NodeJS.ProcessEnv,
  name: string,
  maximum = 2_000
): string {
  const value = env[name]
  if (
    !value ||
    value.trim() !== value ||
    value.length > maximum ||
    !SAFE_TEXT.test(value)
  ) {
    throw new ConfigError(`${name} is missing or invalid.`)
  }
  return value
}

function slug(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name, 100)
  if (!SLUG.test(value)) throw new ConfigError(`${name} must be a slug.`)
  return value
}

function httpsOrigin(value: string, name: string): string {
  try {
    const url = new URL(value)
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "" && url.pathname !== "/")
    ) {
      throw new Error("invalid")
    }
    return url.origin
  } catch {
    throw new ConfigError(`${name} must be an HTTPS origin.`)
  }
}

function email(value: string): string {
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new ConfigError("PAGERDUTY_FROM_EMAIL must be an email address.")
  }
  return value
}

function priorityIds(value: string): Record<Severity, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new ConfigError("PAGERDUTY_PRIORITY_IDS_JSON must be valid JSON.")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError("PAGERDUTY_PRIORITY_IDS_JSON must be an object.")
  }
  const object = parsed as Record<string, unknown>
  const keys = Object.keys(object).sort()
  if (keys.join(",") !== "sev1,sev2,sev3") {
    throw new ConfigError(
      "PAGERDUTY_PRIORITY_IDS_JSON must contain sev1, sev2, and sev3 only."
    )
  }
  const result = {} as Record<Severity, string>
  for (const severity of ["sev1", "sev2", "sev3"] as const) {
    const id = object[severity]
    if (
      typeof id !== "string" ||
      id.length < 1 ||
      id.length > 100 ||
      id.trim() !== id ||
      !SAFE_TEXT.test(id)
    ) {
      throw new ConfigError(`The ${severity} PagerDuty priority ID is invalid.`)
    }
    result[severity] = id
  }
  if (new Set(Object.values(result)).size !== 3) {
    throw new ConfigError("PagerDuty priority IDs must be unique.")
  }
  return result
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const region = env.PAGERDUTY_REGION ?? "us"
  if (region !== "us" && region !== "eu") {
    throw new ConfigError('PAGERDUTY_REGION must be "us" or "eu".')
  }
  const environment = required(env, "SENTRY_ENVIRONMENT", 100)
  return {
    sentryToken: required(env, "SENTRY_AUTH_TOKEN", 20_000),
    sentryOrgSlug: slug(env, "SENTRY_ORG_SLUG"),
    sentryProjectSlug: slug(env, "SENTRY_PROJECT_SLUG"),
    sentryEnvironment: environment,
    sentryBaseUrl: httpsOrigin(
      env.SENTRY_BASE_URL ?? "https://sentry.io",
      "SENTRY_BASE_URL"
    ),
    pagerDutyToken: required(env, "PAGERDUTY_API_TOKEN", 20_000),
    pagerDutyFromEmail: email(required(env, "PAGERDUTY_FROM_EMAIL", 254)),
    pagerDutyServiceId: required(env, "PAGERDUTY_SERVICE_ID", 100),
    pagerDutyPriorityIds: priorityIds(
      required(env, "PAGERDUTY_PRIORITY_IDS_JSON", 2_000)
    ),
    pagerDutyBaseUrl:
      region === "eu"
        ? "https://api.eu.pagerduty.com"
        : "https://api.pagerduty.com",
    requestTimeoutMs: 8_000,
  }
}
