// ──────────────────────────────────────────────────────────────────────
// IP Australia overlay (live, official) — authoritative AU enrichment
// ──────────────────────────────────────────────────────────────────────
//
// The official Australian Trade Mark Search API: OAuth client-credentials,
// free but registration required, which is why config.sources.ipAustralia
// ships off. TMview stays the enumerator — for each AU mark it finds, one
// GET here refines the row with office-authoritative status, renewal due
// date, and register dates. Overlays are enrichment, never row-defining:
// a per-mark failure skips that mark's refinement; only a token failure
// fails the source (bad credentials should show up in sync health, not
// hide behind an empty overlay).
//
// A typical portfolio has a handful of AU marks, so every cycle simply
// refetches them all — no cache machinery to go stale.

import { fetchWithTimeout } from "../engine/http.js"
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
const day = (v: unknown): string | null => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(str(v) ?? "")
  return m ? m[1] : null
}

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
    let d: AnyRec
    try {
      const res = await fetchWithTimeout(IPA_TM_URL(num), {
        headers: { Authorization: auth, Accept: "application/json" },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      d = rec(await res.json())
    } catch (err) {
      // Per-number failures — a 404 from number-format drift vs TMview, a
      // transient 5xx — skip that mark's overlay. The ForeignMark row
      // still exists; only this cycle's refinement is missing, and the
      // fingerprint self-heals it on recovery.
      console.warn(`[ipAustralia] trade-mark ${num}: ${String(err)} — skipped`)
      continue
    }
    out[num] = {
      status: str(d.statusDetail), // e.g. "Registered/protected"
      statusDate: day(d.statusDate), // rarely present on this endpoint
      applicationDate: day(d.lodgementDate),
      registrationDate: day(d.enteredOnRegisterDate),
      renewalDue: day(d.renewalDueDate),
    }
  }
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
