// ──────────────────────────────────────────────────────────────────────
// IP Australia overlay (live, official) — authoritative AU enrichment
// ──────────────────────────────────────────────────────────────────────
//
// The official Australian Trade Mark Search API: OAuth client-credentials,
// free but registration required, which is why config.sources.ipAustralia
// ships off. TMview stays the enumerator — for each AU mark it finds, one
// GET here refines the row with office-authoritative status, renewal due
// date, and register dates. Overlays are enrichment, never row-defining, but
// transient per-mark failures still fail the overlay batch atomically. This
// lets resilience preserve the prior complete overlay instead of recording a
// partial result as a fresh last-known-good snapshot. Definitive 404s alone
// may skip a number because TMview and the official API format them differently.
//
// A typical portfolio has a handful of AU marks, so every cycle simply
// refetches them all — no cache machinery to go stale.

import { fetchWithTimeout } from "../engine/http.js"
import { strictIsoDay } from "../engine/date.js"
import type { OfficialOverlay } from "./types.js"

const IPA_BASE = "https://production.api.ipaustralia.gov.au"
const IPA_TOKEN_URL = `${IPA_BASE}/public/external-token-api/v1/access_token`
const IPA_TM_URL = (num: string) =>
  `${IPA_BASE}/public/australian-trade-mark-search-api/v1/trade-mark/${num}`

type AnyRec = Record<string, unknown>
const rec = (v: unknown): AnyRec =>
  v && typeof v === "object" ? (v as AnyRec) : {}
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== ""
    ? v.trim()
    : typeof v === "number"
      ? String(v)
      : null
// Credentials are read at call time, not module scope — a deploy-time
// snapshot would bake in an empty value, and pushing env vars must take
// effect on the next run without a redeploy.
async function ipaToken(pace: () => Promise<void>): Promise<string> {
  const id = process.env.IPA_CLIENT_ID
  const secret = process.env.IPA_CLIENT_SECRET
  if (!id || !secret) {
    throw new Error("IPA_CLIENT_ID / IPA_CLIENT_SECRET env vars are not set")
  }
  await pace()
  const res = await fetchWithTimeout(IPA_TOKEN_URL, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: id,
      client_secret: secret,
    }),
  })
  if (!res.ok) {
    throw new Error(
      `IPA token ${res.status}: ${await res.text().catch(() => "")}`
    )
  }
  const data = (await res.json()) as {
    access_token?: string
    token_type?: string
  }
  if (!data.access_token) throw new Error("IPA token: no access_token")
  return `${data.token_type ?? "Bearer"} ${data.access_token}`
}

// Fetch official overlays for the given AU application numbers (as TMview
// reported them), keyed by that same number. `pace` is the pacer's
// wait() — called before every request.
export async function fetchIpaOverlays(
  applicationNumbers: string[],
  pace: () => Promise<void>
): Promise<Record<string, OfficialOverlay>> {
  if (applicationNumbers.length === 0) return {}
  const auth = await ipaToken(pace)
  const out: Record<string, OfficialOverlay> = {}
  for (const num of applicationNumbers) {
    await pace()
    const res = await fetchWithTimeout(IPA_TM_URL(num), {
      headers: { Authorization: auth, Accept: "application/json" },
      redirect: "error",
    })
    // A genuine not-found can reflect number-format drift between TMview
    // and the official register. All auth, rate-limit, server, network, and
    // parse failures fail the batch atomically so a partial object cannot
    // overwrite the previous complete LKG snapshot.
    if (res.status === 404) continue
    if (!res.ok) {
      throw new Error(
        `IP Australia trade-mark ${num} ${res.status}: ${await res
          .text()
          .catch(() => "")}`
      )
    }
    const d = rec(await res.json())
    const overlay: OfficialOverlay = {
      status: str(d.statusDetail), // e.g. "Registered/protected"
      statusDate: strictIsoDay(
        d.statusDate,
        `IP Australia trade-mark ${num} statusDate`
      ), // rarely present on this endpoint
      applicationDate: strictIsoDay(
        d.lodgementDate,
        `IP Australia trade-mark ${num} lodgementDate`
      ),
      registrationDate: strictIsoDay(
        d.enteredOnRegisterDate,
        `IP Australia trade-mark ${num} enteredOnRegisterDate`
      ),
      renewalDue: strictIsoDay(
        d.renewalDueDate,
        `IP Australia trade-mark ${num} renewalDueDate`
      ),
    }
    if (Object.values(overlay).every((value) => value === null))
      throw new Error(
        `IP Australia trade-mark ${num}: response has no recognized fields`
      )
    out[num] = overlay
  }
  if (Object.keys(out).length === 0)
    throw new Error(
      "IP Australia returned no usable overlays for the requested application numbers"
    )
  return out
}

// The token fetch alone proves credentials + reachability — unlike EUIPO
// (see euipo.ts), IP Australia does not issue tokens for unapproved
// clients, so there is no need to spend a data call on the probe.
export async function probeIpAustralia(
  pace: () => Promise<void>
): Promise<void> {
  await ipaToken(pace)
}
