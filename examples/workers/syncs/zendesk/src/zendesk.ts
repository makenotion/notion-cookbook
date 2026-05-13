import type { ZdIncrementalResponse } from "./types.js"

// Zendesk API tokens authenticate via HTTP Basic with a username of the
// form `<email>/token` (literally — the slash and the word "token") and
// the API token as the password. See:
// https://developer.zendesk.com/api-reference/introduction/security-and-auth/
function basicAuthHeader(): string {
  const email = process.env.ZENDESK_EMAIL
  const token = process.env.ZENDESK_API_TOKEN
  if (!email || !token) {
    throw new Error(
      "ZENDESK_EMAIL and ZENDESK_API_TOKEN must be set via `ntn workers env set`."
    )
  }
  const encoded = Buffer.from(`${email}/token:${token}`).toString("base64")
  return `Basic ${encoded}`
}

function baseUrl(): string {
  const subdomain = process.env.ZENDESK_SUBDOMAIN
  if (!subdomain) {
    throw new Error(
      "ZENDESK_SUBDOMAIN must be set (the `acme` in `acme.zendesk.com`)."
    )
  }
  return `https://${subdomain}.zendesk.com`
}

// Fetch one page of the cursor-based incremental tickets export.
//
// On the very first call (no cursor in state), pass `start_time` as a
// Unix-seconds epoch — Zendesk requires it to be at least 1 minute in
// the past, so 0 (Jan 1 1970) is the safest "everything since the
// beginning of time" sentinel.
//
// On subsequent calls, follow the `after_cursor` returned in the prior
// response.
export async function fetchIncrementalTickets(
  cursor: string | null
): Promise<ZdIncrementalResponse> {
  const params = new URLSearchParams()
  if (cursor) {
    params.set("cursor", cursor)
  } else {
    params.set("start_time", "0")
  }

  const res = await fetch(
    `${baseUrl()}/api/v2/incremental/tickets/cursor?${params.toString()}`,
    { headers: { Authorization: basicAuthHeader() } }
  )

  if (!res.ok) {
    throw new Error(`Zendesk API error: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as ZdIncrementalResponse
}
