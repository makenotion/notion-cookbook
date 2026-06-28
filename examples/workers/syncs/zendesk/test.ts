// Offline tests for the zendesk-sync worker.
// No Zendesk connection is made — all assertions run against pure functions.
// Run: npm test  (or: npx tsx test.ts)

import { ticketToChange, ticketUrl, dateOnly } from "./src/transform.js"
import { buildTicketsUrl, getAuthorizationHeader } from "./src/zendesk.js"
import type { ZendeskTicket } from "./src/zendesk.js"

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

// ---------------------------------------------------------------------------
// ticketToChange — maps a Zendesk ticket to a sync upsert change
// ---------------------------------------------------------------------------

console.log("ticketToChange — standard ticket:")

const SUBDOMAIN = "acme"

const standardTicket: ZendeskTicket = {
  id: 42,
  subject: "Cannot log in to my account",
  description: "I keep getting a 403 error when I try to log in.",
  type: "problem",
  status: "open",
  priority: "high",
  assignee_id: 1001,
  requester_id: 2001,
  tags: ["account_access", "login"],
  satisfaction_rating: { score: "good" },
  via: { channel: "email" },
  created_at: "2024-06-15T10:30:00Z",
  updated_at: "2024-06-16T14:00:00Z",
}

const change = ticketToChange(standardTicket, SUBDOMAIN)

ok("type is upsert", change.type === "upsert")
ok("key is ticket id as string", change.key === "42")
ok(
  "Tickets contains subject",
  JSON.stringify(change.properties.Tickets).includes(
    "Cannot log in to my account"
  )
)
ok(
  "Ticket ID contains id",
  JSON.stringify(change.properties["Ticket ID"]).includes("42")
)
ok(
  "Status is capitalized",
  JSON.stringify(change.properties.Status).includes("Open")
)
ok(
  "Priority is capitalized",
  JSON.stringify(change.properties.Priority).includes("High")
)
ok(
  "CSAT score is capitalized",
  JSON.stringify(change.properties["CSAT score"]).includes("Good")
)
ok(
  "Feature tags contains tags",
  JSON.stringify(change.properties["Feature tags"]).includes("account_access")
)
ok(
  "Ticket link contains URL",
  JSON.stringify(change.properties["Ticket link"]).includes(
    "https://acme.zendesk.com/agent/tickets/42"
  )
)
ok(
  "upstreamUpdatedAt is set",
  change.upstreamUpdatedAt === "2024-06-16T14:00:00Z"
)
ok(
  "pageContentMarkdown contains description",
  change.pageContentMarkdown.includes("403 error")
)
ok(
  "Type is capitalized",
  JSON.stringify(change.properties.Type).includes("Problem")
)
ok(
  "Channel is capitalized",
  JSON.stringify(change.properties.Channel).includes("Email")
)
ok(
  "Assignee ID is set",
  JSON.stringify(change.properties["Assignee ID"]).includes("1001")
)
ok(
  "Requester ID is set",
  JSON.stringify(change.properties["Requester ID"]).includes("2001")
)
ok(
  "Created at contains date",
  JSON.stringify(change.properties["Created at"]).includes("2024-06-15")
)

// ---------------------------------------------------------------------------
// ticketToChange — ticket with missing optional fields
// ---------------------------------------------------------------------------

console.log("ticketToChange — minimal ticket:")

const minimalTicket: ZendeskTicket = {
  id: 99,
  subject: "Quick question",
  description: "",
  type: null,
  status: "new",
  priority: null,
  assignee_id: null,
  requester_id: 3001,
  tags: [],
  satisfaction_rating: null,
  via: { channel: "web" },
  created_at: "2024-01-01",
  updated_at: "2024-01-01",
}

const minimalChange = ticketToChange(minimalTicket, SUBDOMAIN)

