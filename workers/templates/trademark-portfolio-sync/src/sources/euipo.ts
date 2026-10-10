// ──────────────────────────────────────────────────────────────────────
// EUIPO overlay (live, official) — authoritative EUTM enrichment
// ──────────────────────────────────────────────────────────────────────
//
// The official Trademark Search API (register at dev.euipo.europa.eu):
// CAS OAuth2 client-credentials, plus an X-IBM-Client-Id header on every
// data call. Free, but the API subscription needs manual approval — which
// is why config.sources.euipo ships off. Adds what TMview lacks for EU
// rows: the official status date and expiry.
//
// THE ONBOARDING TRAP, learned the hard way: CAS issues perfectly valid
// tokens BEFORE your API subscription is approved — only the data calls
// 401/403 during the approval window. Two consequences matter here:
//
//   • fetchEuipoOverlays throws on a data-call 401/403. The join already
//     treats overlays as optional, while resilience can preserve a prior
//     overlay. Returning {} would incorrectly record the outage as a fresh
//     successful snapshot and discard that authoritative data.
//   • probeEuipo probes a REAL data call. A token probe would show green
//     for the whole approval window while every data call fails.
//
// EXTEND: the same payload carries the disclaimer text and opposition /
// cancellation proceedings — map them here if your schema wants them.

import { fetchWithTimeout } from "../engine/http.js"
import { strictIsoDay } from "../engine/date.js"
import type { OfficialOverlay } from "./types.js"

const EUIPO_TOKEN_URL =
  "https://euipo.europa.eu/cas-server-webapp/oidc/accessToken"
const EUIPO_TM_URL = (num: string) =>
  `https://api.euipo.europa.eu/trademark-search/trademarks/${encodeURIComponent(num)}`
const EUIPO_API_ORIGIN = "https://api.euipo.europa.eu"
const MAX_DATA_REDIRECTS = 5

type AnyRec = Record<string, unknown>
const rec = (v: unknown): AnyRec =>
  v && typeof v === "object" ? (v as AnyRec) : {}
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== ""
    ? v.trim()
    : typeof v === "number"
      ? String(v)
      : null
// Credentials read at call time (see ipaustralia.ts for why). A token failure
// throws plainly: it belongs in sync health, not behind an empty overlay.
async function euipoToken(pace: () => Promise<void>): Promise<string> {
  const id = process.env.EUIPO_CLIENT_ID
  const secret = process.env.EUIPO_CLIENT_SECRET
  if (!id || !secret) {
    throw new Error(
      "EUIPO_CLIENT_ID / EUIPO_CLIENT_SECRET env vars are not set"
    )
  }
  await pace()
  const res = await fetchWithTimeout(EUIPO_TOKEN_URL, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: id,
      client_secret: secret,
      scope: "uid",
    }),
  })
  if (!res.ok) {
    throw new Error(
      `EUIPO token ${res.status}: ${await res.text().catch(() => "")}`
    )
  }
  const data = (await res.json()) as { access_token?: string }
  if (!data.access_token) throw new Error("EUIPO token: no access_token")
  return data.access_token
}

const isRedirectStatus = (status: number): boolean =>
  status === 301 ||
  status === 302 ||
  status === 303 ||
  status === 307 ||
  status === 308

function safeDataUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("EUIPO data call returned an invalid redirect URL")
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("EUIPO data redirects must use credential-free HTTPS URLs")
  return url
}

