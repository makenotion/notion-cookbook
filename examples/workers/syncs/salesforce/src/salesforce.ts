// Salesforce REST API client. Handles OAuth bearer headers, SOQL query
// pagination, configured org URLs, and rate-limit responses.

import { RateLimitError } from "@notionhq/workers"

export const SALESFORCE_API_VERSION = "v67.0"
const QUERY_BATCH_SIZE = 2_000

export type BeforeRequest = () => Promise<void>
export type GetAccessToken = () => Promise<string>

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

function configuredOrigin(
  name: string,
  fallback: string | undefined = undefined
): string {
  const raw = process.env[name]?.trim() || fallback
  if (!raw) throw new Error(`${name} is not set.`)

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

export function getSalesforceLoginUrl(): string {
  return configuredOrigin(
    "SALESFORCE_LOGIN_URL",
    "https://login.salesforce.com"
  )
}

export function getSalesforceInstanceUrl(): string {
  return configuredOrigin("SALESFORCE_INSTANCE_URL")
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
  getAccessToken: GetAccessToken,
  beforeRequest: BeforeRequest
): SalesforceClient {
  const instanceUrl = getSalesforceInstanceUrl()

  async function fetchJson<T>(url: URL): Promise<T> {
    await beforeRequest()
    const accessToken = await getAccessToken()
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Sforce-Query-Options": `batchSize=${QUERY_BATCH_SIZE}`,
      },
      redirect: "error",
    })

    const text = await response.text()
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

  return {
    instanceUrl,
    async queryPage<T>(
      soql: string,
      cursor?: string,
      includeDeleted = false
    ): Promise<SalesforceQueryPage<T>> {
      const url = cursor
        ? queryCursorUrl(instanceUrl, cursor)
        : new URL(
            `/services/data/${SALESFORCE_API_VERSION}/${includeDeleted ? "queryAll/" : "query/"}`,
            instanceUrl
          )
      if (!cursor) url.searchParams.set("q", soql)

      const response = await fetchJson<SalesforceQueryResponse<T>>(url)
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
