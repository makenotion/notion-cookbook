import type { RuntimePolicy } from "./policy.js"

export const SALESFORCE_API_VERSION = "v67.0"

export type RuntimeConfig = RuntimePolicy & {
  salesforceOrgUrl: string
  salesforceClientId: string
  salesforceClientSecret: string
  approvalProperty: string
  approvedValue: string
  revisionProperty: string
  fingerprintProperty: string
  receiptProperty: string
  meetingTaskStatus: string
  followUpTaskStatus: string
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is not set.`)
  return value
}

function configuredName(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: string
): string {
  const value = env[name]?.trim() || fallback
  if (value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} must be a plain string of at most 100 characters.`)
  }
  return value
}

export function normalizeSalesforceOrigin(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("SALESFORCE_ORG_URL must be a valid HTTPS origin.")
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    !/\.(?:my\.)?salesforce\.com$/i.test(url.hostname)
  ) {
    throw new Error(
      "SALESFORCE_ORG_URL must be a Salesforce My Domain HTTPS origin."
    )
  }
  return url.origin
}

function parseIdSet(
  env: NodeJS.ProcessEnv,
  name: string,
  maximum: number
): Set<string> {
  const values = (env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  if (values.length > maximum) {
    throw new Error(`${name} can contain at most ${maximum} IDs.`)
  }
  for (const value of values) {
    if (!/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(value)) {
      throw new Error(`${name} contains an invalid Salesforce ID.`)
    }
  }
  return new Set(values)
}

export function parseStageTransitions(
  raw: string | undefined
): Map<string, Set<string>> {
  let value: unknown
  try {
    value = JSON.parse(raw?.trim() || "{}")
  } catch {
    throw new Error("SALESFORCE_ALLOWED_STAGE_TRANSITIONS must be valid JSON.")
  }
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "SALESFORCE_ALLOWED_STAGE_TRANSITIONS must be a JSON object."
    )
  }

  const entries = Object.entries(value)
  if (entries.length > 50) {
    throw new Error(
      "SALESFORCE_ALLOWED_STAGE_TRANSITIONS can contain at most 50 current stages."
    )
  }

  const transitions = new Map<string, Set<string>>()
  for (const [current, targets] of entries) {
    if (
      current.length < 1 ||
      current.length > 80 ||
      !Array.isArray(targets) ||
      targets.length > 20 ||
      !targets.every(
        (target) =>
          typeof target === "string" && target.length > 0 && target.length <= 80
      )
    ) {
      throw new Error(
        "SALESFORCE_ALLOWED_STAGE_TRANSITIONS must map stage names to bounded string arrays."
      )
    }
    transitions.set(current, new Set(targets))
  }
  return transitions
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env
): RuntimeConfig {
  return {
    salesforceOrgUrl: normalizeSalesforceOrigin(
      requiredEnv(env, "SALESFORCE_ORG_URL")
    ),
    salesforceClientId: requiredEnv(env, "SALESFORCE_CLIENT_ID"),
    salesforceClientSecret: requiredEnv(env, "SALESFORCE_CLIENT_SECRET"),
    approvalProperty: configuredName(
      env,
      "NOTION_APPROVAL_PROPERTY",
      "Meeting Outcome Status"
    ),
    approvedValue: configuredName(env, "NOTION_APPROVED_VALUE", "Approved"),
    revisionProperty: configuredName(
      env,
      "NOTION_APPROVED_REVISION_PROPERTY",
      "Approved Revision"
    ),
    fingerprintProperty: configuredName(
      env,
      "NOTION_APPROVED_FINGERPRINT_PROPERTY",
      "Approved Fingerprint"
    ),
    receiptProperty: configuredName(
      env,
      "NOTION_SALESFORCE_RECEIPT_PROPERTY",
      "Salesforce Receipt"
    ),
    meetingTaskStatus: configuredName(
      env,
      "SALESFORCE_MEETING_TASK_STATUS",
      "Completed"
    ),
    followUpTaskStatus: configuredName(
      env,
      "SALESFORCE_FOLLOW_UP_TASK_STATUS",
      "Not Started"
    ),
    allowedTaskOwnerIds: parseIdSet(
      env,
      "SALESFORCE_ALLOWED_TASK_OWNER_IDS",
      25
    ),
    allowedStageTransitions: parseStageTransitions(
      env.SALESFORCE_ALLOWED_STAGE_TRANSITIONS
    ),
  }
}
