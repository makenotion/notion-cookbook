// Offline tests — no Notion or Zendesk network calls.
// Run: npm test  (or: npx tsx test.ts)
import { createHmac } from "node:crypto"
import {
  verifyZendeskWebhookSignature,
  SIGNATURE_REPLAY_WINDOW_SECONDS,
} from "./src/zendesk/config.js"
import { parseZendeskTicket } from "./src/parse-ticket.js"
import { zendeskApiStatusToNotionStatus } from "./src/zendesk/status.js"
import { normalizeNotionDatabaseId } from "./src/notion.js"

let passed = 0
let failed = 0

function ok(name: string, cond: boolean) {
  if (cond) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}`)
  }
}

function throws(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

// ---------------------------------------------------------------------------
// HMAC signature verification + replay protection
// ---------------------------------------------------------------------------

const SECRET = "test-secret-abc123"
const BODY = JSON.stringify({ ticket_id: "42", subject: "Test" })
const NOW_ISO = new Date().toISOString()

function makeSignature(
  secret: string,
  timestamp: string,
  body: string
): string {
  return createHmac("sha256", secret)
    .update(timestamp + body)
    .digest("base64")
}

console.log("verifyZendeskWebhookSignature:")
ok(
  "accepts a valid signature",
  verifyZendeskWebhookSignature(
    BODY,
    {
      "x-zendesk-webhook-signature": makeSignature(SECRET, NOW_ISO, BODY),
      "x-zendesk-webhook-signature-timestamp": NOW_ISO,
    },
    SECRET
  )
)
ok(
  "rejects a wrong signature",
  !verifyZendeskWebhookSignature(
    BODY,
    {
      "x-zendesk-webhook-signature": "badsignature==",
      "x-zendesk-webhook-signature-timestamp": NOW_ISO,
    },
    SECRET
  )
)
ok(
  "rejects missing signature header",
  !verifyZendeskWebhookSignature(
    BODY,
    {
      "x-zendesk-webhook-signature-timestamp": NOW_ISO,
    },
    SECRET
  )
)
ok(
  "rejects missing timestamp header",
  !verifyZendeskWebhookSignature(
    BODY,
    {
      "x-zendesk-webhook-signature": makeSignature(SECRET, NOW_ISO, BODY),
    },
    SECRET
  )
)
// Replay: timestamp older than the window
const STALE_ISO = new Date(
  Date.now() - (SIGNATURE_REPLAY_WINDOW_SECONDS + 10) * 1000
).toISOString()
ok(
  "rejects stale timestamp (replay protection)",
  !verifyZendeskWebhookSignature(
    BODY,
    {
      "x-zendesk-webhook-signature": makeSignature(SECRET, STALE_ISO, BODY),
      "x-zendesk-webhook-signature-timestamp": STALE_ISO,
    },
    SECRET
  )
)
ok(
  "rejects unparseable timestamp",
  !verifyZendeskWebhookSignature(
    BODY,
    {
      "x-zendesk-webhook-signature": makeSignature(SECRET, "not-a-date", BODY),
      "x-zendesk-webhook-signature-timestamp": "not-a-date",
    },
    SECRET
  )
)

// ---------------------------------------------------------------------------
// parseZendeskTicket
// ---------------------------------------------------------------------------

console.log("parseZendeskTicket:")

const FLAT_BODY = {
  ticket_id: "99",
  subject: "Login broken",
  email: "user@example.com",
  description: "Cannot log in.",
  assignee: "Support",
  status: "open",
  latest_comment: "We are looking into it.",
  created_at: "2024-01-15T10:00:00Z",
  ticket_url: "https://acme.zendesk.com/agent/tickets/99",
}

const flat = parseZendeskTicket(FLAT_BODY)
ok("flat shape: ticketId", flat?.ticketId === "99")
ok("flat shape: subject", flat?.subject === "Login broken")
ok("flat shape: email", flat?.email === "user@example.com")
ok("flat shape: status", flat?.status === "open")

const NESTED_BODY = {
  ticket: {
    id: "200",
    subject: "Feature request",
    email: "req@example.com",
    description: "Please add X.",
    status: "new",
    assignee: "",
    latest_comment: "",
    created_at: "2024-02-01T08:00:00Z",
    ticket_url: "https://acme.zendesk.com/agent/tickets/200",
  },
}

const nested = parseZendeskTicket(NESTED_BODY)
ok("nested shape: ticketId", nested?.ticketId === "200")
ok("nested shape: subject", nested?.subject === "Feature request")

ok(
  "returns null when ticketId missing",
  parseZendeskTicket({ subject: "No id" }) === null
)
ok(
  "returns null when subject missing",
  parseZendeskTicket({ ticket_id: "1" }) === null
)
ok("returns null for empty body", parseZendeskTicket({}) === null)

// ---------------------------------------------------------------------------
// Zendesk → Notion status mapping
// ---------------------------------------------------------------------------

console.log("zendeskApiStatusToNotionStatus:")
ok("new → New", zendeskApiStatusToNotionStatus("new") === "New")
ok("open → Open", zendeskApiStatusToNotionStatus("open") === "Open")
ok("pending → Pending", zendeskApiStatusToNotionStatus("pending") === "Pending")
ok("hold → On-hold", zendeskApiStatusToNotionStatus("hold") === "On-hold")
ok("solved → Solved", zendeskApiStatusToNotionStatus("solved") === "Solved")
ok("closed → Closed", zendeskApiStatusToNotionStatus("closed") === "Closed")
ok(
  "unknown returns undefined",
  zendeskApiStatusToNotionStatus("bogus") === undefined
)

// ---------------------------------------------------------------------------
// normalizeNotionDatabaseId
// ---------------------------------------------------------------------------

console.log("normalizeNotionDatabaseId:")
const BARE_ID = "550e8400e29b41d4a716446655440000"
ok(
  "bare 32-char id passes through",
  normalizeNotionDatabaseId(BARE_ID) === BARE_ID
)

const HYPHENATED = "550e8400-e29b-41d4-a716-446655440000"
ok(
  "hyphenated UUID normalizes to bare",
  normalizeNotionDatabaseId(HYPHENATED) === BARE_ID.toLowerCase()
)

const NOTION_URL = `https://www.notion.so/My-DB-${BARE_ID}`
ok(
  "Notion URL extracts bare id",
  normalizeNotionDatabaseId(NOTION_URL) === BARE_ID
)

const NOTION_URL_HYPHENATED = `https://www.notion.so/workspace/My-DB-${HYPHENATED}`
ok(
  "Notion URL with hyphenated uuid extracts and strips hyphens",
  normalizeNotionDatabaseId(NOTION_URL_HYPHENATED) === BARE_ID.toLowerCase()
)

ok(
  "rejects garbage",
  throws(() => normalizeNotionDatabaseId("not-an-id"))
)

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
