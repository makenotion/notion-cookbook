import {
  assertAllowedZendeskApiUrl,
  requireZendeskAuthorization,
} from "./config.js"

export async function zendeskFetchJson<T>(
  url: string,
  errorPrefix: string,
  subdomain: string
): Promise<T> {
  assertAllowedZendeskApiUrl(url, subdomain)
  const authorization = requireZendeskAuthorization()

  const response = await fetch(url, {
    headers: {
      Authorization: authorization,
      Accept: "application/json",
    },
    redirect: "error",
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `${errorPrefix} (${response.status}): ${text || "No response body"}`
    )
  }

  return JSON.parse(text) as T
}
