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
// 401/403 during the approval window. Two consequences ported here:
//
//   • fetchEuipoOverlays treats a data-call 401/403 as "overlay not yet
//     available" (warn + empty result), NOT a source failure — pending
//     approval is a normal onboarding state, and failing on it would keep
//     a strict backfill from ever running while you wait.
//   • probeEuipo probes a REAL data call. A token probe would show green
//     for the whole approval window while every data call fails.
//
// EXTEND: the same payload carries the disclaimer text and opposition /
// cancellation proceedings — map them here if your schema wants them.

import { fetchWithTimeout } from "../engine/http.js"
import type { OfficialOverlay } from "./types.js"

const EUIPO_TOKEN_URL =
  "https://euipo.europa.eu/cas-server-webapp/oidc/accessToken"
const EUIPO_TM_URL = (num: string) =>
  `https://api.euipo.europa.eu/trademark-search/trademarks/${encodeURIComponent(num)}`

type AnyRec = Record<string, unknown>
const rec = (v: unknown): AnyRec =>
  v && typeof v === "object" ? (v as AnyRec) : {}
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== ""
    ? v.trim()
    : typeof v === "number"
      ? String(v)
      : null
const day = (v: unknown): string | null => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(str(v) ?? "")
  return m ? m[1] : null
}

// Credentials read at call time (see ipaustralia.ts for why). A token
// failure throws plainly: post-approval it means bad credentials, and
// that belongs in sync health, not behind an empty overlay.
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

const dataHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  // Yes, both: the Bearer token authenticates, the client id routes the
  // request to your API subscription. Omitting either 403s.
  "X-IBM-Client-Id": process.env.EUIPO_CLIENT_ID ?? "",
  Accept: "application/json",
})

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
    const res = await fetchWithTimeout(EUIPO_TM_URL(num), {
      headers: dataHeaders(token),
    })
    if (res.status === 401 || res.status === 403) {
      // Pending-approval (or a lapsed subscription): degrade the whole
      // batch — every remaining call would fail the same way. The rows
      // keep their TMview data; the health row (probeEuipo) is what turns
      // red until EUIPO approves.
      console.warn(
        `[euipo] data call ${res.status} — API subscription likely pending approval; overlay skipped this cycle`
      )
      return {}
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
    out[num] = {
      status: str(d.status),
      statusDate: day(d.statusDate),
      applicationDate: day(d.applicationDate),
      registrationDate: day(d.registrationDate),
      renewalDue: day(d.expiryDate),
    }
  }
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
  const res = await fetchWithTimeout(EUIPO_TM_URL("000000001"), {
    headers: dataHeaders(token),
  })
  if (res.status === 404) return // auth worked; the number just isn't real
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `EUIPO data call ${res.status} — API subscription pending approval or revoked`
    )
  }
  if (!res.ok) throw new Error(`EUIPO probe ${res.status}`)
}
