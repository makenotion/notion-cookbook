import type { SfQueryResponse } from "./types.js"

// Salesforce REST API version. Bump when you need newer SOQL features.
// See https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/dome_versions.htm
const API_VERSION = "v59.0"

// Salesforce's OAuth token endpoint returns an `instance_url`, but
// `worker.oauth(...).accessToken()` only exposes the bearer token. We
// derive the instance URL by calling `/services/oauth2/userinfo` against
// the global login host — that endpoint accepts tokens from any instance
// and reports the user's URLs in the response.
//
// One lookup per worker invocation is cheap; we cache it in module scope
// so multiple API calls in the same `execute` share it.
let cachedInstanceUrl: string | null = null

async function discoverInstanceUrl(accessToken: string): Promise<string> {
  if (cachedInstanceUrl) return cachedInstanceUrl

  const res = await fetch(
    "https://login.salesforce.com/services/oauth2/userinfo",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (!res.ok) {
    throw new Error(
      `Salesforce userinfo lookup failed: ${res.status} ${await res.text()}`
    )
  }
  const data = (await res.json()) as { urls?: { rest?: string } }
  const restUrl = data.urls?.rest
  if (!restUrl) {
    throw new Error("Salesforce userinfo response did not include `urls.rest`")
  }
  // `urls.rest` looks like `https://acme.my.salesforce.com/services/data/v{version}/`.
  cachedInstanceUrl = restUrl.split("/services/")[0]
  return cachedInstanceUrl
}

interface SalesforceClient {
  soql<T>(query: string): Promise<SfQueryResponse<T>>
  next<T>(nextRecordsUrl: string): Promise<SfQueryResponse<T>>
}

export async function getSalesforceClient(
  getToken: () => Promise<string>
): Promise<SalesforceClient> {
  const token = await getToken()
  const instanceUrl = await discoverInstanceUrl(token)

  async function sfFetch<T>(path: string): Promise<SfQueryResponse<T>> {
    // Always re-read the token in case it was refreshed since we cached
    // the instance URL.
    const currentToken = await getToken()
    const res = await fetch(`${instanceUrl}${path}`, {
      headers: { Authorization: `Bearer ${currentToken}` },
    })
    if (!res.ok) {
      throw new Error(`Salesforce API error: ${res.status} ${await res.text()}`)
    }
    return (await res.json()) as SfQueryResponse<T>
  }

  return {
    soql: (query) =>
      sfFetch(
        `/services/data/${API_VERSION}/query?q=${encodeURIComponent(query)}`
      ),
    next: (nextRecordsUrl) => sfFetch(nextRecordsUrl),
  }
}

// Format a JS Date / ISO string as a SOQL datetime literal. SOQL accepts
// `YYYY-MM-DDTHH:MM:SSZ` (ISO 8601) for datetime comparisons, without
// surrounding quotes (unlike string fields).
export function toSoqlDateTime(iso: string): string {
  // Trim milliseconds if present — `2024-01-15T10:30:00.123Z` → `2024-01-15T10:30:00Z`.
  return iso.replace(/\.\d{3}Z$/, "Z")
}