async function fetchEuipoData(
  url: string,
  token: string,
  pace: () => Promise<void>
): Promise<Response> {
  let current = safeDataUrl(url)
  for (let redirects = 0; ; redirects++) {
    // The caller paces the first request. Redirect hops are requests too and
    // consume the same shared official-API budget.
    if (redirects > 0) await pace()
    const headers: Record<string, string> = { Accept: "application/json" }
    // Both values authenticate only the exact EUIPO API origin. Recompute on
    // every hop so neither custom nor standard credentials reach storage/CDN
    // hosts; restore them if a later hop returns to the API origin.
    if (current.origin === EUIPO_API_ORIGIN && current.port === "") {
      headers.Authorization = `Bearer ${token}`
      headers["X-IBM-Client-Id"] = process.env.EUIPO_CLIENT_ID ?? ""
    }
    const response = await fetchWithTimeout(current.toString(), {
      headers,
      redirect: "manual",
    })
    if (!isRedirectStatus(response.status)) return response
    await response.body?.cancel().catch(() => undefined)
    if (redirects >= MAX_DATA_REDIRECTS)
      throw new Error(
        `EUIPO data call exceeded ${MAX_DATA_REDIRECTS} redirects`
      )
    const location = response.headers.get("location")
    if (!location) throw new Error("EUIPO data redirect omitted Location")
    current = safeDataUrl(new URL(location, current).toString())
  }
}

// Fetch official overlays for the given EUTM application numbers (as
// TMview reported them), keyed by that same number. `pace` is the pacer's
// wait() — called before every request.
export async function fetchEuipoOverlays(
  applicationNumbers: string[],
  pace: () => Promise<void>
): Promise<Record<string, OfficialOverlay>> {
  if (applicationNumbers.length === 0) return {}
  const token = await euipoToken(pace)
  const out: Record<string, OfficialOverlay> = {}
  for (const num of applicationNumbers) {
    await pace()
    const res = await fetchEuipoData(EUIPO_TM_URL(num), token, pace)
    if (res.status === 401 || res.status === 403) {
      // A resolved empty object would be recorded as a fresh LKG snapshot,
      // overwriting any previously authoritative overlay. Throw instead:
      // join treats this source as optional, while resilient runs can still
      // apply the prior snapshot.
      throw new Error(
        `EUIPO trademark ${num} ${res.status} — API subscription pending approval or revoked`
      )
    }
    if (res.status === 404) continue // number-format drift vs TMview
    if (!res.ok) {
      throw new Error(
        `EUIPO trademark ${num} ${res.status}: ${await res
          .text()
          .catch(() => "")}`
      )
    }
    const d = rec(await res.json())
    const overlay: OfficialOverlay = {
      status: str(d.status),
      statusDate: strictIsoDay(
        d.statusDate,
        `EUIPO trademark ${num} statusDate`
      ),
      applicationDate: strictIsoDay(
        d.applicationDate,
        `EUIPO trademark ${num} applicationDate`
      ),
      registrationDate: strictIsoDay(
        d.registrationDate,
        `EUIPO trademark ${num} registrationDate`
      ),
      renewalDue: strictIsoDay(
        d.expiryDate,
        `EUIPO trademark ${num} expiryDate`
      ),
    }
    if (Object.values(overlay).every((value) => value === null))
      throw new Error(
        `EUIPO trademark ${num}: response has no recognized fields`
      )
    out[num] = overlay
  }
  if (Object.keys(out).length === 0)
    throw new Error(
      "EUIPO returned no usable overlays for the requested application numbers"
    )
  return out
}

// Probes a REAL data call, not the token: CAS issues tokens even before
// the API subscription is approved, so a token probe would lie green
// through the whole approval window — this red row IS the onboarding
// signal. Any syntactically valid application number works: a 404 still
// proves auth + subscription (UP); 401/403 means pending or revoked
// (DOWN).
export async function probeEuipo(pace: () => Promise<void>): Promise<void> {
  const token = await euipoToken(pace)
  await pace()
  const res = await fetchEuipoData(EUIPO_TM_URL("000000001"), token, pace)
  if (res.status === 404) return // auth worked; the number just isn't real
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `EUIPO data call ${res.status} — API subscription pending approval or revoked`
    )
  }
  if (!res.ok) throw new Error(`EUIPO probe ${res.status}`)
}
