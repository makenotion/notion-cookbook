// Salesforce REST API client. Handles the External Client App client-
// credentials exchange, bearer-token renewal, SOQL query pagination, and
// rate-limit responses.

import { RateLimitError } from "@notionhq/workers"

export const SALESFORCE_API_VERSION = "v67.0"
const QUERY_BATCH_SIZE = 2_000

export type BeforeRequest = () => Promise<void>

export type SalesforceSession = {
  accessToken: string
  instanceUrl: string
}

export type SalesforceSessionProvider = {
  getSession(): Promise<SalesforceSession>
  invalidate(accessToken: string): void
}

export type SalesforceQueryPage<T> = {
  records: T[]
  done: boolean
  nextCursor?: string
}

export type SalesforceClient = {
  instanceUrl: string
  queryPage<T>(
    soql: string,
    cursor?: string,
    includeDeleted?: boolean
  ): Promise<SalesforceQueryPage<T>>
}

type SalesforceQueryResponse<T> = {
  totalSize: number
  done: boolean
  records: T[]
  nextRecordsUrl?: string
}

type SalesforceError = {
  errorCode?: string
  message?: string
}

type SalesforceTokenResponse = {
  access_token?: unknown
  instance_url?: unknown
  token_type?: unknown
  error?: unknown
  error_description?: unknown
}

function configuredOrigin(name: string): string {
  const raw = process.env[name]?.trim()
  if (!raw) throw new Error(`${name} is not set.`)

  return normalizeOrigin(raw, name)
}

function normalizeOrigin(raw: string, name: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${name} must be a valid HTTPS origin.`)
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(`${name} must be a valid HTTPS origin.`)
  }

  return url.origin
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is not set.`)
  return value
}

export function getSalesforceOrgUrl(): string {
  return configuredOrigin("SALESFORCE_ORG_URL")
}

function parseTokenResponse(text: string): SalesforceTokenResponse {
  try {
    const value: unknown = JSON.parse(text)
    return value != null && typeof value === "object"
      ? (value as SalesforceTokenResponse)
      : {}
  } catch {
    return {}
  }
}

async function requestSalesforceSession(): Promise<SalesforceSession> {
  const orgUrl = getSalesforceOrgUrl()
  const clientId = requiredEnv("SALESFORCE_CLIENT_ID")
  const clientSecret = requiredEnv("SALESFORCE_CLIENT_SECRET")
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64"
  )
  const response = await fetch(
    new URL("/services/oauth2/token", `${orgUrl}/`),
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
      redirect: "error",
    }
  )
  const text = await response.text()
  const token = parseTokenResponse(text)

  if (!response.ok) {
    const detail =
      typeof token.error_description === "string"
        ? token.error_description
        : typeof token.error === "string"
          ? token.error
          : "No error details returned"
    throw new Error(`Salesforce OAuth error (${response.status}): ${detail}`)
  }
  if (typeof token.access_token !== "string" || !token.access_token.trim()) {
    throw new Error("Salesforce OAuth response is missing access_token.")
  }
  if (typeof token.instance_url !== "string") {
    throw new Error("Salesforce OAuth response is missing instance_url.")
  }
  if (
    token.token_type !== undefined &&
    (typeof token.token_type !== "string" ||
      token.token_type.toLowerCase() !== "bearer")
  ) {
    throw new Error(
      "Salesforce OAuth response returned an unsupported token type."
    )
  }

  return {
    accessToken: token.access_token,
    instanceUrl: normalizeOrigin(
      token.instance_url,
      "Salesforce OAuth instance_url"
    ),
  }
}

export function createSalesforceSessionProvider(): SalesforceSessionProvider {
  let current: SalesforceSession | undefined
  let pending: Promise<SalesforceSession> | undefined

  return {
    async getSession() {
      if (current) return current

      pending ??= requestSalesforceSession()
        .then((session) => {
          current = session
          return session
        })
        .finally(() => {
          pending = undefined
        })
      return pending
    },
    invalidate(accessToken) {
      if (current?.accessToken === accessToken) current = undefined
    },
  }
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get("Retry-After")
  if (!value?.trim()) return undefined

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)

  const retryAt = Date.parse(value)
  if (Number.isNaN(retryAt)) return undefined
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000))
}

function parseSalesforceErrors(text: string): SalesforceError[] {
  try {
    const value: unknown = JSON.parse(text)
    return Array.isArray(value) ? (value as SalesforceError[]) : []
  } catch {
    return []
  }
}

function isRateLimitResponse(response: Response, text: string): boolean {
  if (response.status === 429) return true
  return parseSalesforceErrors(text).some(
    (error) => error.errorCode === "REQUEST_LIMIT_EXCEEDED"
  )
}

function queryCursorUrl(instanceUrl: string, cursor: string): URL {
  if (!cursor.startsWith("/")) {
    throw new Error("Salesforce pagination cursor must be a relative API path.")
  }

  const url = new URL(cursor, `${instanceUrl}/`)
  if (
    url.origin !== instanceUrl ||
    !url.pathname.startsWith(`/services/data/${SALESFORCE_API_VERSION}/query/`)
  ) {
    throw new Error("Salesforce pagination cursor is outside the query API.")
  }
  return url
}

export function createSalesforceClient(
  sessionProvider: SalesforceSessionProvider,
  beforeRequest: BeforeRequest
): SalesforceClient {
  let currentInstanceUrl = getSalesforceOrgUrl()

  async function fetchJson<T>(
    createUrl: (instanceUrl: string) => URL
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      await beforeRequest()
      const session = await sessionProvider.getSession()
      currentInstanceUrl = session.instanceUrl
      const response = await fetch(createUrl(session.instanceUrl), {
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          Accept: "application/json",
          "Sforce-Query-Options": `batchSize=${QUERY_BATCH_SIZE}`,
        },
        redirect: "error",
      })

      const text = await response.text()
      if (response.status === 401 && attempt === 0) {
        sessionProvider.invalidate(session.accessToken)
        continue
      }
      if (isRateLimitResponse(response, text)) {
        throw new RateLimitError({ retryAfter: retryAfterSeconds(response) })
      }
      if (!response.ok) {
        throw new Error(
          `Salesforce API error (${response.status}): ${text || "No response body"}`
        )
      }

      return JSON.parse(text) as T
    }

    throw new Error("Salesforce API authentication failed after token renewal.")
  }

  return {
    get instanceUrl() {
      return currentInstanceUrl
    },
    async queryPage<T>(
      soql: string,
      cursor?: string,
      includeDeleted = false
    ): Promise<SalesforceQueryPage<T>> {
      const response = await fetchJson<SalesforceQueryResponse<T>>(
        (instanceUrl) => {
          const url = cursor
            ? queryCursorUrl(instanceUrl, cursor)
            : new URL(
                `/services/data/${SALESFORCE_API_VERSION}/${includeDeleted ? "queryAll/" : "query/"}`,
                instanceUrl
              )
          if (!cursor) url.searchParams.set("q", soql)
          return url
        }
      )
      if (!response.done && !response.nextRecordsUrl?.trim()) {
        throw new Error(
          "Salesforce pagination response is missing nextRecordsUrl."
        )
      }

      return {
        records: response.records,
        done: response.done,
        nextCursor: response.done ? undefined : response.nextRecordsUrl,
      }
    },
  }
}