ok("key is ticket id", minimalChange.key === "99")
ok(
  "null priority omits Priority property",
  minimalChange.properties.Priority === undefined
)
ok(
  "null satisfaction_rating omits CSAT score",
  minimalChange.properties["CSAT score"] === undefined
)
ok(
  "empty tags omits Feature tags",
  minimalChange.properties["Feature tags"] === undefined
)
ok(
  "null type omits Type property",
  minimalChange.properties.Type === undefined
)
ok(
  "null assignee_id omits Assignee ID",
  minimalChange.properties["Assignee ID"] === undefined
)
ok(
  "requester_id is always set",
  JSON.stringify(minimalChange.properties["Requester ID"]).includes("3001")
)

// ---------------------------------------------------------------------------
// ticketToChange — unknown CSAT score is omitted
// ---------------------------------------------------------------------------

console.log("ticketToChange — unknown CSAT score:")

const unofferedTicket: ZendeskTicket = {
  ...standardTicket,
  id: 50,
  satisfaction_rating: { score: "unoffered" },
}

const unofferedChange = ticketToChange(unofferedTicket, SUBDOMAIN)

ok(
  "unoffered CSAT score is omitted",
  unofferedChange.properties["CSAT score"] === undefined
)

// ---------------------------------------------------------------------------
// dateOnly — extracts YYYY-MM-DD from various formats
// ---------------------------------------------------------------------------

console.log("dateOnly:")

ok(
  "ISO timestamp returns date part",
  dateOnly("2024-03-15T12:00:00Z") === "2024-03-15"
)
ok("plain date passes through", dateOnly("2024-03-15") === "2024-03-15")
ok("empty string returns empty", dateOnly("") === "")

// ---------------------------------------------------------------------------
// ticketUrl — builds Zendesk agent URL
// ---------------------------------------------------------------------------

console.log("ticketUrl:")

ok(
  "builds correct URL",
  ticketUrl("acme", 42) === "https://acme.zendesk.com/agent/tickets/42"
)

// ---------------------------------------------------------------------------
// buildTicketsUrl — constructs Zendesk API URL
// ---------------------------------------------------------------------------

console.log("buildTicketsUrl:")

ok(
  "builds URL without cursor",
  buildTicketsUrl("acme") ===
    "https://acme.zendesk.com/api/v2/tickets.json?page%5Bsize%5D=100"
)

ok(
  "builds URL with cursor",
  buildTicketsUrl("acme", "abc123") ===
    "https://acme.zendesk.com/api/v2/tickets.json?page%5Bsize%5D=100&page%5Bafter%5D=abc123"
)

// ---------------------------------------------------------------------------
// getAuthorizationHeader — requires env vars
// ---------------------------------------------------------------------------

console.log("getAuthorizationHeader:")

const origToken = process.env.ZENDESK_API_TOKEN
const origEmail = process.env.ZENDESK_API_USER_EMAIL
const origBasic = process.env.ZENDESK_BASIC_AUTH_TOKEN

// Clean up env for isolated tests
delete process.env.ZENDESK_API_TOKEN
delete process.env.ZENDESK_API_USER_EMAIL
delete process.env.ZENDESK_BASIC_AUTH_TOKEN

let threw = false
try {
  getAuthorizationHeader()
} catch {
  threw = true
}
ok("throws when no credentials configured", threw)

process.env.ZENDESK_API_TOKEN = "test-token"
process.env.ZENDESK_API_USER_EMAIL = "agent@example.com"

const header = getAuthorizationHeader()
ok("returns Basic auth header", header.startsWith("Basic "))
ok(
  "encodes email/token:apitoken",
  Buffer.from(header.replace("Basic ", ""), "base64").toString() ===
    "agent@example.com/token:test-token"
)

// Restore env
if (origToken) process.env.ZENDESK_API_TOKEN = origToken
else delete process.env.ZENDESK_API_TOKEN
if (origEmail) process.env.ZENDESK_API_USER_EMAIL = origEmail
else delete process.env.ZENDESK_API_USER_EMAIL
if (origBasic) process.env.ZENDESK_BASIC_AUTH_TOKEN = origBasic
else delete process.env.ZENDESK_BASIC_AUTH_TOKEN

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
