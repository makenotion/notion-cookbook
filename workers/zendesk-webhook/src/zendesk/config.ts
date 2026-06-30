import { createHmac, timingSafeEqual } from "node:crypto"
import { WebhookVerificationError } from "@notionhq/workers"

// Replay-protection window: reject deliveries whose timestamp is older than this.
export const SIGNATURE_REPLAY_WINDOW_SECONDS = 300

function normalizeBasicAuth(value: string): string {
  const trimmed = value.trim()
  if (/^basic /i.test(trimmed)) return trimmed
  return `Basic ${trimmed}`
}

export function getZendeskWebhookSecret(): string {
  const secret = process.env.ZENDESK_WEBHOOK_SECRET?.trim()
  if (!secret) {
    throw new WebhookVerificationError(
      "ZENDESK_WEBHOOK_SECRET is not set. Set it in your environment (e.g. a local .env or via your platform's secrets)."
    )
  }
  return secret
}

function getHeader(headers: Record<string, string>, name: string): string {
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value
  }
  return ""
}

// Verifies a Zendesk webhook per
// https://developer.zendesk.com/documentation/webhooks/verifying/
//
// signature = base64(HMAC-SHA256(secret, timestamp + rawBody))
//
// Also rejects replays: the timestamp must be within SIGNATURE_REPLAY_WINDOW_SECONDS
// of the current clock to prevent an attacker from reusing a captured signature.
export function verifyZendeskWebhookSignature(
  rawBody: string,
  headers: Record<string, string>,
  secret: string
): boolean {
  const signature = getHeader(headers, "x-zendesk-webhook-signature")
  const timestamp = getHeader(headers, "x-zendesk-webhook-signature-timestamp")
  if (!signature || !timestamp || !secret) return false

  // Replay protection — reject if the timestamp is absent, unparseable, or stale.
  const timestampMs = Date.parse(timestamp)
  if (Number.isNaN(timestampMs)) return false
  const ageSeconds = (Date.now() - timestampMs) / 1000
  if (ageSeconds > SIGNATURE_REPLAY_WINDOW_SECONDS || ageSeconds < 0)
    return false

  const expected = createHmac("sha256", secret)
    .update(timestamp + rawBody)
    .digest("base64")

  try {
    const received = Buffer.from(signature, "utf8")
    const computed = Buffer.from(expected, "utf8")
    if (received.length !== computed.length) return false
    return timingSafeEqual(received, computed)
  } catch {
    return false
  }
}

// Pre-built Zendesk Authorization header value.
// Prefer ZENDESK_BASIC_AUTH_TOKEN (base64 or `Basic <base64>`).
// ZENDESK_AUTHORIZATION is an alias for a full header (`Basic …` or `Bearer …`).
export function getZendeskAuthorizationHeader(): string | undefined {
  const basicAuthToken = process.env.ZENDESK_BASIC_AUTH_TOKEN?.trim()
  if (basicAuthToken) return normalizeBasicAuth(basicAuthToken)

  const authorization = process.env.ZENDESK_AUTHORIZATION?.trim()
  if (authorization) {
    if (/^(basic|bearer) /i.test(authorization)) return authorization
    return normalizeBasicAuth(authorization)
  }

  const apiToken = process.env.ZENDESK_API_TOKEN?.trim()
  if (!apiToken) return undefined

  // Zendesk API tokens authenticate via Basic auth as `email/token:apitoken`,
  // not Bearer — so the email is required. Fail loudly instead of emitting a
  // Bearer header that would 401 with a confusing error.
  const email = process.env.ZENDESK_API_USER_EMAIL?.trim()
  if (!email) {
    throw new Error(
      "ZENDESK_API_USER_EMAIL is required when using ZENDESK_API_TOKEN (Zendesk API tokens use Basic auth: email/token:apitoken)."
    )
  }

  return `Basic ${Buffer.from(`${email}/token:${apiToken}`).toString("base64")}`
}

export function getZendeskSubdomainFromTicketUrl(
  ticketUrl: string
): string | null {
  const trimmed = ticketUrl.trim()
  if (!trimmed) return null
  const match = /^https:\/\/([a-z0-9-]+)\.zendesk\.com/i.exec(trimmed)
  return match?.[1]?.toLowerCase() ?? null
}

export function resolveZendeskSubdomain(ticketUrl: string): string {
  const fromUrl = getZendeskSubdomainFromTicketUrl(ticketUrl)
  if (fromUrl) return fromUrl

  const fromEnv = process.env.ZENDESK_SUBDOMAIN?.trim()
  if (fromEnv) return fromEnv

  throw new Error(
    "Cannot resolve Zendesk subdomain. Set ZENDESK_SUBDOMAIN or include ticket_url (https://{subdomain}.zendesk.com/...)."
  )
}

export function zendeskApiBaseUrl(subdomain: string): string {
  return `https://${subdomain}.zendesk.com/api/v2`
}

// Only allow HTTPS requests to the configured subdomain's Zendesk REST API.
export function isAllowedZendeskApiUrl(
  url: string,
  subdomain: string
): boolean {
  try {
    const parsed = new URL(url)
    const normalizedSubdomain = subdomain.trim().toLowerCase()
    if (!normalizedSubdomain) return false
    if (parsed.protocol !== "https:") return false
    if (
      parsed.hostname.toLowerCase() !== `${normalizedSubdomain}.zendesk.com`
    ) {
      return false
    }
    if (!parsed.pathname.startsWith("/api/v2/")) return false
    return true
  } catch {
    return false
  }
}

export function assertAllowedZendeskApiUrl(
  url: string,
  subdomain: string
): void {
  if (!isAllowedZendeskApiUrl(url, subdomain)) {
    throw new Error(
      `Refusing to call Zendesk API with untrusted URL (expected https://${subdomain}.zendesk.com/api/v2/...).`
    )
  }
}

export function requireZendeskAuthorization(): string {
  const authorization = getZendeskAuthorizationHeader()
  if (!authorization) {
    throw new Error(
      "Zendesk API credentials are not configured. Set ZENDESK_BASIC_AUTH_TOKEN (or ZENDESK_AUTHORIZATION / ZENDESK_API_TOKEN + ZENDESK_API_USER_EMAIL) in your environment."
    )
  }
  return authorization
}
